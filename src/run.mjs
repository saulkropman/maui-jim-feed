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
const DELAY_MS = Number(process.env.DELAY_MS || (VIA_SERVICE ? 1500 : 6000));
const MIN_OK_SHARE = 0.8; // below this, keep the old feed and fail the run

const FEED = path.join(DATA, 'maui-jim-us-products.csv');
const now = new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

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
// Litescrape returns JSON; we ask only for <script> tags, which hold all the product data.
async function litescrape(url, kind) {
  const body = kind === 'page'
    ? { url, respond_with: 'html', engine: 'curl', target_selector: ['script'], assert_status_code: 200, locale: 'en-US' }
    : { url, respond_with: 'html', engine: 'curl', assert_status_code: 200, locale: 'en-US' };
  const res = await fetch(LITESCRAPE_BASE + '/api/web/fetch?timeout=80', {
    method: 'POST', signal: AbortSignal.timeout(95000),
    headers: { authorization: 'Bearer ' + LITESCRAPE_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) {
    if (/status|404/i.test(raw) && /404/.test(raw)) return { status: 404, text: '' };
    throw new Error(`Litescrape HTTP ${res.status} for ${url}: ${raw.slice(0, 300).replace(/\s+/g, ' ')}`);
  }
  let j; try { j = JSON.parse(raw); } catch { return { status: 200, text: raw }; }
  return { status: 200, text: j.html ?? j.content ?? j.text ?? raw };
}

async function get(url, tries = 3, kind = 'page') {
  if (LITESCRAPE_KEY) {
    let last;
    for (let t = 1; t <= tries; t++) {
      try { return await litescrape(url, kind); }
      catch (e) { last = e; console.error(`try ${t} ${url}: ${e.message} ${e.cause || ''}`); await sleep(5000 * t * t); }
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
    } catch (e) { last = e; console.error(`try ${t} ${url}: ${e.message} ${e.cause || ""}`); await sleep(5000 * t * t); }
  }
  throw last;
}

async function productUrls() {
  const { text } = await get(BASE + '/sitemap/en-us.xml', 3, 'sitemap');
  // Match URLs anywhere in the response, so it works whether the XML comes back raw or reformatted.
  const urls = [...text.matchAll(/https:\/\/www\.mauijim\.com\/shop\/[^\s<>"'&]+/g)].map(m => m[0].replace(/\/$/, ''));
  if (urls.length < 50) throw new Error(`Sitemap looks wrong: only ${urls.length} product URLs`);
  return [...new Set(urls)];
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
  const prevRows = fs.existsSync(FEED) ? parseCSV(fs.readFileSync(FEED, 'utf8')) : [];
  const prev = new Map(prevRows.map(r => [r.sku, r]));
  const prevByProduct = new Map();
  for (const r of prevRows) { if (!prevByProduct.has(r.product_url)) prevByProduct.set(r.product_url, []); prevByProduct.get(r.product_url).push(r); }
  log(`previous feed: ${prevRows.length} SKUs`);

  let urls = await productUrls();
  if (LIMIT) urls = urls.slice(0, LIMIT);
  log(`sitemap: ${urls.length} products`);

  const fresh = [], failed = [];
  let streak = 0;
  for (const [i, url] of urls.entries()) {
    try {
      const { status, text } = await get(url);
      if (status === 404) { failed.push({ url, error: 'HTTP 404' }); continue; }
      const { rows, ok, reason } = parseProduct(text, url);
      if (!ok) throw new Error(reason);
      if (rows.some(r => r.currency && r.currency !== 'USD')) throw new Error('not USD prices: ' + rows[0].currency);
      fresh.push(...rows.map(r => ({ ...r, last_checked_utc: now })));
      streak = 0;
    } catch (e) {
      failed.push({ url, error: String(e.message || e) });
      log(`FAIL ${url}: ${e.message || e}`);
      if (++streak >= 5) { log('5 failures in a row: likely blocked, pausing 10 minutes'); await sleep(600000); streak = 0; }
    }
    if ((i + 1) % 20 === 0) log(`${i + 1}/${urls.length} done, ${fresh.length} SKUs`);
    await sleep(DELAY_MS * (1 + Math.random() * 0.3));
  }

  const okProducts = urls.length - failed.length;
  const report = { run_utc: now, fetch_mode: FETCH_MODE, products_in_sitemap: urls.length, products_ok: okProducts, products_failed: failed.length, failed };
  if (!LIMIT && okProducts < urls.length * MIN_OK_SHARE) {
    report.result = 'aborted: too many failures, previous feed kept';
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
      if (IGNORE.has(f) || (p[f] ?? '') === (r[f] ?? '')) continue;
      changes.push({ change_type: typeOf(f), sku: r.sku, product_name: r.product_name, field: f, old_value: p[f] ?? '', new_value: r[f] ?? '' });
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
    result: 'ok', skus: next.length, skus_changed: changedSkus.size,
    changes: { price: count('price'), stock: count('stock'), content: count('content'), reviews: count('reviews'), new_sku: count('new_sku'), removed_sku: count('removed_sku') },
  });
  fs.writeFileSync(path.join(DATA, 'run-report.json'), JSON.stringify(report, null, 2));
  log(JSON.stringify({ ...report, failed: failed.length }));
}

main().catch(e => {
  console.error(e);
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, 'run-report.json'), JSON.stringify({ run_utc: now, fetch_mode: FETCH_MODE, result: 'error', error: String(e?.stack || e), cause: String(e?.cause || '') }, null, 2));
  } catch {}
  process.exit(1);
});
