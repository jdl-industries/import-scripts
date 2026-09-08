#!/usr/bin/env node

/**
 * Consolidate Products for Shopify Import
 *
 * Merges consolidated product definitions with existing Shopify variant data
 * to create a new import CSV with products grouped by chemical composition
 * and variants by Color (Option1) and Size (Option2).
 *
 * Usage:
 *   node consolidate-products.js <consolidated.csv> <shopify-export.csv> [output.csv]
 *   node consolidate-products.js <consolidated.csv> <shopify-export.csv> --dry-run
 */

import fs from "fs";

// --- Configuration ---
// Columns for the Shopify import output (full product import)
const SHOPIFY_COLUMNS = [
  "Handle",
  "Title",
  "Body (HTML)",
  "Vendor",
  "Product Category",
  "Type",
  "Tags",
  "Published",
  "Option1 Name",
  "Option1 Value",
  "Option1 Linked To",
  "Option2 Name",
  "Option2 Value",
  "Option2 Linked To",
  "Option3 Name",
  "Option3 Value",
  "Option3 Linked To",
  "Variant SKU",
  "Variant Grams",
  "Variant Inventory Tracker",
  "Variant Inventory Qty",
  "Variant Inventory Policy",
  "Variant Fulfillment Service",
  "Variant Price",
  "Variant Compare At Price",
  "Variant Requires Shipping",
  "Variant Taxable",
  "Variant Barcode",
  "Image Src",
  "Image Position",
  "Image Alt Text",
  "Gift Card",
  "SEO Title",
  "SEO Description",
  "Google Shopping / Google Product Category",
  "Google Shopping / MPN",
  "Google Shopping / Condition",
  "Variant Image",
  "Variant Weight Unit",
  "Cost per item",
  "Status",
  // Metafields
  "Manufacturer Part Number (product.metafields.custom.manufacturer_part_number)",
  "Military Specifications (product.metafields.custom.mil_specs)",
  "Is Hazmat? (product.metafields.custom.is_hazmat)",
  "Compare at indicates surcharge (product.metafields.custom.compare_at_indicates_surcharge)",
  "Color (product.metafields.shopify.color-pattern)",
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
      headers.map((h) => escapeCSVValue(row[h] ?? "")).join(",")
    ),
  ];
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
}

// --- Build Shopify SKU Lookup ---
function buildShopifyLookup(shopifyRows) {
  const skuLookup = new Map();

  for (const row of shopifyRows) {
    const sku = row["Variant SKU"]?.trim();
    if (sku) {
      skuLookup.set(sku, row);
    }
  }

  return skuLookup;
}

// --- Normalize color value for metafield (slug format) ---
function normalizeColorSlug(color) {
  if (!color || color === "Default") return "";
  return color
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// --- Convert Mil Spec to tag-friendly format ---
function milSpecToTags(milSpec) {
  if (!milSpec) return "";
  // Split by comma or semicolon and convert each to lowercase slug
  return milSpec
    .split(/[,;]/)
    .map((s) =>
      s
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "-")
    )
    .filter(Boolean)
    .join(", ");
}

// --- Main Logic ---
function groupConsolidatedByHandle(consolidatedRows) {
  const groups = new Map();

  for (const row of consolidatedRows) {
    const handle = row["Handle"]?.trim();
    if (!handle) continue;

    if (!groups.has(handle)) {
      groups.set(handle, []);
    }
    groups.get(handle).push(row);
  }

  return groups;
}

function generateImportRows(consolidatedGroups, shopifyLookup) {
  const importRows = [];
  const missingSkus = [];
  const skusWithData = [];

  for (const [handle, variants] of consolidatedGroups) {
    let isFirstRow = true;

    // Get product-level info from first variant
    const firstVariant = variants[0];
    const title = firstVariant["Title"]?.trim() || "";
    const description = firstVariant["Description"]?.trim() || "TBD";
    const type = firstVariant["Type"]?.trim() || "";
    const milSpec = firstVariant["Mil Spec"]?.trim() || "";
    const isHazmat = firstVariant["Is Hazmat?"]?.trim().toUpperCase() === "TRUE";

    // Build tags from type and hazmat status
    const tags = [];
    if (type) tags.push(type.toLowerCase());
    if (isHazmat) tags.push("hazmat");
    const milTags = milSpecToTags(milSpec);
    if (milTags) tags.push(milTags);

    for (const consolidatedRow of variants) {
      const sku = consolidatedRow["Variant SKU"]?.trim();
      if (!sku) continue;

      const shopifyData = shopifyLookup.get(sku);
      if (!shopifyData) {
        missingSkus.push(sku);
      } else {
        skusWithData.push(sku);
      }

      const size = consolidatedRow["Size"]?.trim() || "";
      const color = consolidatedRow["Color"]?.trim() || "Default";
      const mpn = consolidatedRow["Manufacturer Part Number"]?.trim() || "";

      const row = {};

      // Always set handle and variant-level fields
      row["Handle"] = handle;
      row["Variant SKU"] = sku;

      // Option values (every row)
      row["Option1 Value"] = color;
      row["Option2 Value"] = size;

      // Product-level fields (first row only)
      if (isFirstRow) {
        row["Title"] = title;
        row["Body (HTML)"] = `<p>${description}</p>`;
        row["Vendor"] = "Hentzen";
        row["Type"] = type;
        row["Tags"] = tags.join(", ");
        row["Published"] = "true";
        row["Status"] = "active";

        // Option names (first row only)
        row["Option1 Name"] = "Color";
        row["Option1 Linked To"] = "product.metafields.shopify.color-pattern";
        row["Option2 Name"] = "Size";
        row["Option2 Linked To"] = "";

        // Metafields (product-level, first row)
        row["Military Specifications (product.metafields.custom.mil_specs)"] =
          milSpec
            .split(/[,;]/)
            .map((s) =>
              s
                .trim()
                .toLowerCase()
                .replace(/\s+/g, "-")
            )
            .filter(Boolean)
            .join("; ");
        row["Is Hazmat? (product.metafields.custom.is_hazmat)"] = isHazmat
          ? "TRUE"
          : "FALSE";

        // SEO fields
        row["SEO Title"] = title;
        row["SEO Description"] = description.substring(0, 160);

        // Google Shopping
        row["Google Shopping / Google Product Category"] = "1470";
        row["Google Shopping / Condition"] = "";

        row["Gift Card"] = "false";

        isFirstRow = false;
      }

      // Variant-level fields from Shopify export (if available)
      if (shopifyData) {
        row["Variant Grams"] = shopifyData["Variant Grams"] || "";
        row["Variant Inventory Tracker"] =
          shopifyData["Variant Inventory Tracker"] || "shopify";
        row["Variant Inventory Qty"] =
          shopifyData["Variant Inventory Qty"] || "0";
        row["Variant Inventory Policy"] =
          shopifyData["Variant Inventory Policy"] || "deny";
        row["Variant Fulfillment Service"] =
          shopifyData["Variant Fulfillment Service"] || "manual";
        row["Variant Price"] = shopifyData["Variant Price"] || "";
        row["Variant Compare At Price"] =
          shopifyData["Variant Compare At Price"] || "";
        row["Variant Requires Shipping"] =
          shopifyData["Variant Requires Shipping"] || "true";
        row["Variant Taxable"] = shopifyData["Variant Taxable"] || "true";
        row["Variant Barcode"] = shopifyData["Variant Barcode"] || "";
        row["Variant Image"] = shopifyData["Variant Image"] || "";
        row["Variant Weight Unit"] = shopifyData["Variant Weight Unit"] || "lb";
        row["Cost per item"] = shopifyData["Cost per item"] || "";
        row["Product Category"] = shopifyData["Product Category"] || "";
        row["Image Src"] = shopifyData["Image Src"] || "";
        row["Image Position"] = shopifyData["Image Position"] || "";
        row["Image Alt Text"] = shopifyData["Image Alt Text"] || "";
        row["Compare at indicates surcharge (product.metafields.custom.compare_at_indicates_surcharge)"] =
          shopifyData[
            "Compare at indicates surcharge (product.metafields.custom.compare_at_indicates_surcharge)"
          ] || "";
      } else {
        // Default values for missing SKUs
        row["Variant Inventory Tracker"] = "shopify";
        row["Variant Inventory Qty"] = "0";
        row["Variant Inventory Policy"] = "deny";
        row["Variant Fulfillment Service"] = "manual";
        row["Variant Requires Shipping"] = "true";
        row["Variant Taxable"] = "true";
        row["Variant Weight Unit"] = "lb";
      }

      // MPN - from consolidated file
      row[
        "Manufacturer Part Number (product.metafields.custom.manufacturer_part_number)"
      ] = mpn;

      // Color metafield (for color swatches)
      const colorSlug = normalizeColorSlug(color);
      row["Color (product.metafields.shopify.color-pattern)"] = colorSlug;

      importRows.push(row);
    }
  }

  return { importRows, missingSkus, skusWithData };
}

// --- CLI ---
function printUsage() {
  console.log(`
Consolidate Products for Shopify Import

Merges consolidated product definitions with existing Shopify variant data
to create a new import CSV with products grouped by chemical composition.

Usage:
  node consolidate-products.js <consolidated.csv> <shopify-export.csv> [output.csv]
  node consolidate-products.js <consolidated.csv> <shopify-export.csv> --dry-run

Options:
  --dry-run    Show what would be generated without writing output file

Examples:
  node consolidate-products.js consolidated-products.csv products_export.csv
  node consolidate-products.js consolidated-products.csv products_export.csv --dry-run
  node consolidate-products.js consolidated-products.csv products_export.csv shopify-import.csv
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

  const [consolidatedFile, shopifyFile, outputFile] = positionalArgs;
  const finalOutputFile = outputFile || "consolidated-shopify-import.csv";

  // Read input files
  console.log(`Reading consolidated products: ${consolidatedFile}`);
  const consolidatedContent = fs.readFileSync(consolidatedFile, "utf-8");
  const { rows: consolidatedRows } = parseCSV(consolidatedContent);
  console.log(`  Found ${consolidatedRows.length} variant rows\n`);

  console.log(`Reading Shopify export: ${shopifyFile}`);
  const shopifyContent = fs.readFileSync(shopifyFile, "utf-8");
  const { rows: shopifyRows } = parseCSV(shopifyContent);
  console.log(`  Found ${shopifyRows.length} variant rows in Shopify\n`);

  // Build lookups
  const shopifyLookup = buildShopifyLookup(shopifyRows);
  console.log(`Built SKU lookup with ${shopifyLookup.size} Shopify variants\n`);

  // Group consolidated products by handle
  const consolidatedGroups = groupConsolidatedByHandle(consolidatedRows);
  console.log(
    `Grouped into ${consolidatedGroups.size} consolidated products\n`
  );

  // Generate import rows
  const { importRows, missingSkus, skusWithData } = generateImportRows(
    consolidatedGroups,
    shopifyLookup
  );

  // Summary
  console.log("--- Summary ---");
  console.log(`Products (handles): ${consolidatedGroups.size}`);
  console.log(`Total variants: ${importRows.length}`);
  console.log(`Variants with Shopify data: ${skusWithData.length}`);
  console.log(`Variants missing from Shopify: ${missingSkus.length}`);

  if (missingSkus.length > 0) {
    console.log("\nSKUs not found in Shopify export (will have default values):");
    for (const sku of missingSkus) {
      console.log(`  - ${sku}`);
    }
  }

  // Show product breakdown
  console.log("\n--- Products ---");
  for (const [handle, variants] of consolidatedGroups) {
    const title = variants[0]["Title"] || handle;
    const colors = [...new Set(variants.map((v) => v["Color"]?.trim() || "Default"))];
    const sizes = [...new Set(variants.map((v) => v["Size"]?.trim()))];
    console.log(`${handle}`);
    console.log(`  Title: ${title}`);
    console.log(`  Colors: ${colors.join(", ")}`);
    console.log(`  Sizes: ${sizes.join(", ")}`);
    console.log(`  Variants: ${variants.length}`);
    console.log("");
  }

  // Write output
  if (importRows.length > 0) {
    if (dryRun) {
      console.log(
        `[DRY RUN] Would write ${importRows.length} rows to: ${finalOutputFile}`
      );
    } else {
      writeCSV(finalOutputFile, SHOPIFY_COLUMNS, importRows);
      console.log(`Wrote ${importRows.length} rows to: ${finalOutputFile}`);
      console.log("\nNext steps:");
      console.log("  1. Review the generated CSV");
      console.log("  2. Go to Shopify Admin > Products > Import");
      console.log(
        '  3. Upload the CSV and select "Overwrite existing products with matching handles"'
      );
    }
  } else {
    console.log("\nNo rows generated.");
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
