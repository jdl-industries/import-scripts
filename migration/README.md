# Migration — one-time catalog restructure (2026-08/09)

**Complete.** Kept for reference; do not re-run.

Moved the catalog from *colour-as-variant* (a few large products, each colour a
variant) to *colour-as-product, size-as-variant* — chosen to preserve per-colour
SEO ranking and keep model numbers in URLs.

| Script | Steps | What it did |
|---|---|---|
| `migrate-catalog.js` | 01–03 | Backfilled colours onto standalone products **before** anything was retired; converted 73 legacy `Title/Default Title` products to a `Size` option; split orphan variants into add-variant / fill-blank-SKU / genuinely-new. |
| `migrate-fixups.mjs` | 03e–03f | Filled three blank Variant SKUs (keyed on Variant ID, the only reliable key when the SKU is blank) and renamed legacy size values into the current enumeration. |
| `migrate-families.mjs` | 04–05 | Created family collections and `product_family` metaobjects, linked 62 products, archived the 5 consolidated products, and emitted 301 redirects from each retired product URL to its replacement collection. |

The generated CSVs from each step are kept alongside the scripts as a record of
exactly what was imported.

## Worth knowing if a similar migration comes up

* **Order mattered.** Step 01 had to run first: 31 products would otherwise have
  been stranded with no colour, because the consolidated product was the only
  place their colour existed.
* **Most "new products" weren't.** Of 10 orphan variants, 6 were additional
  *sizes* of colours that already had a product and 1 was an existing product
  with a blank SKU. Only 3 were genuinely new.
* **A stale export nearly caused data loss.** `custom.size` is a list replaced
  wholesale; building it from an export that predated an earlier step would have
  dropped sizes. The fix resolves existing variants the same way the earlier
  step did, so it is export-independent.
