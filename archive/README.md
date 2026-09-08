# Archive — superseded scripts

Kept for reference on approach only. **These will not run against the current
`sync-config.js`**: they import exports that were removed when the config was
trimmed (`FIELD_MAP`, `UPDATABLE_COLUMNS`, `PREFIX_TO_HANDLE`, …).

| Script | Superseded by | Why |
|---|---|---|
| `sync-catalog.js` | `sync-matrixify.js` | Targeted Shopify's native CSV import, which **cannot set variant metafields** — where dimensions, lead time, MPN and hazmat live. |
| `generate-import.js` | `sync-catalog.js`, then `sync-matrixify.js` | First-pass diff; no safety rails. |
| `gen-titles.mjs` | `gen-content.mjs` | Drafted titles only; the replacement also does handles and descriptions. |
| `consolidate-products.js` | `migration/` | Built the colour-as-variant model that the 2026-08 migration dismantled. |
| `transform-catalog.js`, `update-catalog.js`, `merge-descriptions.js` | — | Pre-Matrixify one-offs from the original WooCommerce→Shopify move. |

The native-CSV path in `sync-catalog.js` is worth reading if that transport is
ever revisited: it handles complete-product-block emission and contiguity, which
Matrixify's `Command: MERGE` makes unnecessary.
