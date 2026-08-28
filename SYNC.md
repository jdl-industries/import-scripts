# Catalog Sync

Two scripts, one shared brain.

| Script | Transport | Status |
|---|---|---|
| **`sync-matrixify.js`** | Matrixify import | **Use this.** The only path that can set variant metafields. |
| `sync-catalog.js` | Shopify native CSV import | Superseded. Cannot set variant metafields at all. |

## Why the switch

Shopify's native CSV import cannot write **variant** metafields. That is where
dimensions, lead time, MPN and hazmat live, so the native path silently failed to
set them. The native export has zero `Variant Metafield:` columns — there is no
column for the importer to read even in principle.

Matrixify handles them, and its `Command: MERGE` semantics remove a whole class
of problems the native path forced on us:

- **No complete product blocks.** MERGE touches only the columns present in a
  row, so a single variant can be updated — or added to an existing product — on
  its own row. The partial-block hazard (importing a subset of a product's
  variants and thereby deleting the rest) is gone.
- **No full-catalog baseline, no superset file.** Output is changed rows only.
- **Three independent files** again, each safe to import on its own.
- **Weight needs no conversion.** `Variant Weight` + `Variant Weight Unit: lb`
  takes AccountMate's pounds directly, retiring the fractional-gram tolerance.

# `sync-matrixify.js`

```bash
node sync-matrixify.js "AccountMate Export.csv" "matrixify-export.csv"
```

| Option | Effect |
|---|---|
| `--outdir <dir>` | Output directory (default `./output`) |
| `--date <date>` | Override the `{date}` stamp |
| `--dry-run` | Report only, write nothing |
| `--verbose` | Per-SKU change detail |

## Blank cells CLEAR data

Matrixify uses a column's value whenever the column is present. **A blank cell
erases the field — it does not mean "leave alone".** Confirmed the hard way on a
one-row test import.

Two rules follow, and both are enforced and tested:

1. **Only columns the sync understands appear in the output.** 20 columns in
   `updated-products`, not the 112 in the export. The other 92 are absent, so
   the import cannot touch them.
2. **Every column present carries the current value**, read from the baseline,
   with AccountMate's changes overlaid. Never a blank where the store has data.

This applies to product-level columns too. When a new variant is added to an
existing product, its row must echo back that product's `Title`, `Body HTML`,
`Vendor`, `Type`, `Status`, `Published` and product metafields — otherwise the
import blanks them. That was 204 cells across 34 live products before it was
caught.

Rows *not* in the file are untouched, so emitting only changed rows is still
safe; the hazard is confined to cells inside included rows.

## Row order and grouping

Matrixify rejects a Handle or ID that reappears after other rows:

```
Warning: The same ID [...] repeats again after other rows - check the row sorting!
```

So the output **mirrors the baseline's row order**. The update loop walks the
Matrixify export rather than the AccountMate file — a SKU can live under more
than one handle, so driving from AccountMate scattered a product's rows through
the file. The export already groups handles contiguously, so mirroring its order
gives correct grouping for free.

Additions in `new-products` are sorted by where their product appears in the
baseline, keeping each product's new variants together; brand-new products go
last.

Product-level values are echoed on **every** row of a product, not just the
first. That satisfies "product fields on the first variant" while avoiding a
blank cell on the later rows — which would clear the field.

## The baseline must be a Matrixify export

Not a Shopify admin export. The native export has no variant-metafield columns,
so most fields would have nothing to diff against and would be rewritten every
run. The script detects this, warns, and lists which columns it could not diff.

## What gets written

Every row carries `Command: MERGE` and `Variant Command: MERGE`, plus `ID` /
`Variant ID` when the baseline supplies them.

| AccountMate | Matrixify column |
|---|---|
| `Regular price` + `Surcharge amount` | `Variant Price` |
| `Surcharge amount` | `Variant Compare At Price` |
| `Stock` | `Variant Inventory Qty` |
| `Weight (lbs)` | `Variant Weight` (+ `Variant Weight Unit: lb`) |
| `Cost` | `Variant Cost` |
| `Vendor SKU` | `Variant Metafield: custom.manufacturer_part_number` |
| `Hazardous` | `Variant Metafield: custom.is_hazmat [boolean]` |
| `Lead time` | `Variant Metafield: custom.lead_time [number_integer]` |
| `Length/Width/Height (in)` | `Variant Metafield: custom.{length,width,height} [dimension]` |
| `Fixed Tiered Prices` | `Variant Metafield: custom.accountmate_tiered_prices` |

All variant-level: AccountMate carries one value per SKU, and only variant
metafields can hold a distinct value per variant. The product-level copies of
MPN, lead time and hazmat are left untouched.

The abandoned `custom.{length,width,height}_in [number_decimal]` metafields
(0/14 populated) are ignored in favour of the live `[dimension]` ones.

### Dimension format

`{"value":9.0,"unit":"INCHES"}`. Compared **numerically**, not as strings — the
store serialises `9.0` where `JSON.stringify` produces `9`, which would otherwise
mark every dimension changed on every run.

## The colour map is the one thing you maintain


Shopify's `Option1 Value` holds a specific colour code (`17925`, `bac-707`,
`pantone-281c`). AccountMate's `Color` attribute only has broad names (`WHITE`,
`GRAY`), so the code has to be recovered from the Short description.

The extractor gets **78% coverage at 92% precision** (measured against 62
variants already live in Shopify). Because precision is not 100% — it once
returned `bac-7067` where the right answer was `17925` — **an extracted value is
never written into an import file**. It only ever lands in `color-map.csv` as a
suggestion.

Workflow:

1. Run the sync. New SKUs are appended to `color-map.csv` with a guess, its
   source (`bac` / `fedstd` / `pantone` / `bare5`), a confidence, and the text
   snippet the guess came from.
2. Fill or correct the **`Confirmed Color`** column. That column is the only one
   the script reads back; everything else is evidence for your review.
3. Re-run. Confirmed colours flow into `new-products.csv`; unconfirmed ones stay
   as `NEEDS-COLOR`.

Confirmations are permanent — a SKU is never re-asked. The map is also seeded
with every colour already live in Shopify, so those are correct from day one.

## Safety behaviours

These exist because the AccountMate data is known to be unreliable.

**Blank never overwrites populated.** A blank (or, for fields like weight, a
`0.00`) AccountMate value never clears good Shopify data. Skips are logged.

**Hazmat is direction-protected.** Shopify flags 168/172 variants as hazmat;
AccountMate would downgrade 13 solvent-based coatings to `FALSE`. Since a wrong
hazmat flag is a shipping-compliance problem, `TRUE → FALSE` is reported for
manual review and never written — `FALSE → TRUE` still flows through. Remove the
`ratchet` line on the hazmat field in `sync-config.js` to disable this.

**Product-level fields need product-wide agreement.** Everything matching
`(product.metafields.*)` is a single value per *product*, but AccountMate has a
value per *SKU*. Where a product's variants disagree — currently 4 products for
Lead time — nothing is written and the conflict is reported.

**Output is byte-faithful to the export.** Product-level values are carried
forward across variant rows for *comparison only*. Emitted rows reproduce the
original export row verbatim and overlay just the changed columns, so a
re-import never rewrites titles, body copy or metafields that didn't change.

**Allow-list.** Only columns in `UPDATABLE_COLUMNS` are ever written to existing
products. Titles, body copy, SEO, images and tags stay Shopify's.

## Known data issues this surfaces

- **SKU whitespace.** Both systems carry inconsistent internal spacing
  (`"AXPG-6-W3  G2"`). Matching normalizes it and reports every SKU that matched
  only because of normalization — worth fixing at the AccountMate source.
- **Duplicate SKUs in Shopify.** 68 rows are the same SKU under both a
  `consolidated` product and an un-retired legacy standalone, all active. Per
  current config both handles get updated so they stay in sync; the legacy ones
  are listed in `deleted-products.csv` as retirement candidates.
- **`6OZ/K` is ambiguous** in the live catalog — mapped to both `4oz Kit` and
  `6oz Touch-up Kit`. `sync-config.js` picks `6oz Touch-up Kit`.

## Configuration

Everything tunable is in `sync-config.js`:

- `FIELD_MAP` — AccountMate → Shopify field mapping, with per-field `compare`,
  `transform`, `tolerance`, `scope` and `blankPolicy`. AccountMate attributes are
  resolved **by name**, not column position, so a reordered export won't
  silently shift values.
- `UPDATABLE_COLUMNS` — the write allow-list.
- `PREFIX_TO_HANDLE` — SKU prefix → existing product handle, for grouping new
  SKUs as variants. Seeded with 16 rules mined from the live catalog. Longest
  prefix wins.
- `UOM_TO_SIZE` / `SKU_SUFFIX_TO_SIZE` — Size (Option2) resolution. Unit of
  Measure is tried first (55/59 coverage), SKU suffix second.
- `COLOR_PATTERNS` — the colour extraction regexes.

### Adding a new product line

When a new SKU family should become variants of one product, add a
`PREFIX_TO_HANDLE` entry. Until then those SKUs come out as standalone drafts
(`Status: draft`), which is safe — they won't appear on the storefront.

## Note on MPN / Vendor SKU

AccountMate's **Vendor SKU** maps to **`Google Shopping / MPN`** — the
variant-level metafield created by the Google channel app. That column is
currently empty in Shopify (0/172 rows), so the first sync backfills it for
every matched SKU.

The product-level `custom.manufacturer_part_number` metafield is deliberately
**not** synced: it holds one value per product, so on multi-variant products the
per-SKU Vendor SKUs conflict and nothing can be written safely. It is left
untouched in Shopify.

Two quirks in the source values, left intact because trimming them is a content
decision rather than a formatting one:

- Many are compound: `"K32202RPX-T2 + CAT 06480CMU"` (part plus catalyst).
- One is multi-valued: `"PG-6-G1, PG6G1"`.

Stray internal whitespace *is* collapsed (`"K32236WPX-T2  CAT 06480CMU"` →
`"K32236WPX-T2 CAT 06480CMU"`).

## Note on `Variant Price`

Shopify's price is **base price + surcharge**, with the surcharge itself in
`Variant Compare At Price` and a metafield flagging the convention. Price is
therefore computed in exactly one place (`computePricing`) rather than mapped
directly from `Regular price`. Mapping both is what made all 144 matched
variants look changed on the first draft of this script.
