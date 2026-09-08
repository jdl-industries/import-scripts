#!/usr/bin/env node

/**
 * Generate Shopify Import CSV
 *
 * Takes a Shopify product export and an AccountMate CSV, compares values,
 * and outputs a Shopify-format CSV containing only changed/new products.
 *
 * Usage:
 *   node generate-import.js <shopify-export.csv> <accountmate.csv> [output.csv]
 *   node generate-import.js <shopify-export.csv> <accountmate.csv> --dry-run
 */

import fs from "fs";
import path from "path";

// --- Configuration ---
// Map AccountMate columns to Shopify columns
const FIELD_MAP = {
  "Regular price": { shopifyCol: "Variant Price", compare: "number" },
  Stock: { shopifyCol: "Variant Inventory Qty", compare: "integer" },
  "Weight (lbs)": {
    shopifyCol: "Variant Grams",
    compare: "weight",
    transform: (lbs) => Math.round(lbs * 453.592),
  },
  "Attribute 18 value(s)": {
    shopifyCol: "Variant Compare At Price",
    compare: "number",
  }, // Surcharge amount
  "Attribute 19 value(s)": { shopifyCol: "Cost per item", compare: "number" }, // Cost
  "Attribute 8 value(s)": {
    shopifyCol:
      "Manufacturer Part Number (product.metafields.custom.manufacturer_part_number)",
    compare: "string",
  },
  "Attribute 12 value(s)": {
    shopifyCol: "Is Hazmat? (product.metafields.custom.is_hazmat)",
    compare: "hazmat",
    transform: (v) => (v?.toLowerCase() === "yes" ? "true" : "false"),
  },
};

// Additional metafield to set when compare at price is present
const SURCHARGE_METAFIELD_COL =
  "Compare At Indicates Surcharge (product.metafields.custom.compare_at_indicates_surcharge)";

// Columns required in output (minimal set for updates)
const OUTPUT_COLUMNS = [
  "Handle",
  "Title",
  "Variant SKU",
  "Variant Price",
  "Variant Compare At Price",
  "Variant Inventory Qty",
  "Variant Grams",
  "Cost per item",
  "Manufacturer Part Number (product.metafields.custom.manufacturer_part_number)",
  "Is Hazmat? (product.metafields.custom.is_hazmat)",
  SURCHARGE_METAFIELD_COL,
];

// --- CSV Parsing ---
function parseCSV(content) {
  const rows = [];
  let headers = [];
  let currentRow = [];
  let currentField = "";
  let inQuotes = false;
  let isFirstRow = true;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentField += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      currentRow.push(currentField);
      currentField = "";
    } else if (
      (char === "\n" || (char === "\r" && nextChar === "\n")) &&
      !inQuotes
    ) {
      if (char === "\r") i++;
      currentRow.push(currentField);
      currentField = "";

      if (isFirstRow) {
        headers = currentRow;
        isFirstRow = false;
      } else if (currentRow.some((field) => field)) {
        const rowObj = {};
        headers.forEach((header, idx) => {
          rowObj[header] = currentRow[idx] || "";
        });
        rows.push(rowObj);
      }
      currentRow = [];
    } else if (char !== "\r") {
      currentField += char;
    }
  }

  if (currentRow.length > 0 || currentField) {
    currentRow.push(currentField);
    if (currentRow.some((field) => field)) {
      const rowObj = {};
      headers.forEach((header, idx) => {
        rowObj[header] = currentRow[idx] || "";
      });
      rows.push(rowObj);
    }
  }

  return { headers, rows };
}

// --- CSV Writing ---
function escapeCSVValue(val) {
  if (val == null) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function writeCSV(filePath, headers, rows) {
  const lines = [
    headers.map(escapeCSVValue).join(","),
    ...rows.map((row) =>
      headers.map((h) => escapeCSVValue(row[h] ?? "")).join(","),
    ),
  ];
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
}

// --- Comparison Helpers ---
function compareValues(newVal, currentVal, compareType) {
  // Empty new value means no update needed
  if (newVal === "" || newVal === null || newVal === undefined) {
    return { changed: false };
  }

  if (compareType === "number" || compareType === "weight") {
    const newNum = parseFloat(newVal);
    const curNum = parseFloat(currentVal);
    if (isNaN(newNum)) return { changed: false };
    if (isNaN(curNum)) return { changed: true, value: newNum };
    const changed = Math.abs(newNum - curNum) >= 0.01;
    return { changed, value: newNum };
  }

  if (compareType === "integer") {
    const newInt = parseInt(newVal, 10);
    const curInt = parseInt(currentVal, 10);
    if (isNaN(newInt)) return { changed: false };
    if (isNaN(curInt)) return { changed: true, value: newInt };
    return { changed: newInt !== curInt, value: newInt };
  }

  if (compareType === "hazmat") {
    const newBool = newVal?.toLowerCase() === "yes" ? "true" : "false";
    const curBool = String(currentVal).toLowerCase();
    return { changed: newBool !== curBool, value: newBool };
  }

  // String comparison
  const newStr = String(newVal).trim();
  const curStr = String(currentVal || "").trim();
  return { changed: newStr !== curStr, value: newStr };
}

// --- Main Logic ---
function buildShopifyLookup(shopifyRows) {
  const skuLookup = new Map();
  const titleByHandle = new Map();

  // First pass: collect titles by handle (title only on first row per product)
  for (const row of shopifyRows) {
    const handle = row["Handle"]?.trim();
    const title = row["Title"]?.trim();
    if (handle && title && !titleByHandle.has(handle)) {
      titleByHandle.set(handle, title);
    }
  }

  // Second pass: build SKU lookup with title filled in
  for (const row of shopifyRows) {
    const sku = row["Variant SKU"]?.trim();
    const handle = row["Handle"]?.trim();
    if (sku) {
      // Copy row and ensure title is populated
      const rowWithTitle = { ...row };
      if (!rowWithTitle["Title"] && handle) {
        rowWithTitle["Title"] = titleByHandle.get(handle) || "";
      }
      skuLookup.set(sku, rowWithTitle);
    }
  }

  return skuLookup;
}

function detectChanges(accountMateRow, shopifyRow) {
  const changes = {};
  let hasChanges = false;
  let hasCompareAtPrice = false;
  let surchargeAmount = 0;

  for (const [amCol, config] of Object.entries(FIELD_MAP)) {
    const newVal = accountMateRow[amCol];
    const currentVal = shopifyRow?.[config.shopifyCol];

    const result = compareValues(newVal, currentVal, config.compare);

    if (result.changed) {
      hasChanges = true;
      let finalValue = result.value;

      // Apply transform if exists
      if (config.transform) {
        finalValue = config.transform(newVal);
      }

      changes[config.shopifyCol] = finalValue;

      // Track if we're setting compare at price (surcharge)
      if (config.shopifyCol === "Variant Compare At Price") {
        hasCompareAtPrice = true;
        surchargeAmount = parseFloat(newVal) || 0;
      }
    }
  }

  // If compare at price (surcharge) is being set:
  // 1. Calculate new price = regular price + surcharge
  // 2. Set the surcharge indicator metafield
  if (hasCompareAtPrice && surchargeAmount > 0) {
    const regularPrice = parseFloat(accountMateRow["Regular price"]) || 0;
    const newPrice = (regularPrice + surchargeAmount).toFixed(2);
    changes["Variant Price"] = newPrice;
    changes[SURCHARGE_METAFIELD_COL] = "true";
    hasChanges = true;
  }

  return { hasChanges, changes };
}

function generateImportRow(sku, shopifyRow, changes) {
  const row = {};

  // Required fields for matching
  row["Handle"] = shopifyRow["Handle"];
  row["Variant SKU"] = sku;

  // Copy current values for all output columns, then apply changes
  for (const col of OUTPUT_COLUMNS) {
    if (col === "Handle" || col === "Variant SKU") continue;
    row[col] = shopifyRow[col] ?? "";
  }

  // Apply changes
  for (const [col, value] of Object.entries(changes)) {
    row[col] = value;
  }

  return row;
}

// --- CLI ---
function printUsage() {
  console.log(`
Generate Shopify Import CSV

Compares AccountMate export with current Shopify products and generates
a CSV containing only changed products, ready for Shopify import.

Usage:
  node generate-import.js <shopify-export.csv> <accountmate.csv> [output.csv]
  node generate-import.js <shopify-export.csv> <accountmate.csv> --dry-run

Options:
  --dry-run    Show what would be changed without writing output file

Examples:
  node generate-import.js shopify-export.csv accountmate.csv
  node generate-import.js shopify-export.csv accountmate.csv --dry-run
  node generate-import.js shopify-export.csv accountmate.csv import-2026-06-08.csv
`);
}

async function main() {
  const args = process.argv.slice(2);

  const dryRun = args.includes("--dry-run");
  const positionalArgs = args.filter((a) => !a.startsWith("--"));

  if (positionalArgs.length < 2) {
    printUsage();
    process.exit(1);
  }

  const [shopifyFile, accountMateFile, outputFile] = positionalArgs;
  const finalOutputFile = outputFile || "shopify-import.csv";

  // Read input files
  console.log(`Reading Shopify export: ${shopifyFile}`);
  const shopifyContent = fs.readFileSync(shopifyFile, "utf-8");
  const { rows: shopifyRows } = parseCSV(shopifyContent);
  console.log(`  Found ${shopifyRows.length} products in Shopify\n`);

  console.log(`Reading AccountMate export: ${accountMateFile}`);
  const amContent = fs.readFileSync(accountMateFile, "utf-8");
  const { rows: amRows } = parseCSV(amContent);
  console.log(`  Found ${amRows.length} products in AccountMate\n`);

  // Build lookup
  const shopifyLookup = buildShopifyLookup(shopifyRows);
  console.log(`Built SKU lookup with ${shopifyLookup.size} variants\n`);

  // Process each AccountMate row
  const importRows = [];
  const notFoundSkus = [];
  const unchangedCount = { count: 0 };

  console.log("Comparing products...\n");

  for (const amRow of amRows) {
    const sku = amRow["SKU"]?.trim();
    if (!sku) continue;

    const shopifyRow = shopifyLookup.get(sku);

    if (!shopifyRow) {
      notFoundSkus.push(sku);
      continue;
    }

    const { hasChanges, changes } = detectChanges(amRow, shopifyRow);

    if (hasChanges) {
      const importRow = generateImportRow(sku, shopifyRow, changes);
      importRows.push(importRow);

      // Show what's changing
      const changeDesc = Object.entries(changes)
        .map(([col, val]) => {
          const shortCol = col
            .replace(/\(product\.metafields\.[^)]+\)/, "")
            .trim();
          return `${shortCol}: ${val}`;
        })
        .join(", ");
      console.log(`  ${sku}: ${changeDesc}`);
    } else {
      unchangedCount.count++;
    }
  }

  // Summary
  console.log("\n--- Summary ---");
  console.log(`Products to update: ${importRows.length}`);
  console.log(`Products unchanged: ${unchangedCount.count}`);
  console.log(`SKUs not found in Shopify: ${notFoundSkus.length}`);

  if (notFoundSkus.length > 0) {
    console.log("\nSKUs not found (may be new products):");
    for (const sku of notFoundSkus) {
      console.log(`  - ${sku}`);
    }
  }

  // Write output
  if (importRows.length > 0) {
    if (dryRun) {
      console.log(
        `\n[DRY RUN] Would write ${importRows.length} rows to: ${finalOutputFile}`,
      );
    } else {
      writeCSV(finalOutputFile, OUTPUT_COLUMNS, importRows);
      console.log(`\nWrote ${importRows.length} rows to: ${finalOutputFile}`);
      console.log("\nNext steps:");
      console.log("  1. Review the generated CSV");
      console.log("  2. Go to Shopify Admin > Products > Import");
      console.log(
        '  3. Upload the CSV and select "Overwrite existing products with matching handles"',
      );
    }
  } else {
    console.log("\nNo changes detected - nothing to import.");
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
