# AccountMate-to-Shopify Catalog Sync

CLI sync pipeline that compares daily AccountMate ERP CSV exports against current Shopify/Matrixify catalog state to produce segmented, Matrixify-ready import files and audit reports.

# Architecture Overview

```
                      ┌────────────────────────┐
                      │  previousAccountMate   │ (optional diff baseline)
                      └───────────┬────────────┘
                                  │
┌────────────────────────┐        │
│    latestAccountMate   ├────────┼────────┐
└────────────────────────┬────────┘        │
                         ▼                 ▼
             ┌─────────────────────────────────────────┐
             │               syncEngine                │ ◄─── FIELD_MAPPINGS
             │    (3-way diff, trust classification,   │      (declarative rules)
             │     SKU normalization & resolution)     │
             └───────────────────▲─────────────────────┘
                                 │
┌────────────────────────┐       │
│     currentShopify     ├───────┘
│   (Matrixify export)   │
└────────────────────────┘
                                 │
                                 ▼
                     ┌───────────────────────┐
                     │      SyncResults      │
                     └───────────┬───────────┘
                                 │
         ┌───────────────────────┼───────────────────────┬───────────────────────┐
         ▼                       ▼                       ▼                       ▼
  1_deprecations.csv      2_trusted_sync.csv      3_review_drift.csv      4_staging_new_products.csv
  (zero qty + unpublish)  (blind updates + new    (audit: ERP modified    (draft products for
                          variants on existing)   Shopify-owned copy)     manual review/staging)
```

# Core Design Rules

- _3-Way Diff:_ Diffs `latestAm` against `previousAm` to isolate ERP change events, then reconciles against `currentShopify` to resolve target handles and variant IDs.
- _Separation of Concerns:_ Parser logic, field transformation rules, diff evaluation, and output generation live in dedicated, decoupled modules.
- _Transport Agnostic:_ The engine outputs an internal `SyncResults` domain object. Output currently targets Matrixify CSVs, but can plug into Shopify Admin GraphQL mutations (`productVariantsBulkUpdate`, `inventorySetQuantities`, `productCreate`) without altering engine logic.
- _Exact Accounting:_ Every incoming SKU must land in exactly one bucket: `trustedUpdates`, `unchanged`, or `newProductDrafts`.

# File Structure

```
├──/data
│  ├──/accountmate             # Permanent, immutable ERP snapshots
│  │  ├── 2026-11-04.csv
│  │  ├── 2026-11-05.csv
│  │  └── 2026-11-06.csv
│  ├──/shopify                 # Permanent, immutable Shopify baseline snapshots
│  │  ├── 2026-11-05.csv
│  │  └── 2026-11-06.csv
│  └──/runs                    # Output artifacts per execution
│     ├──/2026-11-06_run-01
│     │  ├── 1_deprecations.csv
│     │  ├── 2_trusted_sync.csv
│     │  ├── 3_review_drift.csv
│     │  └── 4_staging_new_products.csv
│     └──/2026-11-06_run-01
├──/src
│  ├── accountMatetypes.ts     # AccountMate raw CSV schema & normalized domain models
│  ├── shopifyTypes.ts         # Matrixify export row schema & hierarchical catalog state
│  ├── fieldDefinitions.ts     # Declarative FIELD_MAPPINGS array (transforms + trust levels)
│  ├── parseAccountMate.ts     # Windows-1252/Latin1 parser, type-casting, SKU dictionary builder
│  ├── parseShopify.ts         # Groups flat rows into products, indexes activeVariantsBySku
│  ├── productResolver.ts      # Top-down hooks: getShopifyProduct() & resolveVariantOptions()
│  ├── syncEngine.ts           # 3-way diff planner returning SyncResults
│  ├── writeMatrixifyFiles.ts  # RFC 4180 CSV serializer generating segmented import files
│  └── cli.ts                  # CLI argument parser (util.parseArgs) and execution orchestrator
├──/scripts
│  ├── ingest.ts               # copy and name source Shopify/accountmate files
│  └── runSync.ts              # run the sync
├── package.json
└── tsconfig.json
```

# Output Workstreams

1. `deprecations.csv`
   - Trigger: SKU in `previousAm` (or active in Shopify) but absent from `latestAm`.
   - Action: Sets `Variant Inventory Qty: 0`, `Variant Inventory Policy: deny`. If all sibling variants on the product are also absent, sets parent `Status: Archived`
2. `trusted_sync.csv`
   - Trigger: Existing active variant with ERP pricing/inventory changes, OR new SKU belonging to an existing Shopify parent product.
   - Action: Blind Matrixify import containing `Handle`, `Variant ID` (if existing), `Variant SKU`, and transformed trusted fields.
3. `review_drift.csv`
   - Trigger: SKU where AccountMate source copy (eg `Short description`, `Description`, etc) changed between ERP exports, but Shopify is the system of record.
   - Action: Audit-only CSV (`SKU`, `Shopify Handle`, `Field,` `Old ERP Value`, `New ERP Value`
4. `staging_new_products.csv`
   - Trigger: SKU in `latestAm` with no active product match in Shopify.
   - Action: Matrixify-ready draft staging (`Status: Draft`) with best-guess title, handle, tags, and operational defaults for manual review before activation.

# CLI Usage

## Prerequisites

- Node.js >= 18.x
- TypeScript / tsx runtime

## Typical Iteration Flow

1. Ingest once:

```
npm run ingest:am -- ~/Downloads/webfile.csv
npm run ingest:shopify -- ~/Downloads/Products.csv
```

2. Execute sync:

```
npm run sync
```

_(Outputs to data/runs/2026-11-06_run-01/)_

3. Tweak your mapping logic in `fieldDefinitions.ts` or `syncEngine.ts`.

4. Rerun immediately:

```
npm run sync
```

_(Outputs to data/runs/2026-11-06_run-02/, keeping inputs untouched and previous run outputs available for comparison)._

## CLI Options

- -l, --latestAm <path>: (Required) Latest AccountMate CSV export.
- -s, --shopify <path>: (Required) Current Matrixify Products.csv export.
- -p, --previousAm <path>: (Optional) Previous AccountMate CSV export for diffing.
- -o, --outDir <path>: Output directory (defaults to ./dist-sync).
  -h, --help: Output command flags.

## Gotchas & Edge Cases

- Encoding: AccountMate exports use Windows-1252 / latin1 (contains unescaped trademark symbols ™, smart quotes). Reading with UTF-8 will throw decode faults.
- Duplicate SKUs in Shopify: Old/superseded product representations exist in archived states. Only index variants where Status === 'Active' into activeVariantsBySku ($1:1$). Retain archived records in a separate fallback map (archivedVariantsBySku) for reactivation logic.
- Field Typo in AccountMate: The raw column for special packaging surcharge is spelled Spedial pkg price in the export header.
