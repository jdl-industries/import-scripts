import * as fs from "node:fs";
import * as path from "node:path";
import { stringify } from "csv-stringify/sync";
import { FIELD_DEFINITIONS } from "./fieldDefinitions";
import type { SyncResults } from "./syncEngine";

/**
 * Serializes rows to CSV using the ordered union of all column keys across every row,
 * preventing csv-stringify from dropping columns that only appear on later rows.
 */
function stringifyRows(rows: Array<Record<string, string>>): string {
  if (rows.length === 0) return "";
  const columnSet = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      columnSet.add(key);
    }
  }
  return stringify(rows, {
    header: true,
    columns: Array.from(columnSet),
  });
}

export function outputMatrixifySyncFiles(
  results: SyncResults,
  outputDir: string,
): void {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 1. Deprecations File (grouped by Handle, then SKU)
  const sortedDeprecations = [...results.deprecations].sort(
    (a, b) => a.handle.localeCompare(b.handle) || a.sku.localeCompare(b.sku),
  );
  const deprecationRows = sortedDeprecations.map((d) => ({
    ID: d.productId,
    Handle: d.handle,
    "Variant ID": d.variantId,
    "Variant SKU": d.sku,
    "Variant Command": "UPDATE",
    "Variant Inventory Qty": "0",
    "Variant Inventory Policy": "deny",
    Status: d.archiveProduct ? "Archived" : "",
  }));

  fs.writeFileSync(
    path.join(outputDir, "1_deprecations.csv"),
    stringifyRows(deprecationRows),
  );

  // 2. Trusted Updates & New Variants File (grouped by Handle, then SKU)
  const sortedTrustedUpdates = [...results.trustedUpdates].sort(
    (a, b) => a.handle.localeCompare(b.handle) || a.sku.localeCompare(b.sku),
  );
  const trustedRows = sortedTrustedUpdates.map((u) => ({
    Handle: u.handle,
    "Variant ID": u.variantId || "",
    "Variant SKU": u.sku,
    "Variant Command": "MERGE",
    ...u.fields,
  }));

  fs.writeFileSync(
    path.join(outputDir, "2_trusted_sync.csv"),
    stringifyRows(trustedRows),
  );

  // 3. Drift Review CSV (Audit File, grouped by Handle, then SKU)
  const sortedDriftReviews = [...results.driftReviews].sort(
    (a, b) =>
      a.handle.localeCompare(b.handle) ||
      a.sku.localeCompare(b.sku) ||
      a.field.localeCompare(b.field),
  );
  const driftRows = sortedDriftReviews.map((d) => ({
    SKU: d.sku,
    "Shopify Handle": d.handle,
    Field: d.field,
    "Old AccountMate Value": String(d.previousErpValue),
    "New AccountMate Value": String(d.latestErpValue),
  }));

  fs.writeFileSync(
    path.join(outputDir, "3_review_drift.csv"),
    stringifyRows(driftRows),
  );

  // 4. Staging New Products (grouped by Handle, then SKU)
  const productScopedFields = new Set<string>([
    "Status",
    ...FIELD_DEFINITIONS.filter((r) => r.scope === "product").map(
      (r) => r.shopifyField,
    ),
  ]);

  const sortedNewProductDrafts = [...results.newProductDrafts].sort(
    (a, b) =>
      a.suggestedHandle.localeCompare(b.suggestedHandle) ||
      a.sku.localeCompare(b.sku),
  );

  const seenHandles = new Set<string>();
  const newProductRows = sortedNewProductDrafts.map((n) => {
    const isFirstVariantForHandle = !seenHandles.has(n.suggestedHandle);
    seenHandles.add(n.suggestedHandle);

    const rowFields: Record<string, string> = {};
    for (const [key, val] of Object.entries(n.fields)) {
      rowFields[key] =
        !isFirstVariantForHandle && productScopedFields.has(key) ? "" : val;
    }

    return {
      Handle: n.suggestedHandle,
      "Variant SKU": n.sku,
      ...rowFields,
    };
  });

  fs.writeFileSync(
    path.join(outputDir, "4_staging_new_products.csv"),
    stringifyRows(newProductRows),
  );

  console.log(`\nSync files written to ${outputDir}:`);
  console.log(` - 1_deprecations.csv: ${deprecationRows.length} rows`);
  console.log(` - 2_trusted_sync.csv: ${trustedRows.length} rows`);
  console.log(` - 3_review_drift.csv: ${driftRows.length} audit notices`);
  console.log(
    ` - 4_staging_new_products.csv: ${newProductRows.length} draft products`,
  );
}
