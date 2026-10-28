// Pure parser: product page HTML -> one row per SKU.
// No DOM needed, so it runs in Node and in a browser.

const BASE = 'https://www.mauijim.com';

const scripts = html => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .map(m => ({ attrs: m[1], body: m[2] }));

const decodeEntities = s => s
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

export const clean = v => (v === undefined || v === null || v === '$undefined') ? '' : String(v).replace(/^\$\$/, '$');

const htmlToText = h => {
  if (!h || h === '$undefined') return '';
  return decodeEntities(String(h).replace(/<\/(p|li|h\d|div)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
};

// Next.js flight payload: rows "id:JSON\n" or "id:T<hexlen>,<text>".
function flightRows(html) {
  let flight = '';
  for (const s of scripts(html)) {
    const m = s.body.match(/^\s*self\.__next_f\.push\((\[[\s\S]*\])\)\s*;?\s*$/);
    if (!m) continue;
    try { const a = JSON.parse(m[1]); if (typeof a[1] === 'string') flight += a[1]; } catch {}
  }
  const b = new TextEncoder().encode(flight), dec = new TextDecoder();
  const rows = []; let p = 0;
  while (p < b.length) {
    let c = p; while (c < b.length && b[c] !== 58 && b[c] !== 10) c++;
    if (b[c] !== 58) { p = c + 1; continue; }
    p = c + 1;
    if (b[p] === 84) { // 'T' text row with byte length
      let e = p + 1; while (e < b.length && b[e] !== 44) e++;
      const len = parseInt(dec.decode(b.slice(p + 1, e)), 16);
      p = e + 1 + (Number.isFinite(len) ? len : 0);
    } else {
      let e = p; while (e < b.length && b[e] !== 10) e++;
      try { rows.push(JSON.parse(dec.decode(b.slice(p, e)))); } catch {}
      p = e + 1;
    }
  }
  return rows;
}

function findProps(rows) {
  let found = null;
  const walk = (o, d) => {
    if (found || !o || typeof o !== 'object' || d > 80) return;
    if (!Array.isArray(o) && ('frameColorSwatches' in o || ('accordionItems' in o && 'mediaItems' in o))) { found = o; return; }
    for (const k in o) walk(o[k], d + 1);
  };
  for (const r of rows) walk(r, 0);
  return found;
}

function jsonLdProduct(html) {
  for (const s of scripts(html)) {
    if (!/application\/ld\+json/i.test(s.attrs)) continue;
    try {
      const v = JSON.parse(s.body);
      for (const x of [v, ...(v['@graph'] || [])].flat()) if (/Product/.test([x['@type']].flat().join())) return x;
    } catch {}
  }
  return {};
}

const facts = acc => {
  const f = {};
  for (const a of acc || []) for (const g of a.factGroups || []) for (const it of g.items || []) {
    const i = it.indexOf(':'); if (i > 0) f[it.slice(0, i).trim()] = it.slice(i + 1).trim();
  }
  return f;
};
const arr = v => Array.isArray(v) ? v : [];
const money = v => clean(v).replace(/\.00$/, '');

// Returns { rows, ok, reason }
export function parseProduct(html, productUrl) {
  const o = findProps(flightRows(html));
  const ld = jsonLdProduct(html);
  if (!o && !ld.name) return { rows: [], ok: false, reason: 'no product data found' };
  const path = new URL(productUrl).pathname.split('/').filter(Boolean);
  const offer = [ld.offers].flat()[0] || {};
  const base = {
    product_name: o?.title || ld.name || '',
    category: path[1] || '',
    sub_category: o?.productCategory || path[2] || '',
    product_url: productUrl,
    rating: o?.rating?.averageRating ?? ld.aggregateRating?.ratingValue ?? '',
    review_count: o?.rating?.reviewCount ?? ld.aggregateRating?.reviewCount ?? '',
    badges: arr(o?.badges).map(b => b.label || b.text || b.displayName || b).join(' | '),
    fitting_guide_url: clean(o?.fittingGuideHref),
    currency: o?.priceCurrency || offer.priceCurrency || '',
  };
  const swatches = arr(o?.frameColorSwatches);
  const allColours = swatches.map(s => s.label).join(' | ');
  const fv = o?.frameColorVariants;
  const variants = fv && typeof fv === 'object' && Object.keys(fv).length ? Object.entries(fv) : [[o?.defaultFrameColorId || '', o || {}]];
  const out = [];
  for (const [cid, v] of variants) {
    const acc = Array.isArray(v.accordionItems) ? v.accordionItems : arr(o?.accordionItems);
    const f = facts(acc);
    const sw = swatches.find(s => s.id === cid) || {};
    const info = acc.find(a => a.id === 'additional-information') || {};
    const size = acc.find(a => a.id === 'size-and-fit') || {};
    const meas = {};
    for (const dg of size.diagrams || []) for (const ov of dg.overlays || []) if (!(ov.label in meas)) meas[ov.label] = ov.value;
    let media = arr(o?.frameColorMedia?.[cid]); if (!media.length) media = arr(v.mediaItems); if (!media.length) media = arr(o?.mediaItems);
    let images = media.map(m => m.src).filter(Boolean);
    if (!images.length) images = [...new Set([ld.image].flat().filter(Boolean).map(i => typeof i === 'string' ? i : i.url || i.contentUrl))];
    const alts = media.map(m => m.alt || '');
    const code = clean(v.productCode || o?.productCode) || clean(ld.sku);
    const [sku, mpn = ''] = (f['SKU'] || code).split('/');
    const vurl = new URL(productUrl); if (cid) vurl.searchParams.set('frameColor', cid); if (code) vurl.searchParams.set('variantCode', code);
    const inStock = v.inStock ?? o?.inStock;
    const stockYes = inStock === undefined || inStock === '$undefined' ? (offer.availability ? /InStock/.test(offer.availability) : '') : !!inStock;
    let price = money(v.priceValue ?? o?.priceValue); if (!price && offer.price != null) price = String(offer.price);
    const row = {
      ...base,
      sku: sku.trim(), manufacturer_product_number: (mpn || ld.mpn || '').trim(), variant_code: code, reader_power: '',
      frame_colour: sw.label || f['Frame Color'] || ld.color || '', frame_colour_id: cid,
      lens_colour: clean(v.lensColorValue) || f['Lens Color'] || '', lens_material: clean(v.lensMaterialValue) || f['Lens Material'] || '',
      lens_treatment: f['Lens Treatment'] || '', frame_material: f['Frame Material'] || '', frame_style: f['Frame Style'] || '', gender: f['Gender'] || '',
      price, was_price: money(v.previousPriceValue), in_stock: stockYes === '' ? '' : (stockYes ? 'yes' : 'no'), stock_message: clean(o?.stockMessage),
      size: (size.description || '').split('\n')[0].replace(/^Size:\s*/, ''), temple_mm: meas.Temple || '', eye_mm: meas.Eye || '', bridge_mm: meas.Bridge || '',
      lens_height_mm: meas.Height || '', base_curve: meas.Base || '',
      description: htmlToText(info.richDescription) || ld.description || '',
      all_frame_colours: allColours, main_image_url: images[0] || '', image_urls: JSON.stringify(images), image_alt_texts: alts.join(' | '),
      swatch_image_url: sw.image || '', variant_url: vurl.href,
    };
    // Reader (magnification) versions are separate SKUs with their own price/stock.
    let mags = v.magnificationOptions || o?.magnificationOptions; mags = Array.isArray(mags) ? mags : [];
    const mp = v.magnificationPrices || {}, ms = v.magnificationSkus || {}, mst = v.magnificationStock || {};
    const readers = mags.filter(m => m !== 'none' && ms[m]);
    const ownIdx = readers.findIndex(m => String(ms[m]).split('/')[0] === row.sku);
    if (ownIdx >= 0) { // readers-only product: main SKU is itself a reader power
      const m = readers[ownIdx]; row.reader_power = m; const u = new URL(row.variant_url); u.searchParams.set('magnification', m); row.variant_url = u.href;
    }
    out.push(row);
    readers.forEach((m, i) => {
      if (i === ownIdx) return;
      const [rs, rmpn = ''] = String(ms[m]).split('/');
      const u = new URL(row.variant_url); u.searchParams.set('magnification', m);
      out.push({ ...row, sku: rs.trim(), manufacturer_product_number: rmpn.trim(), variant_code: rs.trim(), reader_power: m,
        price: money(mp[m]?.priceValue) || row.price, was_price: money(mp[m]?.previousPriceValue),
        in_stock: mst[m] === false ? 'no' : row.in_stock, variant_url: u.href });
    });
  }
  // A product can list the same SKU twice; keep the first.
  const seen = new Set();
  const rows = out.filter(r => !seen.has(r.sku) && seen.add(r.sku));
  for (const r of rows) {
    // variant_code is always the variantCode in the variant link (reader rows share their colour's code).
    r.variant_code = new URL(r.variant_url).searchParams.get('variantCode') || r.variant_code;
    r.ai_summary = summary(r);
  }
  return { rows, ok: rows.length > 0, reason: rows.length ? '' : 'no variants' };
}

function summary(r) {
  const kind = r.category === 'sunglasses' ? `${r.sub_category} sunglasses`.trim() : r.category === 'apparel' ? 'apparel' : 'accessory';
  const b = [`${r.product_name} (${kind})`];
  if (r.frame_colour) b.push(`${r.frame_colour} frame` + (r.lens_colour ? ` with ${r.lens_colour} ${r.lens_material} ${r.lens_treatment ? r.lens_treatment.toLowerCase() + ' ' : ''}lenses` : ''));
  if (r.reader_power) b.push(`Reader version with +${r.reader_power} magnification`);
  if (r.price) b.push(`Price $${r.price} ${r.currency}` + (r.was_price && r.was_price !== r.price ? ` (was $${r.was_price})` : ''));
  if (r.in_stock) b.push(r.in_stock === 'yes' ? 'In stock' : 'Out of stock');
  if (r.size) b.push(`Size ${r.size}` + (r.temple_mm ? `, temple ${r.temple_mm}mm, lens width ${r.eye_mm}mm, bridge ${r.bridge_mm}mm, lens height ${r.lens_height_mm}mm` : ''));
  if (r.gender) b.push(r.gender);
  if (r.rating) b.push(`Rated ${r.rating}/5 from ${r.review_count} reviews`);
  return b.join('. ').replace(/\s+/g, ' ') + '.';
}

export const COLUMNS = ['product_name', 'variant_code', 'category', 'sub_category', 'sku', 'manufacturer_product_number', 'reader_power',
  'frame_colour', 'lens_colour', 'lens_material', 'lens_treatment', 'price', 'was_price', 'in_stock', 'stock_message',
  'gender', 'frame_material', 'frame_style', 'size', 'temple_mm', 'eye_mm', 'bridge_mm', 'lens_height_mm', 'base_curve',
  'rating', 'review_count', 'badges', 'description', 'ai_summary', 'all_frame_colours', 'main_image_url', 'image_urls',
  'frame_colour_id', 'product_url', 'variant_url'];

export { BASE };
