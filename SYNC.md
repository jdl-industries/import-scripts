# JDL Shopify ⇄ AccountMate Sync

Keeps the Shopify catalog in step with the client's AccountMate ERP. AccountMate
is the source of truth for pricing, stock, dimensions and specifications;
Shopify owns titles, copy, images, SEO and anything merchandising-related.

```bash
# 1. create any Product Specification metaobjects the catalog references
node gen-specifications.mjs "AccountMate Export.csv" Product_Specifications.csv

# 2. produce the import files
node sync-matrixify.js "AccountMate Export.csv" Products.csv
```

Both inputs must be current: **`Products.csv` is a Matrixify export**, and it is
the baseline every diff is taken against. A stale one produces wrong answers.

| Option | Effect |
|---|---|
| `--outdir <dir>` | Output directory (default `./output`) |
| `--date <date>` | Override the `{date}` stamp |
| `--dry-run` | Report only, write nothing |
| `--verbose` | Per-SKU change detail |
| `--changed-only` | Narrow `updated-products` to changed rows (default mirrors the baseline) |

## Files

| Path | Role |
|---|---|
| `sync-matrixify.js` | The sync. Produces the import files. |
| `sync-config.js` | Every tunable: field map, size vocabulary, categories, handles. |
| `accountmate.mjs` | Reads AccountMate exports; hides the two file formats. |
| `spec-parser.mjs` | Normalises, expands and titles specification strings. |
| `gen-specifications.mjs` | Emits Product Specification metaobjects that don't exist yet. |
| `gen-content.mjs` | Drafts handles, titles and descriptions for new products. |
| `new-product-content.csv` | Authored content for new products. **Hand-edited; not disposable.** |
| `output/color-map.csv` | Persistent SKU → colour code map. |
| `migration/` | The one-time 2026-08 restructure. Complete; kept for reference. |
| `archive/` | Superseded scripts. Reference only — they will not run against current config. |

## Outputs

| File | What it is |
|---|---|
| `updated-products` | Existing products. **Mirrors the baseline row-for-row** so it can be diffed against it. |
| `new-products` | New products and new sizes of existing ones. |
| `new-products-BLOCKED` | Rows Shopify would reject, held back with the reason. Nothing is silently dropped. |
| `deleted-products` | Everything AccountMate has dropped. A worklist, **not an import file**. |
| `sync-report` | Which fields changed per row, and what needs review. |

Import `new-specifications` **first** — the product files reference those handles.

---

## The three rules that shape everything

### 1. A blank cell CLEARS the field

Matrixify uses a column's value whenever the column is present. A blank cell
erases the field; it does not mean "leave alone". Two consequences, both
enforced in code:

* **Only columns the sync understands appear in the output** — ~26 of the
  export's 110+, so the import cannot touch the rest.
* **Every column present carries the current value**, read from the baseline,
  with AccountMate's changes overlaid.

This applies to product-level columns on variant rows too. A row adding a
variant must echo back its product's `Title`, `Body HTML`, `Tags`, category and
metafields, or the import blanks them.

The exception is `blankPolicy: "overwrite"`, which deliberately writes blanks
through — currently only the two AccountMate description mirrors.

### 2. Rows must form contiguous, ordered product blocks

Matrixify rejects a Handle or ID that reappears after other rows. Output
therefore mirrors the baseline's row order; the export already groups handles
contiguously, so this comes free.

### 3. Product-level vs variant-level

A Matrixify export populates product-level fields only on a product's top row.
They are carried forward for **comparison**, but emitted rows reproduce the
original verbatim so a re-import never rewrites untouched copy.

---

## Safety behaviours

The AccountMate data is known to be inconsistent, so several guards exist.

**Hazmat is direction-protected.** `TRUE → FALSE` is reported and never written;
`FALSE → TRUE` flows through. A wrong hazmat flag is a shipping-compliance
problem. The ratchet reads current state from *every* column carrying the fact
(`custom.hazardous`, `custom.is_hazmat`, the product-level metafield) and
protects if **any** of them still says true — a single-source check let three
products through when the metafield type changed.

**Blank never overwrites populated**, except where `blankPolicy` says otherwise.

**`newProductsOnly` fields are written once, at creation.** MPN is set this way:
AccountMate's Vendor part number is too unreliable to re-sync (it has carried
values like `PAINT` and `JDL-12`). The column is omitted from `updated-products`
entirely, because merely including it would clear a hand-corrected value.

**Unsafe rows are held back, not dropped.** `new-products-BLOCKED` carries a
`__blockedBecause` column and rejoins the main file once the cause is fixed.

**Size is never guessed.** Unresolved means reported — a wrong size mislabels
what ships.

---

## How things are derived

### Product identity

One product per colour/chemistry; **Size is the only variant axis**. The product
is the SKU with its size token stripped:

```
HZK31136WPX-T1          ┐
HZK31136WPX-T1 QT/KT    ├─ one product, three Size variants
HZK31136WPX-T1 4OZ/K    ┘
```

This decides automatically whether a new SKU is a new product or another size of
an existing one.

### Size

AccountMate first: an unambiguous SKU suffix, then Unit of Measure. The mapping
was **mined from the catalog's own curation**, not guessed — every gallon-ish
pack is `Gallon`-family, because the kit designation describes the 3/1 mix
packaging rather than sellable volume. `custom.size` holds the product's
*distinct* sizes as metaobject references.

### Pricing

Computed in one place (`computePricing`), never mapped directly:

```
neither surcharge set   price = AccountMate price,  compare-at CLEARED,      indicator false
surcharge AMOUNT set    price = price + amount,     compare-at = amount,     indicator true
surcharge PERCENT set   price = price + price×pct%, compare-at = price×pct%, indicator true
```

Both directions matter: when a surcharge drops to zero the stale compare-at must
be cleared, or the storefront shows a struck-out price.

### Specifications

From AccountMate's `QPL` and `Meets specs` columns, then normalised:

* variant spellings collapse (`MIL-DLT`→`MIL-DTL`, `O.S.U.`→`OSU`, `BMS10-83`→`BMS 10-83`)
* abbreviations expand (`TY`→`Type`, `CL`→`Class`)
* multi-value strings split: `BMS 10-60, Type I & II, Class B` becomes two specs
  (also handles `/` and `and`, and a repeated keyword)
* titles get canonical punctuation so `MIL-PRF-85285, Type I, Class H` and
  `MIL-PRF-85285 Type I Class H` don't become two metaobjects
* `base_specification` strips the revision (`MIL-PRF-85285E` → `MIL-PRF-85285`)
  and is **blank when it equals the title**

### Tags

Metafields are not indexed by Shopify search; tags are. Four sources merge into
whatever the product already carries:

```
spec bases    mil-prf-85285, bms-10-60
series        pg-6
colour codes  37038, bac-707        (from Color specs, not the unused Color field)
NSN           8010-01-582-7282
```

---

## Known data issues

* **The export is malformed CSV.** Every row wraps `Tier price` in doubled
  quotes, which standard parsers reject. Repaired in `accountmate.mjs`; should be
  fixed at source.
* **Entities are triple-encoded** (`&amp;amp;`). Decoding loops until stable.
  Because `&amp;` contains a semicolon, a single pass silently split
  qualifications in half.
* **AccountMate's `Color` field is unused** — 13 broad names that cannot resolve
  to a colour handle. `Color specs` carries the code.
* **SKU whitespace is inconsistent** in both systems. Matching normalises it and
  reports every SKU that matched only because of normalisation.
* **Some specs have no governing body** (`EPS G37.341`, `Q2179`) and are left
  blank rather than guessed.
* **One NSN is malformed** — `8010-582-7301` is missing a segment versus the
  standard 4-2-3-4 form.

## Making changes

Nearly everything is in `sync-config.js`:

* `MATRIXIFY_FIELD_MAP` — AccountMate → Shopify, with per-field `compare`,
  `transform`, `tolerance`, `scope`, `blankPolicy`, `ratchet`, `newProductsOnly`
* `UOM_TO_SIZE` / `SKU_SUFFIX_SIZE_OVERRIDE` / `SIZE_VOCABULARY` / `SIZE_METAOBJECT`
* `PRODUCT_CATEGORY` / `PARENT_COLLECTION` / `PRODUCT_TYPE` — category is
  **required**: `custom.size` is a category metafield and is rejected without one
* `NEW_PRODUCT_HANDLE` — `hentzen-{mpn}-{spec}`; applied to new products only,
  because renaming an existing handle costs its SEO ranking

**When adding a column, three places need it**: the field map, the output header,
and `managedColumns` (which carries current values). Missing the header means the
value is computed and then silently stripped at write time — this has caused
several bugs.

**When a source format changes**, only `accountmate.mjs` should need editing —
everything else asks for canonical field names and is format-agnostic.

**Verify against the written file, not in-memory rows.** Several bugs here were
only visible after the CSV was on disk.
