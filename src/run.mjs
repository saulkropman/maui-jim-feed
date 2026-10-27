// Twice-daily Maui Jim US feed refresh.
// Fetches every product in the US sitemap, builds one row per SKU, compares with the
// last saved feed and writes:
//   data/maui-jim-us-products.csv   full feed (one row per SKU)
//   data/latest-changed-rows.csv    full rows for SKUs that are new or changed this run
//   data/latest-changes.csv         field-level changes this run (old -> new)
//   data/change-log.csv             every change ever, appended
//   data/run-report.json            counts, failures, timing
import fs from 'node:fs';
import path from 'node:path';
import { parseProduct, COLUMNS, BASE } from './parse.mjs';

const DATA = path.resolve(process.env.DATA_DIR || 'data');
const LIMIT = Number(process.env.LIMIT || 0);
// Optional: route requests through a scraping service if the site blocks the runner.
// Example: https://api.scraperapi.com/?api_key=KEY&country_code=us&url={url}
const TEMPLATE = process.env.SCRAPER_URL_TEMPLATE || '';
// Litescrape (https://litescrape.com): set LITESCRAPE_API_KEY to route every page through it.
const LITESCRAPE_KEY = process.env.LITESCRAPE_API_KEY || '';
const LITESCRAPE_BASE = (process.env.LITESCRAPE_API_URL || 'https://api.litescrape.com').replace(/\/$/, '');
const VIA_SERVICE = !!(TEMPLATE || LITESCRAPE_KEY);
// Direct requests must be slow to avoid bot blocking; a scraping service rotates IPs so can go faster.
const FETCH_MODE = LITESCRAPE_KEY ? 'litescrape' : TEMPLATE ? 'url-template' : 'direct (no scraping-service secret found)';
const CONCURRENCY = Number(process.env.CONCURRENCY || (LITESCRAPE_KEY ? 3 : 1));
const DELAY_MS = Number(process.env.DELAY_MS || (VIA_SERVICE ? 1500 : 6000));
const MIN_OK_SHARE = 0.8; // below this, keep the old feed and fail the run

const FEED = path.join(DATA, 'maui-jim-us-products.csv');
const now = new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOG = [];
const log = (...a) => { const line = [new Date().toISOString().slice(11, 19), ...a].join(' '); LOG.push(line); if (LOG.length > 60) LOG.shift(); console.log(line); };

// ---------- CSV ----------
const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
const toCSV = (cols, rows) => '﻿' + [cols.map(q).join(','), ...rows.map(r => cols.map(c => q(r[c])).join(','))].join('\r\n') + '\r\n';
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const out = []; let row = [], f = '', inq = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inq) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else inq = false; } else f += c; }
    else if (c === '"') inq = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); out.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); out.push(row); }
  const [head, ...body] = out;
  return body.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

// ---------- fetching ----------
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};
// Litescrape picks a server anywhere in the world, and Maui Jim serves the store for that
// country. So every response is checked and retried until it is the US store.
const isUSPage = html => {
  const m = html.match(/"@type"\s*:\s*"Product"[\s\S]{0,400}?"url"\s*:\s*"([^"]+)"/);
  return !m || !/mauijim\.com\/[a-z]{2}-[a-z]+\//i.test(m[1]);
};
const isUSApi = text => { try { const j = JSON.parse(text); return (j.products || []).every(p => !p.prices || p.prices.currency === 'USD'); } catch { return false; } };

let LS_CALLS = 0, LS_NOT_US = 0;
async function litescrapeOnce(url, kind) {
  LS_CALLS++;
  const body = kind === 'page'
    ? { url, respond_with: 'html', engine: 'curl', target_selector: ['script'], assert_status_code: 200, timeout: 90 }
    : { url, respond_with: 'text', engine: 'curl', assert_status_code: 200, timeout: 90 };
  const t0 = Date.now();
  const res = await fetch(LITESCRAPE_BASE + '/api/web/fetch', {
    method: 'POST', signal: AbortSignal.timeout(130000),
    headers: { authorization: 'Bearer ' + LITESCRAPE_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  log(`litescrape ${res.status} ${((Date.now() - t0) / 1000).toFixed(1)}s ${raw.length}B ${url}`);
  if (!res.ok) {
    if (/\b404\b/.test(raw)) return { status: 404, text: '' };
    throw new Error(`Litescrape HTTP ${res.status} for ${url}: ${raw.slice(0, 300).replace(/\s+/g, ' ')}`);
  }
  let j; try { j = JSON.parse(raw); } catch { return { status: 200, text: raw }; }
  return { status: 200, text: j.html ?? j.text ?? j.content ?? '' };
}

async function litescrape(url, kind) {
  const isUS = kind === 'page' ? isUSPage : isUSApi;
  for (let a = 1; a <= 8; a++) {
    const r = await litescrapeOnce(url, kind);
    if (r.status === 404 || isUS(r.text)) return r;
    LS_NOT_US++; log(`not the US store (try ${a}), retrying ${url}`);
  }
  throw new Error('could not get the US store after 8 tries');
}

async function get(url, tries = 3, kind = 'page') {
  if (LITESCRAPE_KEY) {
    let last;
    for (let t = 1; t <= tries; t++) {
      try { return await litescrape(url, kind); }
      catch (e) { last = e; log(`try ${t} ${url}: ${e.message} ${e.cause || ''}`); await sleep(5000 * t); }
    }
    throw last;
  }
  const target = TEMPLATE ? TEMPLATE.replace('{url}', encodeURIComponent(url)) : url;
  let last;
  for (let t = 1; t <= tries; t++) {
    try {
      const res = await fetch(target, { headers: TEMPLATE ? {} : HEADERS, signal: AbortSignal.timeout(90000) });
      if (res.status === 404) return { status: 404, text: '' };
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}: ${(await res.text()).slice(0, 300).replace(/\s+/g, ' ')}`);
      return { status: res.status, text: await res.text() };
    } catch (e) { last = e; log(`try ${t} ${url}: ${e.message} ${e.cause || ""}`); await sleep(5000 * t * t); }
  }
  throw last;
}

// ---------- product list ----------
// Litescrape can't load the XML sitemap, so the product list is:
//   1. data/product-urls.txt (known products, kept up to date by each run)
//   2. plus new products found in the site's product API (names convert to page addresses)
//   3. plus the sitemap, when it can be loaded (direct or URL-template mode)
const URLS_FILE = path.join(DATA, 'product-urls.txt');
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const LISTINGS = (process.env.LISTING_CATEGORIES || 'sunglasses-product-grouping').split(',').map(s => s.trim()).filter(Boolean);

async function productUrls(prevRows) {
  const known = new Set(fs.existsSync(URLS_FILE) ? fs.readFileSync(URLS_FILE, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean) : []);
  for (const r of prevRows) if (r.product_url) known.add(r.product_url);
  const found = new Set(), sources = {};
  for (const cat of LISTINGS) {
    try {
      for (let page = 0, pages = 1; page < pages && page < 20; page++) {
        const { text } = await get(`${BASE}/api/products/by-category?categoryName=${cat}&locale=en-us&currentPage=${page}&pageSize=100`, 3, 'api');
        const j = JSON.parse(text);
        pages = j.pagination?.totalPages || 1;
        for (const p of j.products || []) if (p.name && p.frameStyleCode) found.add(`${BASE}/shop/${p.frameStyleCode.replace('_', '/')}/${slug(p.name)}`);
      }
      sources[cat] = 'ok';
    } catch (e) { sources[cat] = 'failed: ' + e.message; log(`listing ${cat} failed: ${e.message}`); }
  }
  if (!LITESCRAPE_KEY) {
    try {
      const { text } = await get(BASE + '/sitemap/en-us.xml', 3, 'sitemap');
      for (const m of text.matchAll(/https:\/\/www\.mauijim\.com\/shop\/[^\s<>"'&]+/g)) found.add(m[0].replace(/\/$/, ''));
      sources.sitemap = 'ok';
    } catch (e) { sources.sitemap = 'failed: ' + e.message; }
  }
  const added = [...found].filter(u => !known.has(u));
  const urls = [...new Set([...known, ...found])].sort();
  if (urls.length < 50) throw new Error(`Product list looks wrong: only ${urls.length} product URLs (${JSON.stringify(sources)})`);
  return { urls, added, sources };
}

// ---------- diff ----------
const PRICE = ['price', 'was_price', 'currency'];
const STOCK = ['in_stock', 'stock_message'];
const REVIEWS = ['rating', 'review_count'];
const IGNORE = new Set(['ai_summary', 'last_changed_utc', 'last_checked_utc']);
const typeOf = f => PRICE.includes(f) ? 'price' : STOCK.includes(f) ? 'stock' : REVIEWS.includes(f) ? 'reviews' : 'content';

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  log('fetch mode: ' + FETCH_MODE);
  if (LITESCRAPE_KEY) { // free call: confirms the key and API address before any paid fetches
    const r = await fetch(LITESCRAPE_BASE + '/api/keys/status', { headers: { authorization: 'Bearer ' + LITESCRAPE_KEY, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    const body = (await r.text()).slice(0, 300);
    log(`litescrape key status ${r.status}: ${body}`);
    if (!r.ok) throw new Error(`Litescrape key check failed: HTTP ${r.status} ${body}`);
  }
  const prevRows = fs.existsSync(FEED) ? parseCSV(fs.readFileSync(FEED, 'utf8')) : [];
  const prev = new Map(prevRows.map(r => [r.sku, r]));
  const prevByProduct = new Map();
  for (const r of prevRows) { if (!prevByProduct.has(r.product_url)) prevByProduct.set(r.product_url, []); prevByProduct.get(r.product_url).push(r); }
  log(`previous feed: ${prevRows.length} SKUs`);

  const { urls: allUrls, added, sources } = await productUrls(prevRows);
  let urls = allUrls;
  if (LIMIT) urls = [...added, ...allUrls.filter(u => !added.includes(u))].slice(0, LIMIT);
  log(`products: ${urls.length} to fetch (${added.length} new from listing) ${JSON.stringify(sources)}`);

  const fresh = [], failed = [], gone = [];
  let streak = 0, cursor = 0, done = 0;
  const worker = async () => {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      try {
        const { status, text } = await get(url);
        if (status === 404) { gone.push(url); log(`GONE ${url}`); }
        else {
          const { rows, ok, reason } = parseProduct(text, url);
          if (!ok) throw new Error(reason);
          if (rows.some(r => r.currency && r.currency !== 'USD')) throw new Error('not USD prices: ' + rows[0].currency);
          fresh.push(...rows.map(r => ({ ...r, last_checked_utc: now })));
          streak = 0;
        }
      } catch (e) {
        failed.push({ url, error: String(e.message || e) });
        log(`FAIL ${url}: ${e.message || e}`);
        if (!VIA_SERVICE && ++streak >= 5) { log('5 failures in a row: likely blocked, pausing 10 minutes'); await sleep(600000); streak = 0; }
      }
      if (++done % 20 === 0) log(`${done}/${urls.length} done, ${fresh.length} SKUs`);
      await sleep(DELAY_MS * (1 + Math.random() * 0.3));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  // Second pass: give failed pages one more go after a short break.
  if (failed.length && failed.length <= urls.length * 0.2) {
    const retry = failed.splice(0).map(f => f.url);
    log(`second pass for ${retry.length} failed pages`);
    await sleep(Number(process.env.SECOND_PASS_WAIT_MS ?? 30000));
    urls.push(...retry); // the workers read from urls[cursor]
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, retry.length) }, worker));
    urls.splice(urls.length - retry.length);
  }
  if (!LIMIT) fs.writeFileSync(URLS_FILE, allUrls.filter(u => !gone.includes(u)).join('\n') + '\n');

  const okProducts = urls.length - failed.length - gone.length;
  const report = { run_utc: now, fetch_mode: FETCH_MODE, product_sources: sources, products_new_from_listing: added, products_gone: gone, products_checked: urls.length, products_ok: okProducts, products_failed: failed.length, failed };
  if (!LIMIT && okProducts < (urls.length - gone.length) * MIN_OK_SHARE) {
    report.result = 'aborted: too many failures, previous feed kept'; report.log = LOG; report.litescrape_calls = LS_CALLS;
    fs.writeFileSync(path.join(DATA, 'run-report.json'), JSON.stringify(report, null, 2));
    console.error(report.result); process.exit(1);
  }

  // Products that failed this run keep their previous rows (marked by older last_checked_utc).
  const failedUrls = new Set(failed.map(f => f.url));
  const carried = [...failedUrls].flatMap(u => prevByProduct.get(u) || []);
  const live = new Set(urls);
  const next = [...fresh, ...carried];

  // Field-level changes
  const changes = [], changedSkus = new Set();
  for (const r of next) {
    const p = prev.get(r.sku);
    if (!p) { if (prevRows.length) { changes.push({ change_type: 'new_sku', sku: r.sku, product_name: r.product_name, field: '', old_value: '', new_value: r.price }); changedSkus.add(r.sku); } r.last_changed_utc = now; continue; }
    let diff = false;
    for (const f of COLUMNS) {
      if (IGNORE.has(f) || String(p[f] ?? '') === String(r[f] ?? '')) continue;
      changes.push({ change_type: typeOf(f), sku: r.sku, product_name: r.product_name, field: f, old_value: String(p[f] ?? ''), new_value: String(r[f] ?? '') });
      diff = true;
    }
    r.last_changed_utc = diff ? now : (p.last_changed_utc || now);
    if (diff) changedSkus.add(r.sku);
  }
  const nextSkus = new Set(next.map(r => r.sku));
  for (const p of prevRows) {
    if (nextSkus.has(p.sku)) continue;
    if (LIMIT && !live.has(p.product_url)) { next.push(p); continue; } // partial test run: don't drop unseen products
    changes.push({ change_type: 'removed_sku', sku: p.sku, product_name: p.product_name, field: '', old_value: p.price, new_value: '' });
  }
  for (const c of changes) c.run_utc = now;

  const cols = [...COLUMNS, 'last_checked_utc', 'last_changed_utc'];
  next.sort((a, b) => a.product_url.localeCompare(b.product_url) || a.sku.localeCompare(b.sku));
  const changeCols = ['run_utc', 'change_type', 'sku', 'product_name', 'field', 'old_value', 'new_value'];
  fs.writeFileSync(FEED, toCSV(cols, next));
  fs.writeFileSync(path.join(DATA, 'latest-changed-rows.csv'), toCSV(cols, next.filter(r => changedSkus.has(r.sku))));
  fs.writeFileSync(path.join(DATA, 'latest-changes.csv'), toCSV(changeCols, changes));
  const logFile = path.join(DATA, 'change-log.csv');
  if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, toCSV(changeCols, []));
  if (changes.length) fs.appendFileSync(logFile, changes.map(c => changeCols.map(k => q(c[k])).join(',')).join('\r\n') + '\r\n');

  const count = t => changes.filter(c => c.change_type === t).length;
  Object.assign(report, {
    result: 'ok', litescrape_calls: LS_CALLS, litescrape_not_us_retries: LS_NOT_US, skus: next.length, skus_changed: changedSkus.size,
    changes: { price: count('price'), stock: count('stock'), content: count('content'), reviews: count('reviews'), new_sku: count('new_sku'), removed_sku: count('removed_sku') },
  });
  fs.writeFileSync(path.join(DATA, 'run-report.json'), JSON.stringify(report, null, 2));
  log(JSON.stringify({ ...report, failed: failed.length, products_new_from_listing: added.length }));
}

main().catch(e => {
  console.error(e);
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, 'run-report.json'), JSON.stringify({ run_utc: now, fetch_mode: FETCH_MODE, result: 'error', error: String(e?.stack || e), cause: String(e?.cause || ''), log: LOG }, null, 2));
  } catch {}
  process.exit(1);
});
