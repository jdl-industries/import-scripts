#!/usr/bin/env node

/**
 * Sync Shopify catalog against AccountMate -- Matrixify edition
 *
 * Shopify's native CSV import cannot set VARIANT metafields, which is where
 * dimensions, lead time, MPN and hazmat live. This targets Matrixify instead.
 *
 * Two things follow from Matrixify's `Command: MERGE` semantics:
 *
 *   1. Only the columns present in a row are touched, so rows no longer need to
 *      form complete product blocks. A single variant can be updated, or added
 *      to an existing product, on its own row.
 *   2. Output is CHANGED ROWS ONLY -- no full-catalog baseline, no superset file.
 *
 * The BASELINE must be a Matrixify export, not a Shopify admin export: the
 * native export has zero variant-metafield columns, so it cannot tell us the
 * current value of most of what we now write.
 *
 * Usage:
 *   node sync-matrixify.js <accountmate.csv> <matrixify-export.csv> [options]
 *
 * Options:
 *   --outdir <dir>   Output directory (default: ./output)
 *   --date <date>    Override the {date} stamp (default: today)
 *   --dry-run        Report only, write nothing
 *   --verbose        Per-SKU change detail
 */

import fs from "fs";
import path from "path";
import {
  ATTRIBUTE_SLOTS,
  SURCHARGE,
  PREFIX_TO_HANDLE,
  UOM_TO_SIZE,
  SKU_SUFFIX_TO_SIZE,
  SKU_SUFFIX_ORDER,
  COLOR_PATTERNS,
  COLOR_SCOPE_CONFIDENCE,
  COLOR_MAP_FILE,
  NEEDS_COLOR_PLACEHOLDER,
  NEW_PRODUCT_DEFAULTS,
  MATRIXIFY,
  MATRIXIFY_FIELD_MAP,
  MATRIXIFY_NEW_COLUMNS,
} from "./sync-config.js";

// ===========================================================================
// CSV
// ===========================================================================

function parseCSV(content) {
  const rows = [];
  let headers = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let first = true;

  const endRow = () => {
    row.push(field);
    field = "";
    if (first) {
      // Strip a UTF-8 BOM -- Matrixify exports carry one.
      headers = row.map((h, i) => (i === 0 ? h.replace(/^﻿/, "") : h).trim());
      first = false;
    } else if (row.some((f) => f !== "")) {
      const obj = {};
      headers.forEach((h, i) => (obj[h] = row[i] ?? ""));
      rows.push(obj);
    }
    row = [];
  };

  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    const next = content[i + 1];
    if (c === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i++;
      } else inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((c === "\n" || (c === "\r" && next === "\n")) && !inQuotes) {
      if (c === "\r") i++;
      endRow();
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field !== "" || row.length) endRow();
  return { headers, rows };
}

const escapeCSV = (v) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function writeCSV(file, headers, rows) {
  const lines = [
    headers.map(escapeCSV).join(","),
    ...rows.map((r) => headers.map((h) => escapeCSV(r[h] ?? "")).join(",")),
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

// ===========================================================================
// Helpers
// ===========================================================================

const normalizeSku = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");

function getAttr(row, name) {
  for (let i = 1; i <= ATTRIBUTE_SLOTS; i++) {
    if ((row[`Attribute ${i} name`] || "").trim() === name) {
      return (row[`Attribute ${i} value(s)`] || "").trim();
    }
  }
  return "";
}

const getSource = (row, source) =>
  source.attr ? getAttr(row, source.attr) : (row[source.col] || "").trim();

function isBlank(v, treatZeroAsBlank) {
  if (v === "" || v == null) return true;
  if (treatZeroAsBlank) {
    const n = parseFloat(v);
    if (Number.isFinite(n) && n === 0) return true;
  }
  return false;
}

function valuesDiffer(a, b, compare, tolerance = 0.01) {
  // Dimension metafields are JSON: {"value":9.0,"unit":"INCHES"}. The store
  // serialises 9.0 where JSON.stringify gives 9, so a string compare would mark
  // every dimension changed on every run. Compare the parsed value instead.
  if (compare === "dimension") {
    const num = (v) => {
      if (!v) return NaN;
      try {
        return parseFloat(JSON.parse(v).value);
      } catch {
        return parseFloat(v);
      }
    };
    const x = num(a);
    const y = num(b);
    if (!Number.isFinite(x)) return false;
    if (!Number.isFinite(y)) return true;
    return Math.abs(x - y) >= 0.01;
  }
  if (compare === "number") {
    const x = parseFloat(a);
    const y = parseFloat(b);
    if (!Number.isFinite(x)) return false;
    if (!Number.isFinite(y)) return true;
    return Math.abs(x - y) >= tolerance;
  }
  if (compare === "integer") {
    const x = parseInt(a, 10);
    const y = parseInt(b, 10);
    if (!Number.isFinite(x)) return false;
    if (!Number.isFinite(y)) return true;
    return x !== y;
  }
  return String(a).trim() !== String(b ?? "").trim();
}

function computePricing(amRow, { allowDefaultSurcharge = false } = {}) {
  const base = parseFloat(amRow[SURCHARGE.basePriceCol]);
  let surcharge = parseFloat(getAttr(amRow, SURCHARGE.amountAttr)) || 0;
  let defaulted = false;
  const pct = SURCHARGE.defaultPercentForNewProducts;
  if (allowDefaultSurcharge && surcharge === 0 && pct && Number.isFinite(base) && base > 0) {
    surcharge = +(base * (pct / 100)).toFixed(2);
    defaulted = surcharge > 0;
  }
  return {
    price: Number.isFinite(base) ? (base + surcharge).toFixed(2) : "",
    compareAt: surcharge > 0 ? surcharge.toFixed(2) : "",
    hasSurcharge: surcharge > 0,
    defaulted,
  };
}

// --- colour extraction (unchanged logic, see SYNC.md) ----------------------

const decodeDescription = (d) =>
  String(d || "").replace(/\\n/g, "\n").replace(/&amp;/g, "&").replace(/&quot;/g, '"');

function extractColor(shortDescription) {
  const txt = decodeDescription(shortDescription);
  if (!txt.trim()) return null;
  const specs = txt.match(/Color specs:<\/i><\/strong>\s*([^\n<]+)/i);
  const scopes = [];
  if (specs) scopes.push(["colorSpecs", specs[1].trim()]);
  scopes.push(["firstLine", txt.split(/\n/)[0]], ["fullText", txt]);
  for (const [name, scope] of scopes) {
    for (const pat of COLOR_PATTERNS) {
      const m = scope.match(pat.re);
      if (m) {
        return {
          value: pat.format(m),
          source: pat.name,
          confidence: COLOR_SCOPE_CONFIDENCE[name],
          snippet: scope.trim().slice(0, 120),
        };
      }
    }
  }
  return null;
}

const COLOR_MAP_HEADERS = [
  "SKU",
  "Confirmed Color",
  "Extracted Guess",
  "Source",
  "Confidence",
  "AccountMate Color",
  "Evidence",
];

function loadColorMap(file) {
  if (!fs.existsSync(file)) return new Map();
  const { rows } = parseCSV(fs.readFileSync(file, "utf-8"));
  const map = new Map();
  for (const r of rows) {
    const sku = normalizeSku(r.SKU);
    if (sku) map.set(sku, r);
  }
  return map;
}

/**
 * Matrixify exports populate PRODUCT-level fields only on a product's top row
 * ("Top Row" = true); variant rows leave them blank. Carry them across the
 * product so comparisons see the real current value. Without this, every
 * product metafield looks blank on variant rows and is rewritten every run --
 * 63 spurious surcharge-indicator writes in the 2026-08-28 export.
 *
 * "Variant Metafield:" columns are genuinely per-variant and are NOT carried.
 */
function hydrateBaseline(rows, headers) {
  const productCols = headers.filter(
    (h) => /^Metafield:/.test(h) || ["Title", "Body HTML", "Vendor", "Type", "Tags", "Status", "Published"].includes(h),
  );
  const carry = new Map();
  for (const r of rows) {
    const h = r["Handle"];
    if (!carry.has(h)) carry.set(h, {});
    const c = carry.get(h);
    for (const col of productCols) if ((r[col] || "").trim() !== "") c[col] = r[col];
  }
  return rows.map((r) => {
    const c = carry.get(r["Handle"]) || {};
    const out = { ...r };
    for (const col of productCols) {
      if ((out[col] || "").trim() === "" && c[col] != null) out[col] = c[col];
    }
    return out;
  });
}

// Product-level columns that must be echoed back when adding a variant to an
// existing product, because a blank cell would clear them.
const PRODUCT_LEVEL_CARRY = [
  "Title",
  "Body HTML",
  "Vendor",
  "Type",
  "Status",
  "Published",
  "Metafield: custom.compare_at_indicates_surcharge [boolean]",
];

// --- grouping --------------------------------------------------------------

function resolveHandle(sku) {
  const s = normalizeSku(sku).replace(/\s+/g, "");
  let best = null;
  for (const prefix of Object.keys(PREFIX_TO_HANDLE)) {
    const p = prefix.toUpperCase().replace(/\s+/g, "");
    if (s.startsWith(p) && (!best || p.length > best.length)) best = p;
  }
  return best ? PREFIX_TO_HANDLE[best] : null;
}

function resolveSize(sku, amRow) {
  const uom = getAttr(amRow, "Unit of Measure").toUpperCase();
  if (UOM_TO_SIZE[uom]) return { value: UOM_TO_SIZE[uom], source: "uom" };
  const s = normalizeSku(sku);
  for (const token of SKU_SUFFIX_ORDER) {
    if (s.endsWith(token.toUpperCase())) {
      return { value: SKU_SUFFIX_TO_SIZE[token], source: "sku-suffix" };
    }
  }
  return { value: "", source: "" };
}

// ===========================================================================
// Change detection
// ===========================================================================

function detectChanges(amRow, baseRow, baselineHasColumn) {
  const changes = {};
  const skipped = [];
  const ratcheted = [];
  const undiffable = [];

  for (const f of MATRIXIFY_FIELD_MAP) {
    const raw = getSource(amRow, f.source);

    if (isBlank(raw, f.treatZeroAsBlank)) {
      if (!(f.blankPolicy === "overwrite" && raw !== "")) {
        const cur = (baseRow[f.col] || "").trim();
        if (cur) skipped.push({ col: f.col, current: cur, reason: "blank in AccountMate" });
        continue;
      }
    }

    const value = f.transform ? f.transform(raw) : raw;
    if (value === "" || value == null) continue;

    // If the baseline export lacks this column we cannot know the current
    // value. MERGE makes writing it harmless, but say so rather than pretending
    // it is a detected change.
    if (!baselineHasColumn(f.col)) {
      undiffable.push(f.col);
      changes[f.col] = value;
      if (f.companions) Object.assign(changes, f.companions);
      continue;
    }

    if (!valuesDiffer(value, baseRow[f.col], f.compare, f.tolerance)) continue;

    if (f.ratchet) {
      // Establish what the store currently asserts. The primary column may be
      // empty (e.g. a metafield whose type was just changed), so every column
      // carrying the same fact is consulted. Read-only -- never written.
      //
      // A safety ratchet must be conservative: if ANY source still asserts the
      // protected value, protect. Taking the first non-empty source instead let
      // 3 SKUs through whose variant text said "No" while the product-level
      // boolean said "true".
      const norm = f.normalizeCurrent || ((v) => String(v).trim());
      const sources = [f.col, ...(f.currentFrom || [])];
      const asserted = sources
        .map((c) => norm(baseRow[c] || ""))
        .filter(Boolean);
      const protect = String(f.ratchet.protect).toLowerCase();
      const stillAsserted = asserted.some((v) => v.toLowerCase() === protect);

      if (stillAsserted && String(value).toLowerCase() !== protect) {
        ratcheted.push({
          col: f.col,
          current: sources
            .map((c) => (baseRow[c] || "").trim())
            .filter(Boolean)
            .join(" / "),
          proposed: value,
        });
        continue;
      }
    }

    changes[f.col] = value;
    if (f.companions) Object.assign(changes, f.companions);
  }

  // Pricing: base + surcharge, with the surcharge itself in compare-at.
  const pricing = computePricing(amRow);
  if (pricing.price && valuesDiffer(pricing.price, baseRow[MATRIXIFY.priceCol], "number")) {
    changes[MATRIXIFY.priceCol] = pricing.price;
  }
  if (pricing.hasSurcharge) {
    if (valuesDiffer(pricing.compareAt, baseRow[MATRIXIFY.compareAtCol], "number")) {
      changes[MATRIXIFY.compareAtCol] = pricing.compareAt;
    }
    if (
      baselineHasColumn(MATRIXIFY.indicatorCol) &&
      valuesDiffer("true", baseRow[MATRIXIFY.indicatorCol], "string")
    ) {
      changes[MATRIXIFY.indicatorCol] = "true";
    }
  }

  return { changes, skipped, ratcheted, undiffable, hasChanges: Object.keys(changes).length > 0 };
}

// ===========================================================================
// Main
// ===========================================================================

function nextVersion(outdir, date) {
  let v = 1;
  while (fs.existsSync(path.join(outdir, `updated-products-${date}-v${v}.csv`))) v++;
  return `v${v}`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length < 2) {
    console.log(`
Sync Shopify catalog against AccountMate (Matrixify format)

Usage:
  node sync-matrixify.js <accountmate.csv> <matrixify-export.csv> [options]

Options:
  --outdir <dir>   Output directory (default: ./output)
  --date <date>    Override the {date} stamp (default: today)
  --dry-run        Report only, write nothing
  --verbose        Per-SKU change detail

The baseline MUST be a Matrixify export. A Shopify admin export has no
variant-metafield columns, so most fields would have nothing to diff against.
`);
    process.exit(args.includes("--help") ? 0 : 1);
  }

  const flag = (n, d) => {
    const i = args.indexOf(n);
    return i >= 0 && args[i + 1] ? args[i + 1] : d;
  };
  const dryRun = args.includes("--dry-run");
  const verbose = args.includes("--verbose");
  const outdir = flag("--outdir", "output");
  const now = new Date();
  const date = flag(
    "--date",
    [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-"),
  );
  const positional = args.filter(
    (a, i) => !a.startsWith("--") && !["--outdir", "--date"].includes(args[i - 1]),
  );
  const [amFile, baseFile] = positional;

  const { rows: amRows } = parseCSV(fs.readFileSync(amFile, "utf-8"));
  const { headers: baseHeaders, rows: baseRowsRaw } = parseCSV(fs.readFileSync(baseFile, "utf-8"));
  const baseRows = hydrateBaseline(baseRowsRaw, baseHeaders);
  const headerSet = new Set(baseHeaders);
  const baselineHasColumn = (c) => headerSet.has(c);

  console.log(`AccountMate: ${amFile}  (${amRows.length} rows)`);
  console.log(`Baseline:    ${baseFile}  (${baseRows.length} rows)`);

  // Warn loudly if the baseline is a Shopify admin export rather than Matrixify.
  const variantMetafieldCols = baseHeaders.filter((h) => /^Variant Metafield:/.test(h));
  const looksMatrixify = baseHeaders.includes("Variant Command") || variantMetafieldCols.length > 0;
  if (!looksMatrixify) {
    console.log(
      `\n  WARNING: this baseline has no Variant Metafield columns, so it is probably` +
        `\n  a Shopify admin export. Variant metafields cannot be diffed against it and` +
        `\n  will be written unconditionally every run. Export from Matrixify instead.`,
    );
  }
  console.log(`  variant metafield columns available: ${variantMetafieldCols.length}\n`);

  // --- index --------------------------------------------------------------
  const baseBySku = new Map();
  for (const r of baseRows) {
    const sku = normalizeSku(r[MATRIXIFY.skuCol]);
    if (!sku) continue;
    if (!baseBySku.has(sku)) baseBySku.set(sku, []);
    baseBySku.get(sku).push(r);
  }

  const amBySku = new Map();
  const wsOnly = [];
  for (const r of amRows) {
    const raw = (r.SKU || "").trim();
    if (!raw) continue;
    const sku = normalizeSku(raw);
    amBySku.set(sku, r);
    if (raw !== sku && baseBySku.has(sku)) {
      const exact = baseRows.some((b) => (b[MATRIXIFY.skuCol] || "").trim() === raw);
      if (!exact) wsOnly.push(raw);
    }
  }
  if (wsOnly.length) {
    console.log(`SKUs matched only after whitespace normalization (${wsOnly.length}):`);
    wsOnly.forEach((s) => console.log(`  ${JSON.stringify(s)}`));
    console.log("  ^ worth fixing at the source in AccountMate\n");
  }

  const matched = [];
  const newSkus = [];
  for (const [sku, amRow] of amBySku) {
    if (baseBySku.has(sku)) matched.push({ sku, amRow, targets: baseBySku.get(sku) });
    else newSkus.push({ sku, amRow });
  }
  const deletedSkus = [...baseBySku.keys()].filter((s) => !amBySku.has(s));
  console.log(`Matched: ${matched.length}   New: ${newSkus.length}   Deleted: ${deletedSkus.length}\n`);

  // --- colour map ---------------------------------------------------------
  const colorMapPath = path.join(outdir, COLOR_MAP_FILE);
  const colorMap = loadColorMap(colorMapPath);
  // Seed from variants already live, where the option value is a colour.
  let seeded = 0;
  for (const r of baseRows) {
    const sku = normalizeSku(r[MATRIXIFY.skuCol]);
    if (!sku || colorMap.has(sku)) continue;
    if ((r["Option1 Name"] || "") !== "Color") continue;
    const v = (r["Option1 Value"] || "").trim();
    if (!v) continue;
    colorMap.set(sku, {
      SKU: sku,
      "Confirmed Color": v,
      "Extracted Guess": v,
      Source: "shopify-catalog",
      Confidence: "high",
      "AccountMate Color": "",
      Evidence: "Already live in Shopify",
    });
    seeded++;
  }
  let added = 0;
  for (const { sku, amRow } of newSkus) {
    if (colorMap.has(sku)) continue;
    const g = extractColor(amRow["Short description"]);
    colorMap.set(sku, {
      SKU: sku,
      "Confirmed Color": "",
      "Extracted Guess": g ? g.value : "",
      Source: g ? g.source : "",
      Confidence: g ? g.confidence : "",
      "AccountMate Color": getAttr(amRow, "Color"),
      Evidence: g ? g.snippet : decodeDescription(amRow["Short description"]).split(/\n/)[0].slice(0, 120),
    });
    added++;
  }
  const confirmed = [...colorMap.values()].filter((r) => (r["Confirmed Color"] || "").trim()).length;
  console.log(`Colour map: ${colorMap.size} entries (${seeded} seeded, ${added} newly queued)`);
  console.log(`  confirmed: ${confirmed}   pending: ${colorMap.size - confirmed}\n`);

  // --- updated ------------------------------------------------------------
  // Every column this sync is allowed to put in an output file. Because a blank
  // cell clears the field in Matrixify, the file must contain ONLY columns we
  // understand and can populate correctly -- never the full 112-column export.
  const managedColumns = [
    MATRIXIFY.priceCol,
    MATRIXIFY.compareAtCol,
    MATRIXIFY.indicatorCol,
    ...MATRIXIFY_FIELD_MAP.flatMap((f) => [f.col, ...Object.keys(f.companions || {})]),
  ].filter((c, i, a) => a.indexOf(c) === i);

  const updatedRows = [];
  const ratchetReport = [];
  const undiffableCols = new Set();
  let unchanged = 0;

  // Walk the BASELINE in its own row order, not AccountMate's.
  //
  // Matrixify requires a product's rows to be contiguous and rejects a Handle or
  // ID that reappears after other rows ("check the row sorting!"). Driving the
  // loop from AccountMate scattered a handle's rows through the file, because a
  // SKU can live under more than one handle. The Matrixify export already groups
  // handles contiguously, so mirroring its order gives correct grouping for free.
  for (const target of baseRows) {
    {
      const sku = normalizeSku(target[MATRIXIFY.skuCol]);
      const amRow = sku ? amBySku.get(sku) : null;
      if (!amRow) continue;
      const { changes, ratcheted, undiffable, hasChanges } = detectChanges(
        amRow,
        target,
        baselineHasColumn,
      );
      ratcheted.forEach((r) => ratchetReport.push({ sku, ...r }));
      undiffable.forEach((c) => undiffableCols.add(c));
      if (!hasChanges) {
        unchanged++;
        continue;
      }
      // Matrixify uses a column's VALUE if the column is present -- a blank cell
      // CLEARS the field, it does not mean "leave alone". So every managed
      // column must carry the store's current value, with changes overlaid on
      // top. `target` is the hydrated baseline row, so product-level metafields
      // hold the product's real value rather than the blank that a non-top
      // variant row would otherwise contribute.
      const row = {
        [MATRIXIFY.handleCol]: target[MATRIXIFY.handleCol],
        [MATRIXIFY.commandCol]: MATRIXIFY.command,
        [MATRIXIFY.variantCommandCol]: MATRIXIFY.command,
        [MATRIXIFY.skuCol]: target[MATRIXIFY.skuCol],
      };
      for (const col of managedColumns) {
        if (row[col] === undefined) row[col] = target[col] ?? "";
      }
      Object.assign(row, changes);
      if (target["ID"]) row["ID"] = target["ID"];
      if (target["Variant ID"]) row["Variant ID"] = target["Variant ID"];
      row.__changed = Object.keys(changes).join("; ");
      updatedRows.push(row);
      if (verbose) console.log(`  UPDATE ${sku}: ${row.__changed}`);
    }
  }

  // --- new ----------------------------------------------------------------
  const newRows = [];
  const triage = { noHandle: 0, noColor: 0, noSize: 0, handleNotInBaseline: 0 };
  let defaultedSurcharges = 0;

  for (const { sku, amRow } of newSkus) {
    const handle = resolveHandle(sku);
    const size = resolveSize(sku, amRow);
    const color = (colorMap.get(sku)?.["Confirmed Color"] || "").trim();
    const sibling = handle ? baseRows.find((r) => r[MATRIXIFY.handleCol] === handle) : null;
    // Count what actually happens: a prefix rule only helps if the product it
    // names is present in the baseline.
    if (!sibling) triage.noHandle++;
    if (!color) triage.noColor++;
    if (!size.value) triage.noSize++;
    if (handle && !sibling) triage.handleNotInBaseline++;
    const row = {
      [MATRIXIFY.commandCol]: MATRIXIFY.command,
      [MATRIXIFY.variantCommandCol]: MATRIXIFY.command,
      [MATRIXIFY.skuCol]: amRow.SKU,
    };

    if (sibling) {
      // Add as a variant of an existing product. The row needs no sibling rows,
      // but every PRODUCT-level column in the file must carry the product's
      // current value: a blank cell clears the field, so leaving Title or
      // Body HTML empty here would wipe them on 34 live products.
      row[MATRIXIFY.handleCol] = handle;
      row["Option1 Name"] = sibling["Option1 Name"] || "Color";
      row["Option1 Value"] = color || NEEDS_COLOR_PLACEHOLDER;
      row["Option2 Name"] = sibling["Option2 Name"] || "Size";
      row["Option2 Value"] = size.value || "NEEDS-SIZE";
      // `sibling` is hydrated, so these are the product's real values even when
      // the matched export row was not the product's top row.
      for (const col of PRODUCT_LEVEL_CARRY) {
        if ((row[col] ?? "") === "" && (sibling[col] ?? "") !== "") row[col] = sibling[col];
      }
    } else {
      row[MATRIXIFY.handleCol] = slugify(amRow.Name || sku);
      row["Title"] = (amRow.Name || sku).trim();
      row["Body HTML"] = amRow.Description || "";
      row["Option1 Name"] = "Title";
      row["Option1 Value"] = "Default Title";
      row["Status"] = NEW_PRODUCT_DEFAULTS.Status;
      row["Published"] = NEW_PRODUCT_DEFAULTS.Published;
      row["Vendor"] = getAttr(amRow, "Manufacturer") || NEW_PRODUCT_DEFAULTS.Vendor;
      row["Variant Taxable"] = "true";
      row["Variant Inventory Tracker"] = "shopify";
      row["Variant Inventory Policy"] = "deny";
      row["Variant Fulfillment Service"] = "manual";
      row["Variant Requires Shipping"] = "true";
    }

    for (const f of MATRIXIFY_FIELD_MAP) {
      const raw = getSource(amRow, f.source);
      if (isBlank(raw, f.treatZeroAsBlank) && f.blankPolicy !== "overwrite") continue;
      const value = f.transform ? f.transform(raw) : raw;
      if (value !== "" && value != null) {
        row[f.col] = value;
        if (f.companions) Object.assign(row, f.companions);
      }
    }

    const pricing = computePricing(amRow, { allowDefaultSurcharge: true });
    if (pricing.price) row[MATRIXIFY.priceCol] = pricing.price;
    if (pricing.hasSurcharge) {
      row[MATRIXIFY.compareAtCol] = pricing.compareAt;
      row[MATRIXIFY.indicatorCol] = "true";
    }
    if (pricing.defaulted) defaultedSurcharges++;

    row.__handleSource = sibling ? "prefix-rule" : "standalone-draft";
    row.__needsReview = [
      !handle ? "handle" : "",
      !color ? "color" : "",
      !size.value ? "size" : "",
      !pricing.price ? "price" : "",
      !row["Variant Weight"] ? "weight" : "",
    ]
      .filter(Boolean)
      .join("; ");
    newRows.push(row);
  }

  // Group the additions so each product's rows are contiguous, ordered by where
  // that product sits in the baseline. Matrixify rejects a Handle that reappears
  // after other rows, and brand-new products go last.
  const handleOrder = new Map();
  baseRows.forEach((r, i) => {
    if (!handleOrder.has(r[MATRIXIFY.handleCol])) handleOrder.set(r[MATRIXIFY.handleCol], i);
  });
  newRows.sort((a, b) => {
    const ha = a[MATRIXIFY.handleCol];
    const hb = b[MATRIXIFY.handleCol];
    if (ha === hb) return 0;
    const ia = handleOrder.has(ha) ? handleOrder.get(ha) : Infinity;
    const ib = handleOrder.has(hb) ? handleOrder.get(hb) : Infinity;
    if (ia !== ib) return ia - ib;
    return ha < hb ? -1 : 1; // stable grouping for brand-new handles
  });

  // --- deleted ------------------------------------------------------------
  const deletedRows = [];
  for (const sku of deletedSkus) {
    for (const r of baseBySku.get(sku)) {
      deletedRows.push({
        "Variant SKU": r[MATRIXIFY.skuCol],
        Handle: r[MATRIXIFY.handleCol],
        Title: r["Title"] || "",
        Status: r["Status"] || "",
        "Variant Price": r[MATRIXIFY.priceCol] || "",
        "Variant Inventory Qty": r["Variant Inventory Qty"] || "",
        Reason: "Not present in AccountMate export",
        "Suggested Action": "Mark inactive",
      });
    }
  }

  // --- duplicate option combinations --------------------------------------
  const combos = new Map();
  for (const r of newRows) {
    if (r.__handleSource !== "prefix-rule") continue;
    const k = `${r[MATRIXIFY.handleCol]}||${r["Option1 Value"] || ""}/${r["Option2 Value"] || ""}`;
    if (!combos.has(k)) combos.set(k, []);
    combos.get(k).push(r[MATRIXIFY.skuCol]);
  }
  // Existing variants of those products occupy combinations too.
  for (const r of baseRows) {
    const h = r[MATRIXIFY.handleCol];
    const k = `${h}||${r["Option1 Value"] || ""}/${r["Option2 Value"] || ""}`;
    if (combos.has(k)) combos.get(k).push(r[MATRIXIFY.skuCol] + " (existing)");
  }
  const dupCombos = [...combos.entries()].filter(([, v]) => v.length > 1);

  // --- report -------------------------------------------------------------
  console.log("--- Summary ---");
  console.log(`  deleted-products : ${deletedRows.length} rows`);
  console.log(`  updated-products : ${updatedRows.length} changed rows (${unchanged} variants unchanged)`);
  console.log(`  new-products     : ${newRows.length} rows`);
  console.log(`      into existing products : ${newRows.length - triage.noHandle}`);
  console.log(`      standalone drafts      : ${triage.noHandle}`);
  console.log(`      awaiting a colour      : ${triage.noColor}`);
  if (triage.handleNotInBaseline) {
    console.log(
      `      prefix rule matched but that product is not in the baseline: ${triage.handleNotInBaseline}` +
        `\n      (emitted as standalone drafts -- is the baseline a full export?)`,
    );
  }
  if (defaultedSurcharges) {
    console.log(`      surcharge defaulted to ${SURCHARGE.defaultPercentForNewProducts}% : ${defaultedSurcharges}`);
  }

  if (undiffableCols.size) {
    console.log(`\n  Columns absent from the baseline (written unconditionally):`);
    [...undiffableCols].forEach((c) => console.log(`    ${c}`));
    console.log(`    Export from Matrixify so these can be diffed.`);
  }

  if (ratchetReport.length) {
    const skus = [...new Set(ratchetReport.map((r) => r.sku))];
    console.log(`\n  BLOCKED by safety ratchet (hazmat TRUE -> FALSE): ${skus.length} SKU(s)`);
    skus.forEach((s) => console.log(`    ${s}`));
  }

  if (dupCombos.length) {
    console.log(`\n  Duplicate option combinations -- Shopify rejects these:`);
    dupCombos.slice(0, 8).forEach(([k, v]) => {
      const [h, c] = k.split("||");
      console.log(`    ${h}`);
      console.log(`      "${c}" claimed by: ${v.join("  |  ")}`);
    });
  }

  if (dryRun) {
    console.log("\n[dry run] nothing written.");
    return;
  }

  // --- write --------------------------------------------------------------
  fs.mkdirSync(outdir, { recursive: true });
  const version = nextVersion(outdir, date);

  const idCols = ["ID", "Variant ID"];
  const mappedCols = MATRIXIFY_FIELD_MAP.flatMap((f) => [
    f.col,
    ...Object.keys(f.companions || {}),
  ]);
  const updHeaders = [
    ...idCols,
    MATRIXIFY.handleCol,
    MATRIXIFY.commandCol,
    MATRIXIFY.variantCommandCol,
    MATRIXIFY.skuCol,
    MATRIXIFY.priceCol,
    MATRIXIFY.compareAtCol,
    MATRIXIFY.indicatorCol,
    ...mappedCols,
  ].filter((c, i, a) => a.indexOf(c) === i);

  const newHeaders = [
    MATRIXIFY.handleCol,
    MATRIXIFY.commandCol,
    MATRIXIFY.variantCommandCol,
    MATRIXIFY.skuCol,
    ...MATRIXIFY_NEW_COLUMNS,
    MATRIXIFY.priceCol,
    MATRIXIFY.compareAtCol,
    MATRIXIFY.indicatorCol,
    ...mappedCols,
  ].filter((c, i, a) => a.indexOf(c) === i);

  const strip = (rows, headers) =>
    rows.map((r) => {
      const o = {};
      headers.forEach((h) => (o[h] = r[h] ?? ""));
      return o;
    });

  writeCSV(
    path.join(outdir, `deleted-products-${date}-${version}.csv`),
    ["Variant SKU", "Handle", "Title", "Status", "Variant Price", "Variant Inventory Qty", "Reason", "Suggested Action"],
    deletedRows,
  );
  writeCSV(path.join(outdir, `updated-products-${date}-${version}.csv`), updHeaders, strip(updatedRows, updHeaders));
  writeCSV(path.join(outdir, `new-products-${date}-${version}.csv`), newHeaders, strip(newRows, newHeaders));
  writeCSV(
    path.join(outdir, `sync-report-${date}-${version}.csv`),
    ["File", "Variant SKU", "Handle", "Changed Fields", "Needs Review", "Handle Source"],
    [
      ...updatedRows.map((r) => ({
        File: "updated",
        "Variant SKU": r[MATRIXIFY.skuCol],
        Handle: r[MATRIXIFY.handleCol],
        "Changed Fields": r.__changed,
        "Needs Review": "",
        "Handle Source": "",
      })),
      ...newRows.map((r) => ({
        File: "new",
        "Variant SKU": r[MATRIXIFY.skuCol],
        Handle: r[MATRIXIFY.handleCol],
        "Changed Fields": "",
        "Needs Review": r.__needsReview,
        "Handle Source": r.__handleSource,
      })),
    ],
  );
  writeCSV(colorMapPath, COLOR_MAP_HEADERS, [...colorMap.values()]);

  console.log(`\nWrote to ${outdir}/`);
  console.log(`  updated-products-${date}-${version}.csv  (${updatedRows.length} rows, Command: MERGE)`);
  console.log(`  new-products-${date}-${version}.csv      (${newRows.length} rows)`);
  console.log(`  deleted-products-${date}-${version}.csv  (${deletedRows.length} rows)`);
  console.log(`  sync-report-${date}-${version}.csv`);
  console.log(`  ${COLOR_MAP_FILE}`);
  console.log(
    `\nEvery row is Command: MERGE -- only the columns present are touched, so these` +
      `\nfiles are independent and no longer need complete product blocks.`,
  );
}

const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);

main();
