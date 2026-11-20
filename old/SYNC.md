# JDL Shopify - AccountMate Sync

Keeps the Shopify catalog in step with JDL's AccountMate ERP. AccountMate
is the source of truth for pricing, stock, dimensions and specifications;
Shopify owns titles, copy, images, SEO and anything merchandising-related.

```bash
# 1. create any Product Specification metaobjects the catalog references
node gen-specifications.mjs "AccountMate Export.csv" Product_Specifications.csv

# 2. produce the import files
node sync-matrixify.js "AccountMate Export.csv" "AccountMate Export (previous run).csv" Products.csv
```

| Option           | Effect                                |
| ---------------- | ------------------------------------- |
| `--outdir <dir>` | Output directory (default `./output`) |
| `--date <date>`  | Override the `{date}` stamp           |
| `--dry-run`      | Report only, write nothing            |
| `--verbose`      | Per-SKU change detail                 |

Three positional arguments:

1. **Current AccountMate export.**
2. **Previous AccountMate export** -- whatever export was used last time. Only
   drives `review-updates` (did the AccountMate text behind a judgment-call
   field change?); nothing else depends on it. The repo already keeps a long
   history of dated exports -- pick a recent one, there is no setup beyond
   that.
3. **Shopify identity export** -- a _lightweight_ Matrixify export: `Variant
SKU`, `Handle`, `Status`, `Tags`, and ideally `ID` / `Variant ID` for
   faster matching. This is **not** the old full
   metafield-rich export -- it never needs to carry a metafield at all.
   A full Matrixify "Products" export still works (it's a superset), but the
   point of this design is that it no longer has to be exactly right: a
   missing metafield column used to get silently written unconditionally
   while being _reported_ as "changed" -- that failure mode is gone, because
   AccountMate-trusted fields are never diffed against this file in the
   first place.

## Files

| Path                      | Role                                                                           |
| ------------------------- | ------------------------------------------------------------------------------ |
| `sync-matrixify.js`       | The sync. Produces the import files.                                           |
| `sync-config.js`          | Every tunable: field map, size vocabulary, categories, handles.                |
| `accountmate.mjs`         | Reads AccountMate exports; hides the two file formats.                         |
| `spec-parser.mjs`         | Normalises, expands and titles specification strings.                          |
| `gen-specifications.mjs`  | Emits Product Specification metaobjects that don't exist yet.                  |
| `gen-content.mjs`         | Drafts handles, titles and descriptions for new products.                      |
| `new-product-content.csv` | Authored content for new products. **Hand-edited; not disposable.**            |
| `output/color-map.csv`    | Persistent SKU → colour code map.                                              |
| `migration/`              | The one-time 2026-08 restructure. Complete; kept for reference.                |
| `archive/`                | Superseded scripts. Reference only — they will not run against current config. |

## Outputs

Five streams, split by trust level and review processing required. Every file carries
`Action` / `Variant SKU` / `Handle` / `Review Reason` so each is
self-sufficient -- no separate report to cross-reference.

| File                   | What it is                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `basic-updates`        | Existing products/variants. AccountMate-trusted fields, written unconditionally every run -- no diffing, no Shopify baseline dependency. `Changed Fields` is a best-effort report column only (populated from the previous-AccountMate diff when available), never a gate.                                                            |
| `review-updates`       | Existing products where the AccountMate text behind a judgment-call field (colour, the two specification lists, manufacturer, MPN, title/handle inputs) changed since the previous AccountMate export. Never auto-written -- one row per Handle, with old/new AccountMate text and a suggested value where one can be safely derived. |
| `new-variants`         | A current-AccountMate SKU with no Shopify match, but whose computed Handle already exists -- add a variant. Trusted fields only, no content columns at all. `Review Reason` always asks for a light grouping confirmation.                                                                                                            |
| `new-variants-BLOCKED` | Rows Shopify would reject (an unresolved size), held back with the reason.                                                                                                                                                                                                                                                            |
| `new-products`         | No SKU match and no Handle match -- full review, same bar as always for a brand-new product.                                                                                                                                                                                                                                          |
| `new-products-BLOCKED` | Same, for new products.                                                                                                                                                                                                                                                                                                               |
| `deleted-products`     | Everything AccountMate has dropped. A worklist, **not an import file**.                                                                                                                                                                                                                                                               |
| `retired-variants`     | The actual MERGE write for a discontinued variant whose product still sells other sizes -- qty 0, backorder policy deny. Narrow header on purpose: no AccountMate row exists for a dropped SKU, so nothing else can be safely written for it.                                                                                         |

Import `new-specifications` **first** -- the product files reference those handles.

---

## The three rules that shape everything

### 1. A blank cell CLEARS the field

Matrixify uses a column's value whenever the column is present. A blank cell
erases the field; it does not mean "leave alone". Two consequences:

- **Only columns the sync understands appear in the output.**
- **AccountMate-trusted fields are written blank when AccountMate has
  nothing**. `Tags` is the one exception -- it can legitimately
  hold a value AccountMate has no opinion on (buyer-facing search terms
  curated over time), so it's **echoed back** from the Shopify identity
  export and merged into, never cleared.

### 2. Rows must form contiguous, ordered product blocks

Matrixify rejects a Handle or ID that reappears after other rows.

### 3. Product-level vs variant-level

A Matrixify export populates product-level fields (`Status`, `Tags`) only on
a product's top row. The Shopify identity export loader carries them
forward by Handle so every row -- not just the first -- reads correctly.

---

## Safety behaviours

**`newProductsOnly` fields are written once, at creation.** MPN is set this
way: AccountMate's Vendor part number is too unreliable to re-sync (it has
carried values like `PAINT` and `JDL-12`). The column is omitted from
`basic-updates`/`review-updates` entirely, because merely including it would
clear a hand-corrected value.

**Unsafe rows are held back, not dropped.** `*-BLOCKED` files carry a
`__blockedBecause` column and rejoin the main file once the cause is fixed.

**Size is never guessed.** Unresolved means reported -- a wrong size
mislabels what ships.

**Judgment-call fields are never auto-written.** Colour, the two
specification-reference lists, manufacturer, MPN drift, and title/handle
inputs only ever land in `review-updates` -- a human confirms before
anything changes. (Colour's confirmation path is `color-map.csv`, which
predates this design and is reused as-is.)

**Matching is against the ACTIVE catalog only, and a conflict is reported,
never guessed at.** The identity export can contain stale Archived/Draft
records left over from past consolidations -- a SKU appearing on one of
those alongside its real Active product is not a conflict and is ignored.
A SKU live on **more than one ACTIVE** product, though, is a genuine
catalog problem: writing to the wrong one could update an orphaned product
while the real one goes untouched. Those SKUs are excluded from
`basic-updates` and printed explicitly (both Handles) rather than guessed
at. A SKU AccountMate still lists with no Active Shopify match at all
(every record Archived/Draft) is also reported separately -- it falls
through to the new-product flow, but that's a reactivate-or-create decision
worth flagging, not a silent default.

---

## How things are derived

### Product identity

One product per colour/chemistry; **Size is the only variant axis**. A new
SKU's product Handle is computed with `buildHandle()`; if that Handle
already exists in the Shopify identity export, it's a new variant of that
product, not a new product -- this computed-Handle-against-the-live-Handle-set
check is the trust anchor for streams 3/4, not an internal SKU-base lookup.

Known limitation: `buildHandle()`'s non-Hentzen branch embeds a slugified
_current_ short description. If that text drifted since a product was
created, a genuinely-existing product's new size can miss the Handle match
and land in `new-products` instead of `new-variants` -- spot-check
`new-products` for SKUs that look like they should already have a home.

### Size

AccountMate first: an unambiguous SKU suffix, then Unit of Measure.
Unresolved is reported, never guessed -- it only ever sets `Option1 Value`
on the row being created; the sync does not maintain a separate product-
level size list metafield.

### Pricing

Computed in one place (`computePricing()`), never mapped directly: base
AccountMate price plus whatever surcharge AccountMate reports (amount wins
over percent).

### Specifications

From AccountMate's `QPL` and `Meets specs` columns, normalised via
`spec-parser.mjs`. Because the parsing involves judgment (typo/variant-
spelling normalisation, multi-value expansion), a change in either column's
raw text routes to `review-updates` rather than being auto-written.

### Tags

Metafields are not indexed by Shopify search; tags are. Spec bases, series,
NSN and colour codes merge into whatever the product already carries (read
from the Shopify identity export's `Tags` column), never disturbing what's
already there.

---

## Known data issues

- **The export is malformed CSV.** Every row wraps `Tier price` in doubled
  quotes, which standard parsers reject. Repaired in `accountmate.mjs`.
- **Entities are triple-encoded** (`&amp;amp;`). Decoding loops until stable.
- **AccountMate's `Color` field is unused** -- 13 broad names that cannot
  resolve to a colour handle. `Color specs` carries the code.
- **SKU whitespace is inconsistent** in both systems. Matching normalises it
  and reports every SKU that matched only because of normalisation.
- **Some specs have no governing body** and are left blank rather than
  guessed.

## Making changes

Nearly everything is in `sync-config.js`:

- `SHOPIFY_FIELD_MAP` -- AccountMate → Shopify, organised by Shopify-facing
  output (not by AccountMate column, since several outputs genuinely depend
  on more than one AccountMate field). `requireManualReview: false` means
  written unconditionally; `true` means it only ever drives `review-updates`.
- `MATRIXIFY_COLUMNS` -- the _only_ place that knows Matrixify's column
  naming. A future move to the Shopify Admin API only needs a new adapter
  here, not a new field map.
- `UOM_TO_SIZE` / `SKU_SUFFIX_SIZE_OVERRIDE` -- how a new SKU's `Option1
Value` (Size) is resolved from AccountMate. (`SIZE_VOCABULARY` /
  `SIZE_METAOBJECT` still exist for the one-time migration scripts in
  `migration/`, but nothing in the live sync reads them -- the sync does
  not maintain a product-level size-list metafield.)
- `PRODUCT_CATEGORY` / `PARENT_COLLECTION` / `PRODUCT_TYPE` -- category
  assigned on every new product (Shopify Standard Product Taxonomy)
- `NEW_PRODUCT_HANDLE` -- `hentzen-{mpn}-{spec}`; applied to new products only,
  because renaming an existing handle costs its SEO ranking

**When a source format changes**, only `accountmate.mjs` should need editing --
everything else asks for canonical field names and is format-agnostic.

**Verify against the written file, not in-memory rows.** Several bugs here were
only visible after the CSV was on disk.
