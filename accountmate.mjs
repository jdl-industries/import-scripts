/**
 * Reader for AccountMate exports, isolating the two file formats.
 *
 * The 2026-09-04 export replaced 120 columns (including 19 generic
 * "Attribute N name/value(s)" tuples) with 40 named ones, and added dedicated
 * QPL / Meets specs / Color specs / NSN / Series fields. Everything downstream
 * asks for a CANONICAL field name and neither knows nor cares which format the
 * file is in.
 *
 * ---------------------------------------------------------------------------
 * SOURCE-FORMAT BUGS worked around here. These are defects in the export, not
 * in Shopify or this tooling, and should be raised with whoever generates it:
 *
 *   1. Every data row is malformed CSV: the Tier price field is wrapped in
 *      DOUBLED quotes -- ,""1:93.00,13:78.00",  -- which standard parsers
 *      reject outright ("Invalid Closing Quote").
 *   2. HTML entities are TRIPLE encoded ("&amp;amp;" for "&"), up from double
 *      in the previous format.
 *
 * Remove repairCsv() and the extra decode passes once the export is fixed.
 * ---------------------------------------------------------------------------
 */

import fs from "fs";
import { parse } from "csv-parse/sync";

/** Canonical field -> column name, per format. */
const NAMED_FORMAT = {
  sku: "SKU",
  series: "Series",
  manufacturer: "Manufacturer",
  vendorPartNumber: "Vendor part number",
  nsn: "NSN number",
  shortDescription: "Short description",
  description: "Description",
  color: "Color",
  colorSpecs: "Color specs",
  qpl: "QPL",
  meetsSpecs: "Meets specs",
  leadTime: "Lead time",
  onHand: "On hand",
  weight: "Weight (lbs)",
  length: "Length (in)",
  width: "Width (in)",
  height: "Height (in)",
  price: "Price",
  categories: "Categories",
  tierPrice: "Tier price",
  image: "Image",
  unitOfMeasure: "Unit of measure",
  aviation: "Aviation",
  marine: "Marine",
  industrial: "Industrial",
  hazardous: "Hazardous",
  needsSpecialPkg: "Needs special pkg",
  needsDryIce: "Needs dry ice",
  family: "Family",
  surchargePercent: "Surcharge percent",
  surchargeAmount: "Surcharge amount",
  cost: "Cost",
};

/** Legacy format: plain columns, plus values held in Attribute N tuples. */
const LEGACY_COLUMNS = {
  sku: "SKU",
  shortDescription: "Short description",
  description: "Description",
  onHand: "Stock",
  weight: "Weight (lbs)",
  length: "Length (in)",
  width: "Width (in)",
  height: "Height (in)",
  price: "Regular price",
  categories: "Categories",
  tierPrice: "Fixed Tiered Prices",
  image: "Images",
};

const LEGACY_ATTRIBUTES = {
  manufacturer: "Manufacturer",
  vendorPartNumber: "Vendor SKU",
  color: "Color",
  leadTime: "Lead time",
  unitOfMeasure: "Unit of Measure",
  aviation: "Aviation",
  marine: "Marine",
  industrial: "Industrial",
  hazardous: "Hazardous",
  needsSpecialPkg: "Special packaging",
  needsDryIce: "Ship frozen",
  family: "Family",
  surchargePercent: "Surcharge percent",
  surchargeAmount: "Surcharge amount",
  cost: "Cost",
};

const ATTRIBUTE_SLOTS = 19;

/**
 * Repair the doubled-quote fields the export emits, so a standard CSV parser
 * can read the file. ,""a,b"", -> ,"a,b",
 */
function repairCsv(text) {
  return text.replace(/,""([^\n]*?)"",/g, (_m, inner) => `,"${inner.replace(/"/g, '""')}",`);
}

/** Decode HTML entities repeatedly; the source is double- to triple-encoded. */
export function decodeEntities(t) {
  let out = String(t ?? "").replace(/\\n/g, "\n");
  let prev;
  do {
    prev = out;
    out = out
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  } while (out !== prev);
  return out;
}

/**
 * Read an AccountMate export. Returns { rows, format, get } where `get(row,
 * field)` resolves a canonical field name in either format.
 */
export function readAccountMate(file) {
  const text = repairCsv(fs.readFileSync(file, "utf-8"));
  const rows = parse(text, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    bom: true,
  });
  const cols = new Set(Object.keys(rows[0] || {}));
  // The named format is identified by columns that never existed before.
  const format = cols.has("Vendor part number") && cols.has("QPL") ? "named" : "legacy";

  function get(row, field) {
    if (!row) return "";
    if (format === "named") {
      const col = NAMED_FORMAT[field];
      return col ? String(row[col] ?? "").trim() : "";
    }
    const col = LEGACY_COLUMNS[field];
    if (col) return String(row[col] ?? "").trim();
    const attr = LEGACY_ATTRIBUTES[field];
    if (!attr) return "";
    for (let i = 1; i <= ATTRIBUTE_SLOTS; i++) {
      if (String(row[`Attribute ${i} name`] ?? "").trim() === attr) {
        return String(row[`Attribute ${i} value(s)`] ?? "").trim();
      }
    }
    return "";
  }

  return { rows, format, get };
}

/**
 * Specification lists. The named format has dedicated columns; the legacy
 * format required regex-parsing them out of the description HTML.
 */
export function specStrings(row, get, format) {
  const split = (v) =>
    decodeEntities(v)
      .split(";")
      .map((x) => x.trim())
      .filter((x) => x.length > 2);

  if (format === "named") {
    return { approved: split(get(row, "qpl")), meets: split(get(row, "meetsSpecs")) };
  }
  const text = [get(row, "shortDescription"), get(row, "description")].map(decodeEntities).join("\n");
  const block = (label) => {
    const m = text.match(new RegExp(`${label}:</i></strong>\\s*([^\\n<]+)`, "i"));
    return m ? split(m[1]) : [];
  };
  return { approved: block("QPL"), meets: block("Meets the requirements of") };
}

/**
 * Lead time as an integer. The named format supplies a bare number; the legacy
 * one wrote "3 business days".
 */
export function leadTimeDays(row, get) {
  const m = String(get(row, "leadTime")).match(/(\d+)/);
  return m ? m[1] : "";
}

/** Tier price with the export's stray wrapper quotes removed. */
export function tierPrice(row, get) {
  return String(get(row, "tierPrice")).replace(/^"+|"+$/g, "").trim();
}
