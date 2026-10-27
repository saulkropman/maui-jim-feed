# Maui Jim US product feed

Runs on GitHub Actions at 6:17am and 6:17pm Brisbane time. Each run fetches every
product in the US sitemap (www.mauijim.com/sitemap/en-us.xml), builds one row per SKU,
and compares it with the last run.

## Files (in `data/`)

| File | What it is |
|---|---|
| `maui-jim-us-products.csv` | Full feed. One row per SKU, including reader (magnification) SKUs. |
| `latest-changed-rows.csv` | Full rows for SKUs that are new or changed in the latest run. Use this for incremental updates. |
| `latest-changes.csv` | What changed in the latest run: SKU, field, old value, new value. |
| `change-log.csv` | Every change ever recorded. |
| `run-report.json` | Counts and any failed pages for the latest run. |

`change_type` is one of `price`, `stock`, `content` (description, images, names, sizes),
`reviews`, `new_sku`, `removed_sku`. Each feed row has `last_checked_utc` and
`last_changed_utc`.

## Safety

- If more than 20% of pages fail (for example the site blocks the run), the old feed is
  kept and the run is marked as failed.
- A product whose page fails keeps its previous rows. It is only marked removed when it
  leaves the sitemap.
- Pages are fetched one at a time: about 1.5 seconds apart through a scraping service,
  or 6 seconds apart for direct requests (direct only works from a home connection).

## Setup: scraping service (required)

Maui Jim's bot protection blocks GitHub's servers (tested 28 Oct 2026: connection timed
out). Pages must go through a scraping service with US IPs. Add a repo secret
(Settings > Secrets and variables > Actions > New repository secret) named
`SCRAPER_URL_TEMPLATE`. `{url}` is replaced with each page address. Examples:

- ScraperAPI: `https://api.scraperapi.com/?api_key=YOUR_KEY&country_code=us&url={url}`
- ScrapingBee: `https://app.scrapingbee.com/api/v1/?api_key=YOUR_KEY&render_js=false&country_code=us&url={url}`

The service must return the raw page HTML (no JavaScript rendering needed).
About 180 pages per run, twice a day: roughly 11,000 requests a month.

## Run by hand

Actions tab > Refresh Maui Jim US feed > Run workflow. Set `limit` to e.g. 5 for a quick test.

Locally: `npm run refresh` (Node 20+). `npm test` checks the change tracking against a fake site.
