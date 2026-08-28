#!/usr/bin/env node

import fs from "fs";

// --- SKU Normalization for fuzzy matching ---
function normalizeSKU(sku) {
  if (!sku) return "";
  let normalized = sku
    .toUpperCase()
    .replace(/\s+/g, "")        // Remove all spaces
    .replace(/^HZK/, "HZ")      // Normalize HZK -> HZ
    .replace(/-TI$/, "-T1")     // Normalize -TI -> -T1
    .replace(/-TI-/, "-T1-")    // Normalize -TI- -> -T1- (mid-string)
    .replace(/-T2$/, "-T1")     // Normalize -T2 -> -T1
    .replace(/-T2-/, "-T1-")    // Normalize -T2- -> -T1- (mid-string)
    .replace(/_/g, "-");        // Normalize underscores to hyphens
  return normalized;
}

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
      } else if (currentRow.length > 0) {
        rows.push(currentRow);
      }
      currentRow = [];
    } else if (char !== "\r") {
      currentField += char;
    }
  }

  // Handle last row if no trailing newline
  if (currentRow.length > 0 || currentField) {
    currentRow.push(currentField);
    if (currentRow.length > 0) {
      rows.push(currentRow);
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
  const headerLine = headers.map(escapeCSVValue).join(",");
  const dataLines = rows.map((row) => row.map(escapeCSVValue).join(","));
  const content = [headerLine, ...dataLines].join("\n");
  fs.writeFileSync(filePath, content, "utf-8");
}

// --- Main ---
function main() {
  // Read input files
  const productsContent = fs.readFileSync("products_export_2026-06-16.csv", "utf-8");
  const accountMateContent = fs.readFileSync("AccountMate-Export-2026-05-11.csv", "utf-8");

  // Parse CSVs
  const products = parseCSV(productsContent);
  const accountMate = parseCSV(accountMateContent);

  // Find column indices in AccountMate file
  const amSkuIdx = accountMate.headers.indexOf("SKU");
  const amShortDescIdx = accountMate.headers.indexOf("Short description");
  const amDescIdx = accountMate.headers.indexOf("Description");

  if (amSkuIdx === -1 || amShortDescIdx === -1 || amDescIdx === -1) {
    console.error("Could not find required columns in AccountMate file.");
    console.error("Headers found:", accountMate.headers);
    process.exit(1);
  }

  // Build lookup map: normalized SKU -> { shortDesc, desc, originalSku }
  const amLookup = new Map();
  for (const row of accountMate.rows) {
    const sku = row[amSkuIdx];
    if (sku) {
      const normalizedSku = normalizeSKU(sku);
      amLookup.set(normalizedSku, {
        shortDesc: row[amShortDescIdx] || "",
        desc: row[amDescIdx] || "",
        originalSku: sku,
      });
    }
  }

  console.log(`Loaded ${amLookup.size} SKUs from AccountMate export.`);

  // Find column indices in products file
  const prodSkuIdx = products.headers.indexOf("Variant SKU");
  const bodyHtmlIdx = products.headers.indexOf("Body (HTML)");

  if (prodSkuIdx === -1 || bodyHtmlIdx === -1) {
    console.error("Could not find required columns in products file.");
    console.error("Headers found:", products.headers);
    process.exit(1);
  }

  // Build new headers: insert two columns after "Body (HTML)"
  const newHeaders = [
    ...products.headers.slice(0, bodyHtmlIdx + 1),
    "Original Short Description",
    "Original Description",
    ...products.headers.slice(bodyHtmlIdx + 1),
  ];

  // Build new rows with merged data
  let matchCount = 0;
  let noMatchCount = 0;
  const unmatchedSkus = [];

  const newRows = products.rows.map((row) => {
    const sku = row[prodSkuIdx];
    const normalizedSku = normalizeSKU(sku);
    const amData = amLookup.get(normalizedSku);

    let shortDesc = "";
    let desc = "";

    if (amData) {
      shortDesc = amData.shortDesc;
      desc = amData.desc;
      matchCount++;
    } else {
      noMatchCount++;
      unmatchedSkus.push(sku);
    }

    // Insert the two new columns after Body (HTML)
    return [
      ...row.slice(0, bodyHtmlIdx + 1),
      shortDesc,
      desc,
      ...row.slice(bodyHtmlIdx + 1),
    ];
  });

  console.log(`Matched ${matchCount} rows, ${noMatchCount} rows had no match.`);

  if (unmatchedSkus.length > 0) {
    console.log("\nUnmatched SKUs:");
    unmatchedSkus.forEach((sku) => console.log(`  ${sku}`));
  }

  // Write output file
  const outputPath = "products_with_descriptions.csv";
  writeCSV(outputPath, newHeaders, newRows);
  console.log(`Output written to ${outputPath}`);
}

main();
