#!/usr/bin/env node

import fs from "fs";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

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
      currentRow.push(currentField.trim());
      currentField = "";
    } else if (
      (char === "\n" || (char === "\r" && nextChar === "\n")) &&
      !inQuotes
    ) {
      if (char === "\r") i++;
      currentRow.push(currentField.trim());
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
    currentRow.push(currentField.trim());
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

// --- Helper Functions ---
function stripHTML(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCase(str) {
  return str.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function extractQPL(text) {
  const match = text.match(
    /QPL:<\/i><\/strong>\s*(MIL-[A-Z]+-\d+[A-Z]?(?:[,\s]+(?:TYPE|TY)\s+[IVX\d]+)?(?:[,\s]+(?:CLASS|CL|CLS)\s+[A-Z\d]+)?)/i,
  );
  if (match) {
    let qpl = match[1]
      .replace(/\s+/g, " ")
      .replace(/\bTY\b/gi, "TYPE")
      .replace(/\bCL\b/gi, "CLASS")
      .replace(/\bCLS\b/gi, "CLASS")
      .trim();
    return qpl;
  }
  return "";
}

function extractMilSpec(text) {
  const match = text.match(
    /MIL-(?:PRF|DTL|SPEC|C)-\d+[A-Z]?(?:\s*,?\s*(?:TYPE|TY)\s+[IVX\d]+(?:\s*&\s*[IVX\d]+)?)?(?:\s*,?\s*(?:CLASS|CL|CLS)\s+[A-Z0-9]+)?/i,
  );
  if (match) {
    let spec = match[0]
      .replace(/\bTY\b/gi, "Type")
      .replace(/\bCL\b/gi, "Class")
      .replace(/\bCLS\b/gi, "Class")
      .replace(/\s+/g, " ")
      .trim();
    return spec;
  }
  return "";
}

function extractNSN(text) {
  const match = text.match(/(\d{4}-\d{2}-\d{3}-\d{4})/);
  return match ? match[1] : "";
}

function extractCompliance(text) {
  const certifications = [];
  const patterns = [
    /BMS\d+-\d+[^;,\s\n<]*/gi,
    /MEP\s*\d+-\d+[^;,\s\n<]*/gi,
    /FMS-\d+[^;,\s\n<]*/gi,
    /LMCO\s+[A-Z]+[^;,\n<]*/gi,
  ];

  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) {
      certifications.push(...matches.map((m) => m.trim()));
    }
  }

  return [...new Set(certifications)].join("; ");
}

function parseLeadTime(leadTime) {
  if (!leadTime) return "";
  if (leadTime.toLowerCase().includes("stock")) return "0";
  const match = leadTime.match(/(\d+)/);
  return match ? match[1] : "";
}

function generateURLHandle(manufacturer, partNumber, milSpec) {
  let handle = `${manufacturer}-${partNumber}`;
  if (milSpec) {
    handle += `-${milSpec}`;
  }
  return handle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 100);
}

function getAttributeValue(row, attrName) {
  for (let i = 1; i <= 16; i++) {
    const nameCol = `Attribute ${i} name`;
    const valueCol = `Attribute ${i} value(s)`;
    if (row[nameCol] === attrName) {
      return row[valueCol] || "";
    }
  }
  return "";
}

// --- LLM Text Generation ---
async function generateProductText(productData) {
  const prompt = `You are writing product catalog content for an aerospace/industrial coatings e-commerce store.

Given this product data:
- SKU: ${productData.sku}
- Manufacturer: ${productData.manufacturer}
- Part Number(s): ${productData.vendorSKU}
- Color: ${productData.color}
- Original Short Description: ${productData.shortDesc}
- Original Description: ${productData.description}
- Military Spec: ${productData.milSpec || "None"}
- QPL Status: ${productData.qpl ? "Yes - " + productData.qpl : "No"}
- Hazardous: ${productData.hazardous}

Generate the following (respond ONLY with valid JSON, no markdown):

{
  "title": "Product title format: {Manufacturer} {Part Number}, {Short Product Type Description}, {MIL-SPEC} {(QPL) if applicable}. Max 100 chars. Title-case manufacturer.",
  "description": "Professional, SEO-optimized product description. 2-3 sentences covering key features, applications, and compliance. Start with manufacturer name. No HTML.",
  "pageTitle": "Shortened SEO title, max 70 characters. Include manufacturer, part number, key spec.",
  "metaDescription": "Concise SEO meta description, max 160 characters. Focus on key product benefits and specifications."
}`;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].text.trim();
    // Parse JSON response
    const parsed = JSON.parse(text);
    return parsed;
  } catch (error) {
    console.error(`  Error generating text: ${error.message}`);
    // Fallback to basic template
    return {
      title: `${titleCase(productData.manufacturer)} ${productData.vendorSKU}, ${productData.milSpec || "Industrial Coating"}`,
      description: `${titleCase(productData.manufacturer)}'s ${productData.color || ""} ${productData.vendorSKU}. ${stripHTML(productData.shortDesc)}`,
      pageTitle: `${titleCase(productData.manufacturer)} ${productData.vendorSKU.split(/[\/\s]/)[0]}`,
      metaDescription: `${titleCase(productData.manufacturer)} ${productData.vendorSKU}. ${productData.milSpec || "Industrial coating"}.`,
    };
  }
}

async function transformRow(row) {
  const sku = row["SKU"] || "";
  const shortDesc = row["Short description"] || "";
  const description = row["Description"] || "";
  const regularPrice = row["Regular price"] || "";
  const weight = row["Weight (lbs)"] || "";
  const length = row["Length (in)"] || "";
  const width = row["Width (in)"] || "";
  const height = row["Height (in)"] || "";

  // Get attributes
  const color = getAttributeValue(row, "Color");
  const manufacturer = getAttributeValue(row, "Manufacturer");
  const vendorSKU = getAttributeValue(row, "Vendor SKU");
  const hazardous = getAttributeValue(row, "Hazardous");
  const aviation = getAttributeValue(row, "Aviation");
  const marine = getAttributeValue(row, "Marine");
  const industrial = getAttributeValue(row, "Industrial");
  const specialPackaging = getAttributeValue(row, "Special packaging");
  const leadTime = getAttributeValue(row, "Lead time");
  const barcode1 = getAttributeValue(row, "Barcode1");

  // Extract specs from HTML
  const combinedText = shortDesc + " " + description;
  const qpl = extractQPL(combinedText);
  const milSpec = extractMilSpec(combinedText);
  const nsn = extractNSN(barcode1 + " " + combinedText);
  const compliance = extractCompliance(combinedText);

  // Generate text using LLM
  const generatedText = await generateProductText({
    sku,
    manufacturer,
    vendorSKU,
    color,
    shortDesc: stripHTML(shortDesc),
    description: stripHTML(description),
    milSpec,
    qpl,
    hazardous,
  });

  // URL handle
  const urlHandle = generateURLHandle(
    manufacturer,
    vendorSKU.split(/[\/\s+]/)[0],
    milSpec,
  );

  // Is Hazmat
  const isHazmat = hazardous.toLowerCase() === "yes" ? "true" : "false";

  // Lead time days
  const leadTimeDays = parseLeadTime(leadTime);

  return {
    SKU: sku,
    Title: generatedText.title,
    Description: generatedText.description,
    "Regular Price": regularPrice,
    Weight: weight,
    Length: length,
    Width: width,
    Height: height,
    Aviation: aviation,
    Marine: marine,
    Industrial: industrial,
    "Special Packaging": specialPackaging,
    Category: "Manufacturing",
    "Is Hazmat": isHazmat,
    "Manufacturer Part Number": vendorSKU,
    QPL: qpl,
    NSN: nsn,
    "Military Specification": milSpec,
    "Compliance and Certifications": compliance,
    "Lead Time": leadTimeDays,
    "Page Title": generatedText.pageTitle,
    "Meta Description": generatedText.metaDescription,
    "URL Handle": urlHandle,
  };
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

function writeCSV(filePath, rows) {
  const headers = [
    "SKU",
    "Title",
    "Description",
    "Regular Price",
    "Weight",
    "Length",
    "Width",
    "Height",
    "Aviation",
    "Marine",
    "Industrial",
    "Special Packaging",
    "Category",
    "Is Hazmat",
    "Manufacturer Part Number",
    "QPL",
    "NSN",
    "Military Specification",
    "Compliance and Certifications",
    "Lead Time",
    "Page Title",
    "Meta Description",
    "URL Handle",
  ];

  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((h) => escapeCSVValue(row[h])).join(",")),
  ];

  fs.writeFileSync(filePath, lines.join("\n") + "\n");
}

// --- Main ---
async function main() {
  const inputFile = process.argv[2] || "missing_products.csv";
  const outputFile = process.argv[3] || "new_products.csv";

  console.log(`Reading: ${inputFile}`);
  const content = fs.readFileSync(inputFile, "utf-8");
  const { rows } = parseCSV(content);

  console.log(
    `Transforming ${rows.length} products with LLM-generated descriptions...\n`,
  );

  const transformed = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const sku = row["SKU"] || `Row ${i + 1}`;
    process.stdout.write(`[${i + 1}/${rows.length}] Processing ${sku}...`);

    const result = await transformRow(row);
    transformed.push(result);

    console.log(" done");

    // Small delay to avoid rate limiting
    if (i < rows.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  console.log(`\nWriting: ${outputFile}`);
  writeCSV(outputFile, transformed);

  console.log("Done!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
