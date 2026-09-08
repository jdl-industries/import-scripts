#!/usr/bin/env node

/**
 * Sync Shopify catalog against AccountMate
 *
 * Joins an AccountMate export and a Shopify export on SKU and emits three
 * files plus a persistent colour map:
 *
 *   deleted-products-{date}-{v}.csv  SKUs in Shopify but not AccountMate,
 *                                    plus shadowed legacy duplicate products
 *   updated-products-{date}-{v}.csv  SKUs in both, Shopify format, changed
 *                                    fields only, allow-listed columns only
 *   new-products-{date}-{v}.csv      SKUs in AccountMate but not Shopify,
 *                                    grouped into existing products where the
 *                                    prefix rules resolve
 *   color-map.csv                    review queue of SKU -> Shopify colour code
 *
 * Usage:
 *   node sync-catalog.js <accountmate.csv> <shopify-export.csv> [options]
 *
 * Options:
 *   --outdir <dir>   Output directory (default: ./output)
 *   --date <date>    Override the {date} stamp (default: today, YYYY-MM-DD)
 *   --dry-run        Report only; write nothing except nothing at all
 *   --verbose        Per-SKU change detail
 */

import fs from "fs";
import path from "path";
import {
  ATTRIBUTE_SLOTS,
  FIELD_MAP,
  UPDATABLE_COLUMNS,
  SURCHARGE,
  PREFIX_TO_HANDLE,
  UOM_TO_SIZE,
  SKU_SUFFIX_TO_SIZE,
  SKU_SUFFIX_ORDER,
  COLOR_PATTERNS,
  COLOR_SCOPE_CONFIDENCE,
  COLOR_MAP_FILE,
  NEEDS_COLOR_PLACEHOLDER,
  CONSOLIDATED_TAG,
  NEW_PRODUCT_DEFAULTS,
  PRODUCT_METAFIELD_PATTERN,
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
      headers = row.map((h) => h.trim());
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

function escapeCSV(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

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

/** Both systems carry inconsistent internal whitespace and casing in SKUs. */
function normalizeSku(s) {
  return (s || "").trim().toUpperCase().replace(/\s+/g, " ");
}

/** Resolve an AccountMate "Attribute N" pair by NAME rather than position. */
function getAttr(row, name) {
  for (let i = 1; i <= ATTRIBUTE_SLOTS; i++) {
    if ((row[`Attribute ${i} name`] || "").trim() === name) {
      return (row[`Attribute ${i} value(s)`] || "").trim();
    }
  }
  return "";
}

function getSource(row, source) {
  return source.attr
    ? getAttr(row, source.attr)
    : (row[source.col] || "").trim();
}

function isBlank(v, treatZeroAsBlank) {
  if (v === "" || v == null) return true;
  if (treatZeroAsBlank) {
    const n = parseFloat(v);
    if (Number.isFinite(n) && n === 0) return true;
  }
  return false;
}

function valuesDiffer(a, b, compare, tolerance = 0.01) {
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

/**
 * A Shopify export only populates product-level fields on the FIRST row of each
 * product; subsequent variant rows leave them blank. Carry them forward so every
 * row knows its own product's title, tags, options and status.
 */
const PRODUCT_LEVEL_BASE = [
  "Title",
  "Body (HTML)",
  "Vendor",
  "Product Category",
  "Type",
  "Tags",
  "Published",
  "Option1 Name",
  "Option2 Name",
  "Option3 Name",
  "Status",
  "SEO Title",
  "SEO Description",
];

/** Product-level columns = the fixed list above plus every product metafield. */
function productLevelColumns(headers) {
  return [
    ...PRODUCT_LEVEL_BASE.filter((c) => headers.includes(c)),
    ...headers.filter((h) => PRODUCT_METAFIELD_PATTERN.test(h)),
  ];
}

function hydrateShopifyRows(rows, headers) {
  const cols = productLevelColumns(headers);
  const byHandle = new Map();
  for (const r of rows) {
    if (!byHandle.has(r.Handle)) byHandle.set(r.Handle, {});
    const carry = byHandle.get(r.Handle);
    for (const c of cols) {
      if ((r[c] || "").trim() !== "") carry[c] = r[c];
    }
  }
  return rows.map((r) => {
    const carry = byHandle.get(r.Handle) || {};
    const out = { ...r };
    for (const c of cols) {
      if ((out[c] || "").trim() === "" && carry[c] != null) out[c] = carry[c];
    }
    // Keep the untouched original. Hydrated values are for COMPARISON only --
    // emitting them would fill in product-level fields on variant rows that were
    // deliberately blank in the export, changing the file's shape.
    out.__raw = r;
    return out;
  });
}

// ===========================================================================
// Colour extraction
// ===========================================================================

function decodeDescription(desc) {
  return String(desc || "")
    .replace(/\\n/g, "\n")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');
}

/**
 * Pull a Shopify-shaped colour code out of an AccountMate short description.
 * Returns { value, source, confidence, snippet } or null.
 *
 * Measured on the live catalog: 78% coverage, 92% precision. Precision is not
 * 100% -- results are queued in color-map.csv for confirmation, never trusted
 * directly into an import file.
 */
function extractColor(shortDescription) {
  const txt = decodeDescription(shortDescription);
  if (!txt.trim()) return null;

  const specsMatch = txt.match(/Color specs:<\/i><\/strong>\s*([^\n<]+)/i);
  const scopes = [];
  if (specsMatch) scopes.push(["colorSpecs", specsMatch[1].trim()]);
  scopes.push(["firstLine", txt.split(/\n/)[0]]);
  scopes.push(["fullText", txt]);

  for (const [scopeName, scope] of scopes) {
    for (const pat of COLOR_PATTERNS) {
      const m = scope.match(pat.re);
      if (m) {
        return {
          value: pat.format(m),
          source: pat.name,
          confidence: COLOR_SCOPE_CONFIDENCE[scopeName],
          snippet: scope.trim().slice(0, 120),
        };
      }
    }
  }
  return null;
}

// ===========================================================================
// Colour map (persistent review queue)
// ===========================================================================

const COLOR_MAP_HEADERS = [
  "SKU",
  "Confirmed Color", // <- the human fills / corrects this
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
 * Merge freshly-seen SKUs into the colour map, preserving any value the human
 * has already confirmed. Returns { map, added, confirmed, pending }.
 */
function mergeColorMap(existing, newSkuRows) {
  const map = new Map(existing);
  let added = 0;

  for (const { sku, amRow } of newSkuRows) {
    if (map.has(sku)) continue;
    const guess = extractColor(amRow["Short description"]);
    map.set(sku, {
      SKU: sku,
      "Confirmed Color": "",
      "Extracted Guess": guess ? guess.value : "",
      Source: guess ? guess.source : "",
      Confidence: guess ? guess.confidence : "",
      "AccountMate Color": getAttr(amRow, "Color"),
      Evidence: guess ? guess.snippet : decodeDescription(amRow["Short description"]).split(/\n/)[0].slice(0, 120),
    });
    added++;
  }

  let confirmed = 0;
  for (const r of map.values()) {
    if ((r["Confirmed Color"] || "").trim()) confirmed++;
  }
  return { map, added, confirmed, pending: map.size - confirmed };
}

/** Seed the colour map from variants already live in Shopify -- these are known-good. */
function seedFromCatalog(map, shopifyRows) {
  let seeded = 0;
  for (const r of shopifyRows) {
    const sku = normalizeSku(r["Variant SKU"]);
    if (!sku || map.has(sku)) continue;
    if ((r["Option1 Name"] || "") !== "Color") continue;
    const val = (r["Option1 Value"] || "").trim();
    if (!val) continue;
    map.set(sku, {
      SKU: sku,
      "Confirmed Color": val,
      "Extracted Guess": val,
      Source: "shopify-catalog",
      Confidence: "high",
      "AccountMate Color": "",
      Evidence: "Already live in Shopify",
    });
    seeded++;
  }
  return seeded;
}

// ===========================================================================
// Grouping
// ===========================================================================

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
// Update detection
// ===========================================================================

/**
 * Compare one AccountMate row against one Shopify variant row.
 *
 * `productAgreement` maps a product-scoped column to either the single value all
 * variants of that product agree on, or the sentinel CONFLICT. Product-scoped
 * fields are only written when the whole product agrees and only on the
 * product's first emitted row.
 */
const CONFLICT = Symbol("conflict");

/**
 * Shopify pricing derived from AccountMate, in one place so the update path and
 * the new-product path can never drift apart.
 *
 *   Variant Price           = Regular price + Surcharge amount
 *   Variant Compare At Price = Surcharge amount   (only when there is one)
 *   surcharge indicator      = TRUE               (only when there is one)
 */
function computePricing(amRow, { allowDefaultSurcharge = false } = {}) {
  const base = parseFloat(amRow[SURCHARGE.basePriceCol]);
  let surcharge = parseFloat(getAttr(amRow, SURCHARGE.amountAttr)) || 0;
  let defaulted = false;

  // AccountMate leaves surcharge at 0.00 on newly-added items. For NEW products
  // only, fall back to the catalog-standard rate so they carry the same pricing
  // convention as the rest of the catalog. Existing products always use what
  // AccountMate reports.
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

function detectChanges(amRow, shopifyRow, { productAgreement, emitProductFields }) {
  const changes = {};
  const skipped = [];
  const conflicts = [];
  const ratcheted = [];

  for (const f of FIELD_MAP) {
    const isProductScope = f.scope === "product";
    const raw = getSource(amRow, f.source);

    if (isBlank(raw, f.treatZeroAsBlank)) {
      // Never let a blank/zero AccountMate value clobber good Shopify data.
      if (!(f.blankPolicy === "overwrite" && raw !== "")) {
        const current = (shopifyRow[f.shopifyCol] || "").trim();
        if (current) {
          skipped.push({ col: f.shopifyCol, current, reason: "blank in AccountMate" });
        }
        continue;
      }
    }

    const value = f.transform ? f.transform(raw) : raw;
    if (value === "" || value == null) continue;

    if (isProductScope) {
      // Only the row that represents the product may carry product metafields.
      if (!emitProductFields) continue;
      const agreed = productAgreement?.get(f.shopifyCol);
      if (agreed === CONFLICT) {
        conflicts.push({ col: f.shopifyCol, reason: "variants of this product disagree" });
        continue;
      }
    }

    if (!valuesDiffer(value, shopifyRow[f.shopifyCol], f.compare, f.tolerance)) continue;

    // Safety ratchet: refuse to move a protected value away from its current
    // state (e.g. never silently clear a hazmat flag).
    if (
      f.ratchet &&
      String(shopifyRow[f.shopifyCol] || "").trim().toUpperCase() ===
        String(f.ratchet.protect).toUpperCase() &&
      String(value).toUpperCase() !== String(f.ratchet.protect).toUpperCase()
    ) {
      ratcheted.push({
        col: f.shopifyCol,
        current: shopifyRow[f.shopifyCol],
        proposed: value,
      });
      continue;
    }

    if (!UPDATABLE_COLUMNS.includes(f.shopifyCol)) {
      skipped.push({
        col: f.shopifyCol,
        current: shopifyRow[f.shopifyCol],
        reason: "not in UPDATABLE_COLUMNS",
      });
      continue;
    }
    changes[f.shopifyCol] = value;
  }

  const pricing = computePricing(amRow);
  if (pricing.price && valuesDiffer(pricing.price, shopifyRow[SURCHARGE.priceCol], "number")) {
    changes[SURCHARGE.priceCol] = pricing.price;
  }
  if (pricing.hasSurcharge) {
    if (valuesDiffer(pricing.compareAt, shopifyRow[SURCHARGE.compareAtCol], "number")) {
      changes[SURCHARGE.compareAtCol] = pricing.compareAt;
    }
    if (
      emitProductFields &&
      valuesDiffer("TRUE", shopifyRow[SURCHARGE.indicatorCol], "string")
    ) {
      changes[SURCHARGE.indicatorCol] = "TRUE";
    }
  }

  return {
    changes,
    skipped,
    conflicts,
    ratcheted,
    hasChanges: Object.keys(changes).length > 0,
  };
}

/**
 * For each product, work out whether all its variants agree on each
 * product-scoped field's AccountMate value.
 */
function buildProductAgreement(matched) {
  const perHandle = new Map();

  for (const { amRow, shopifyRows: targets } of matched) {
    for (const t of targets) {
      if (!perHandle.has(t.Handle)) perHandle.set(t.Handle, new Map());
      const cols = perHandle.get(t.Handle);
      for (const f of FIELD_MAP) {
        if (f.scope !== "product") continue;
        const raw = getSource(amRow, f.source);
        if (!raw) continue;
        const value = f.transform ? f.transform(raw) : raw;
        if (!cols.has(f.shopifyCol)) cols.set(f.shopifyCol, value);
        else if (cols.get(f.shopifyCol) !== value) cols.set(f.shopifyCol, CONFLICT);
      }
    }
  }
  return perHandle;
}

// ===========================================================================
// Main
// ===========================================================================

function nextVersion(outdir, date) {
  // {version} increments per run per day so repeat runs never clobber.
  let v = 1;
  while (fs.existsSync(path.join(outdir, `updated-products-${date}-v${v}.csv`))) v++;
  return `v${v}`;
}

function printUsage() {
  console.log(`
Sync Shopify catalog against AccountMate

Usage:
  node sync-catalog.js <accountmate.csv> <shopify-export.csv> [options]

Options:
  --outdir <dir>   Output directory (default: ./output)
  --date <date>    Override the {date} stamp (default: today)
  --dry-run        Report only, write nothing
  --verbose        Per-SKU change detail
  --changed-only   Narrow updated-products to just the products that changed
                   (default mirrors the Shopify export row-for-row)
`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length < 2) {
    printUsage();
    process.exit(args.includes("--help") ? 0 : 1);
  }

  const flag = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
  };
  const dryRun = args.includes("--dry-run");
  const verbose = args.includes("--verbose");
  // Shopify is the baseline: by default updated-products mirrors the export
  // row-for-row, with only the allowed columns changed. Unchanged rows are
  // byte-identical copies, which are a no-op on import. --changed-only narrows
  // the file to just the products that actually changed.
  const changedOnly = args.includes("--changed-only");
  const outdir = flag("--outdir", "output");
  // Local date, not UTC -- toISOString() rolls over a day early west of Greenwich.
  const now = new Date();
  const localToday = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  const date = flag("--date", localToday);
  const positional = args.filter(
    (a, i) => !a.startsWith("--") && !["--outdir", "--date"].includes(args[i - 1]),
  );
  const [amFile, shopifyFile] = positional;

  // --- Load ---------------------------------------------------------------
  const { rows: amRows } = parseCSV(fs.readFileSync(amFile, "utf-8"));
  const { headers: shopifyHeaders, rows: shopifyRaw } = parseCSV(
    fs.readFileSync(shopifyFile, "utf-8"),
  );
  const shopifyRows = hydrateShopifyRows(shopifyRaw, shopifyHeaders);

  console.log(`AccountMate: ${amFile}`);
  console.log(`  ${amRows.length} rows`);
  console.log(`Shopify:     ${shopifyFile}`);
  console.log(`  ${shopifyRows.length} rows, ${new Set(shopifyRows.map((r) => r.Handle)).size} products\n`);

  // --- Index --------------------------------------------------------------
  // SKUs are NOT unique in Shopify: the same SKU appears under a consolidated
  // product and its un-retired legacy standalone. Index to a LIST, not a row.
  const shopifyBySku = new Map();
  for (const r of shopifyRows) {
    const sku = normalizeSku(r["Variant SKU"]);
    if (!sku) continue;
    if (!shopifyBySku.has(sku)) shopifyBySku.set(sku, []);
    shopifyBySku.get(sku).push(r);
  }

  const amBySku = new Map();
  const whitespaceOnlyMatches = [];
  for (const r of amRows) {
    const raw = (r.SKU || "").trim();
    if (!raw) continue;
    const sku = normalizeSku(raw);
    amBySku.set(sku, r);
    if (raw !== sku && shopifyBySku.has(sku)) {
      const exact = shopifyRows.some((s) => (s["Variant SKU"] || "").trim() === raw);
      if (!exact) whitespaceOnlyMatches.push({ accountMate: raw, normalized: sku });
    }
  }

  if (whitespaceOnlyMatches.length) {
    console.log(`SKUs matched only after whitespace normalization (${whitespaceOnlyMatches.length}):`);
    for (const m of whitespaceOnlyMatches) {
      console.log(`  ${JSON.stringify(m.accountMate)} -> ${JSON.stringify(m.normalized)}`);
    }
    console.log("  ^ worth fixing at the source in AccountMate\n");
  }

  // --- Partition ----------------------------------------------------------
  const matched = [];
  const newSkus = [];
  for (const [sku, amRow] of amBySku) {
    if (shopifyBySku.has(sku)) matched.push({ sku, amRow, shopifyRows: shopifyBySku.get(sku) });
    else newSkus.push({ sku, amRow });
  }
  const deletedSkus = [...shopifyBySku.keys()].filter((s) => !amBySku.has(s));

  console.log(`Matched: ${matched.length}   New: ${newSkus.length}   Deleted: ${deletedSkus.length}\n`);

  // --- Colour map ---------------------------------------------------------
  const colorMapPath = path.join(outdir, COLOR_MAP_FILE);
  const existingColorMap = loadColorMap(colorMapPath);
  const seeded = seedFromCatalog(existingColorMap, shopifyRows);
  const { map: colorMap, added, confirmed, pending } = mergeColorMap(existingColorMap, newSkus);

  console.log(`Colour map: ${colorMap.size} entries (${seeded} seeded from catalog, ${added} newly queued)`);
  console.log(`  confirmed: ${confirmed}   pending your review: ${pending}\n`);

  // --- deleted-products ---------------------------------------------------
  const deletedRows = [];
  for (const sku of deletedSkus) {
    for (const r of shopifyBySku.get(sku)) {
      deletedRows.push({
        "Variant SKU": r["Variant SKU"],
        Handle: r.Handle,
        Title: r.Title,
        Status: r.Status,
        "Variant Price": r["Variant Price"],
        "Variant Inventory Qty": r["Variant Inventory Qty"],
        Reason: "Not present in AccountMate export",
        "Suggested Action": "Mark inactive",
        "Nearest Surviving SKU": nearestSku(sku, amBySku),
      });
    }
  }

  // Shadowed legacy duplicates: same SKU live under both a consolidated product
  // and an un-retired standalone. Folded in here as retirement candidates.
  let shadowed = 0;
  for (const [sku, rows] of shopifyBySku) {
    if (rows.length < 2) continue;
    const consolidated = rows.filter((r) => (r.Tags || "").includes(CONSOLIDATED_TAG));
    const legacy = rows.filter((r) => !(r.Tags || "").includes(CONSOLIDATED_TAG));
    if (!consolidated.length || !legacy.length) continue;
    for (const r of legacy) {
      deletedRows.push({
        "Variant SKU": r["Variant SKU"],
        Handle: r.Handle,
        Title: r.Title,
        Status: r.Status,
        "Variant Price": r["Variant Price"],
        "Variant Inventory Qty": r["Variant Inventory Qty"],
        Reason: `Legacy duplicate -- SKU also live in consolidated product "${consolidated[0].Handle}"`,
        "Suggested Action": "Retirement candidate (review before deactivating)",
        "Nearest Surviving SKU": "",
      });
      shadowed++;
    }
  }

  const DELETED_HEADERS = [
    "Variant SKU",
    "Handle",
    "Title",
    "Status",
    "Variant Price",
    "Variant Inventory Qty",
    "Reason",
    "Suggested Action",
    "Nearest Surviving SKU",
  ];

  // --- updated-products ---------------------------------------------------
  const updatedRows = [];
  let unchanged = 0;
  const skippedReport = [];
  const conflictReport = [];
  const ratchetReport = [];
  const changesByRow = new Map();
  const touchedHandles = new Set();
  const productAgreementByHandle = buildProductAgreement(matched);
  // Product metafields may only be written once per product, on its first row.
  const productFieldsEmitted = new Set();

  for (const { sku, amRow, shopifyRows: targets } of matched) {
    // Per your decision: emit a row for EVERY handle carrying this SKU, so the
    // consolidated product and its legacy twin stay in sync while both are live.
    for (const target of targets) {
      const emitProductFields = !productFieldsEmitted.has(target.Handle);
      const { changes, skipped, conflicts, ratcheted, hasChanges } = detectChanges(amRow, target, {
        productAgreement: productAgreementByHandle.get(target.Handle),
        emitProductFields,
      });
      if (skipped.length) skippedReport.push({ sku, handle: target.Handle, skipped });
      for (const c of conflicts) {
        conflictReport.push({ handle: target.Handle, col: c.col, reason: c.reason });
      }
      for (const r of ratcheted) {
        ratchetReport.push({ sku, handle: target.Handle, ...r });
      }
      if (!hasChanges) {
        unchanged++;
        continue;
      }
      if (emitProductFields) productFieldsEmitted.add(target.Handle);

      // Record the change against this specific export row. Rows are emitted
      // later, in export order, as complete product blocks.
      changesByRow.set(target.__raw, changes);
      touchedHandles.add(target.Handle);

      if (verbose) {
        const detail = Object.entries(changes)
          .map(([c, v]) => `${c.replace(/\s*\(product\.metafields\.[^)]+\)/, "")}=${v}`)
          .join(", ");
        console.log(`  UPDATE ${sku} [${target.Handle}] ${detail}`);
      }
    }
  }

  // --- new-products -------------------------------------------------------
  // Built BEFORE the updated baseline is emitted, because a product receiving a
  // new variant must have its complete block present in that baseline.
  const newRows = [];
  const triage = { noHandle: 0, noColor: 0, noSize: 0 };
  let defaultedSurcharges = 0;

  for (const { sku, amRow } of newSkus) {
    const handle = resolveHandle(sku);
    const size = resolveSize(sku, amRow);
    const cm = colorMap.get(sku);
    const color = (cm?.["Confirmed Color"] || "").trim();

    if (!handle) triage.noHandle++;
    if (!color) triage.noColor++;
    if (!size.value) triage.noSize++;

    const row = {};
    for (const h of shopifyHeaders) row[h] = "";
    Object.assign(row, NEW_PRODUCT_DEFAULTS);

    const target = handle ? shopifyRows.find((r) => r.Handle === handle) : null;

    if (target) {
      // Slot in as a variant under an existing consolidated product.
      row.Handle = handle;
      row.Title = target.Title;
      row["Option1 Name"] = target["Option1 Name"] || "Color";
      row["Option1 Value"] = color || NEEDS_COLOR_PLACEHOLDER;
      row["Option2 Name"] = target["Option2 Name"] || "Size";
      row["Option2 Value"] = size.value || NEEDS_COLOR_PLACEHOLDER.replace("COLOR", "SIZE");
      row["Option1 Linked To"] = target["Option1 Linked To"] || "";
      row.Vendor = target.Vendor || NEW_PRODUCT_DEFAULTS.Vendor;
      row.Type = target.Type || "";
      row["Product Category"] = target["Product Category"] || "";
      row.Status = target.Status || "active";
      row.Published = target.Published || "true";
    } else {
      // No rule matched -- emit as a standalone draft for manual placement.
      row.Handle = slugify(amRow.Name || sku);
      row.Title = (amRow.Name || sku).trim();
      row["Option1 Name"] = "Title";
      row["Option1 Value"] = "Default Title";
      row["Body (HTML)"] = amRow.Description || "";
    }

    row["Variant SKU"] = amRow.SKU;

    // Apply the same field mapping used for updates.
    for (const f of FIELD_MAP) {
      const raw = getSource(amRow, f.source);
      if (isBlank(raw, f.treatZeroAsBlank) && f.blankPolicy !== "overwrite") continue;
      const value = f.transform ? f.transform(raw) : raw;
      if (value !== "" && value != null) row[f.shopifyCol] = value;
    }

    // New products fall back to the catalog-standard surcharge when AccountMate
    // has none; existing products never do.
    const pricing = computePricing(amRow, { allowDefaultSurcharge: true });
    if (pricing.price) row[SURCHARGE.priceCol] = pricing.price;
    if (pricing.hasSurcharge) {
      row[SURCHARGE.compareAtCol] = pricing.compareAt;
      row[SURCHARGE.indicatorCol] = "TRUE";
    }
    if (pricing.defaulted) defaultedSurcharges++;

    row.__handleSource = handle ? "prefix-rule" : "standalone-draft";
    row.__sizeSource = size.source;
    // A new product missing price or weight can't be sold or shipped correctly,
    // so those count as review blockers too.
    row.__needsReview = [
      !handle ? "handle" : "",
      !color ? "color" : "",
      !size.value ? "size" : "",
      !pricing.price ? "price" : "",
      !row["Variant Grams"] ? "weight" : "",
    ]
      .filter(Boolean)
      .join("; ");

    newRows.push(row);
  }

  // Any product gaining a variant must appear in the baseline in full. Without
  // this, --changed-only could emit a partial block for such a product, and
  // importing it with "Overwrite products with the same handle" would drop the
  // variants that were left out.
  for (const row of newRows) {
    if (row.__handleSource === "prefix-rule") touchedHandles.add(row.Handle);
  }

  // Emit COMPLETE product blocks, in the export's own row order.
  //
  // Shopify's CSV import requires a handle's rows to be contiguous, expects the
  // first row of a block to carry the product-level fields (Title, Option
  // names), and reads the block as the product's variant list. Emitting only
  // changed rows broke all three: handles were split across the file, blocks
  // could open on a bare variant row, and multi-variant products shipped with
  // variants missing.
  //
  // So if any row of a product changed, every row of that product is emitted --
  // unchanged rows verbatim, which is a no-op on import.
  let changedRowCount = 0;
  for (const target of shopifyRows) {
    if (changedOnly && !touchedHandles.has(target.Handle)) continue;
    const changes = changesByRow.get(target.__raw);
    const row = {};
    // Reproduce the ORIGINAL row verbatim -- hydrated values would populate
    // product-level fields on variant rows the export deliberately left blank.
    for (const h of shopifyHeaders) row[h] = target.__raw[h] ?? "";
    if (changes) {
      Object.assign(row, changes);
      row.__changed = Object.keys(changes).join("; ");
      changedRowCount++;
    } else {
      row.__changed = "";
    }
    updatedRows.push(row);
  }

  // --- Assemble new-products as updated-products PLUS additions -------------
  //
  // new-products.csv is a SUPERSET of updated-products.csv: the same baseline,
  // with new variants spliced into their product's block and brand-new products
  // appended. Two consequences:
  //
  //   * It is safe to import with "Overwrite products with the same handle",
  //     because every product block in it is complete. Importing a file that
  //     held only the new variants would delete a product's other variants.
  //   * diff(export, updated) shows what changes on existing products;
  //     diff(updated, new) shows exactly what gets added.
  //
  // Import ONLY this file -- importing updated-products first would just apply
  // the same changes twice.
  const grouped = newRows.filter((r) => r.__handleSource === "prefix-rule");
  const standalone = newRows.filter((r) => r.__handleSource !== "prefix-rule");
  const additionsByHandle = new Map();
  for (const r of grouped) {
    if (!additionsByHandle.has(r.Handle)) additionsByHandle.set(r.Handle, []);
    additionsByHandle.get(r.Handle).push(r);
  }

  const combinedRows = [];
  for (let i = 0; i < updatedRows.length; i++) {
    const row = updatedRows[i];
    combinedRows.push(row);
    // Splice additions in after the LAST row of their product's block, so the
    // new variants sit inside the block they belong to.
    const isLastOfBlock =
      i === updatedRows.length - 1 || updatedRows[i + 1].Handle !== row.Handle;
    if (isLastOfBlock && additionsByHandle.has(row.Handle)) {
      combinedRows.push(...additionsByHandle.get(row.Handle));
      additionsByHandle.delete(row.Handle);
    }
  }
  // A grouped row whose handle never appeared in the baseline would be orphaned;
  // treat it as a new product block rather than silently dropping it.
  const orphaned = [...additionsByHandle.values()].flat();
  for (const r of orphaned) r.__needsReview = [r.__needsReview, "orphaned-handle"].filter(Boolean).join("; ");
  combinedRows.push(...orphaned, ...standalone);

  // Option1/Option2 form a variant's identity within a product, so unresolved
  // placeholders collapse many new variants onto the same combination. Shopify
  // rejects duplicate option combinations, which makes the file un-importable
  // until the colour map is filled in.
  const comboCounts = new Map();
  for (const r of combinedRows) {
    const key = `${r.Handle}||${r["Option1 Value"] || ""}/${r["Option2 Value"] || ""}/${r["Option3 Value"] || ""}`;
    if (!comboCounts.has(key)) comboCounts.set(key, []);
    comboCounts.get(key).push(r["Variant SKU"]);
  }
  const dupCombos = [...comboCounts.entries()].filter(([, v]) => v.length > 1);

  // --- Report -------------------------------------------------------------
  console.log("--- Summary ---");
  console.log(`  deleted-products : ${deletedRows.length} rows (${deletedSkus.length} discontinued, ${shadowed} legacy duplicates)`);
  const emittedHandles = new Set(updatedRows.map((r) => r.Handle)).size;
  console.log(
    `  updated-products : ${updatedRows.length} rows across ${emittedHandles} product(s)` +
      ` -- ${changedRowCount} changed, ${updatedRows.length - changedRowCount} unchanged` +
      (changedOnly ? " [--changed-only]" : ` (mirrors the ${shopifyRows.length}-row export)`),
  );
  console.log(
    `  new-products     : ${combinedRows.length} rows` +
      ` (the ${updatedRows.length}-row baseline + ${newRows.length} additions)`,
  );
  console.log(`      grouped into existing products : ${newRows.length - triage.noHandle}`);
  console.log(`      standalone drafts              : ${triage.noHandle}`);
  console.log(`      awaiting a confirmed colour    : ${triage.noColor}`);
  console.log(`      awaiting a size                : ${triage.noSize}`);
  if (defaultedSurcharges) {
    console.log(
      `      surcharge defaulted to ${SURCHARGE.defaultPercentForNewProducts}%   : ${defaultedSurcharges}` +
        ` (AccountMate reported none)`,
    );
  }

  if (ratchetReport.length) {
    const byCol = new Map();
    for (const r of ratchetReport) {
      if (!byCol.has(r.col)) byCol.set(r.col, []);
      byCol.get(r.col).push(r);
    }
    console.log(`\n  BLOCKED by safety ratchet -- review manually:`);
    for (const [col, items] of byCol) {
      const short = col.replace(/\s*\(product\.metafields\.[^)]+\)/, "");
      const skus = [...new Set(items.map((i) => i.sku))];
      console.log(
        `    ${short}: ${items[0].current} -> ${items[0].proposed} refused for ${skus.length} SKU(s)`,
      );
      for (const s of skus) console.log(`        ${s}`);
    }
  }

  if (conflictReport.length) {
    const byCol = new Map();
    for (const c of conflictReport) {
      const key = `${c.col}`;
      if (!byCol.has(key)) byCol.set(key, new Set());
      byCol.get(key).add(c.handle);
    }
    console.log(`\n  Product-level fields not written (variants disagree):`);
    for (const [col, handles] of byCol) {
      const short = col.replace(/\s*\(product\.metafields\.[^)]+\)/, "");
      console.log(`    ${short}: ${handles.size} product(s)`);
      if (verbose) for (const h of handles) console.log(`        ${h}`);
    }
  }

  if (skippedReport.length && verbose) {
    console.log(`\n  Skipped writes (blank in AccountMate / not allow-listed): ${skippedReport.length}`);
    for (const s of skippedReport.slice(0, 20)) {
      for (const k of s.skipped) {
        console.log(`    ${s.sku}: ${k.col} kept "${k.current}" (${k.reason})`);
      }
    }
  }

  if (dupCombos.length) {
    // Two very different problems look the same here, so separate them.
    const placeholder = dupCombos.filter(([k]) => k.includes(NEEDS_COLOR_PLACEHOLDER));
    const genuine = dupCombos.filter(([k]) => !k.includes(NEEDS_COLOR_PLACEHOLDER));

    console.log(`\n  new-products is NOT yet importable -- Shopify rejects duplicate`);
    console.log(`  option combinations within a product.`);

    if (placeholder.length) {
      console.log(`\n    ${placeholder.length} caused by unresolved placeholders (fix: fill ${COLOR_MAP_FILE}):`);
      for (const [key, skus] of placeholder.slice(0, 5)) {
        const [handle, combo] = key.split("||");
        console.log(`      ${handle}`);
        console.log(`        "${combo}" x${skus.length}`);
      }
    }

    if (genuine.length) {
      console.log(`\n    ${genuine.length} are REAL collisions -- distinct SKUs resolving to the same`);
      console.log(`    Color/Size. These need your judgement, not a colour fix:`);
      for (const [key, skus] of genuine.slice(0, 8)) {
        const [handle, combo] = key.split("||");
        console.log(`      ${handle}`);
        console.log(`        "${combo}" claimed by: ${skus.join("  |  ")}`);
      }
      console.log(`\n    Usually means the Size rule is too coarse (a 2-gallon kit and a`);
      console.log(`    1-gallon kit both reading as "Gallon"), or the variants differ on an`);
      console.log(`    axis the catalog does not model. Fix via UOM_TO_SIZE /`);
      console.log(`    SKU_SUFFIX_TO_SIZE in sync-config.js, or drop the row.`);
    }
    console.log(`\n    updated-products is unaffected and importable now.`);
  }

  if (dryRun) {
    console.log("\n[dry run] nothing written.");
    return;
  }

  // --- Write --------------------------------------------------------------
  fs.mkdirSync(outdir, { recursive: true });
  const version = nextVersion(outdir, date);

  // The update/new files match the Shopify export header exactly, so they can be
  // uploaded without editing. All review metadata goes to the report file.
  const reportRows = [
    ...updatedRows.map((r) => ({
      File: "updated",
      "Variant SKU": r["Variant SKU"],
      Handle: r.Handle,
      "Changed Fields": r.__changed,
      "Needs Review": "",
      "Handle Source": "",
      "Size Source": "",
    })),
    ...combinedRows.filter((r) => r.__handleSource).map((r) => ({
      File: "new",
      "Variant SKU": r["Variant SKU"],
      Handle: r.Handle,
      "Changed Fields": "",
      "Needs Review": r.__needsReview,
      "Handle Source": r.__handleSource,
      "Size Source": r.__sizeSource,
    })),
  ];
  const REPORT_HEADERS = [
    "File",
    "Variant SKU",
    "Handle",
    "Changed Fields",
    "Needs Review",
    "Handle Source",
    "Size Source",
  ];

  const strip = (rows) =>
    rows.map((r) => {
      const o = {};
      for (const h of shopifyHeaders) o[h] = r[h] ?? "";
      return o;
    });

  writeCSV(path.join(outdir, `deleted-products-${date}-${version}.csv`), DELETED_HEADERS, deletedRows);
  writeCSV(
    path.join(outdir, `updated-products-${date}-${version}.csv`),
    shopifyHeaders,
    strip(updatedRows),
  );
  writeCSV(
    path.join(outdir, `new-products-${date}-${version}.csv`),
    shopifyHeaders,
    strip(combinedRows),
  );
  writeCSV(path.join(outdir, `sync-report-${date}-${version}.csv`), REPORT_HEADERS, reportRows);
  writeCSV(colorMapPath, COLOR_MAP_HEADERS, [...colorMap.values()]);

  console.log(`\nWrote to ${outdir}/`);
  console.log(`  deleted-products-${date}-${version}.csv   (${deletedRows.length} rows)`);
  console.log(`  updated-products-${date}-${version}.csv   (${updatedRows.length} rows, Shopify format)`);
  console.log(
    `  new-products-${date}-${version}.csv       (${combinedRows.length} rows = baseline + ${newRows.length} additions)`,
  );
  console.log(`  sync-report-${date}-${version}.csv        (review metadata)`);
  console.log(`  ${COLOR_MAP_FILE}`);

  if (pending > 0) {
    console.log(`\nNext: fill the "Confirmed Color" column for ${pending} row(s) in ${colorMapPath},`);
    console.log(`      then re-run to pick them up. Rows without a confirmed colour carry`);
    console.log(`      a ${NEEDS_COLOR_PLACEHOLDER} placeholder and are not safe to import as-is.`);
  }
  const ready = newRows.filter((r) => !r.__needsReview).length;
  console.log(
    `\nnew-products is a SUPERSET of updated-products (same baseline plus the` +
      `\nadditions), so import ONLY ONE of them -- new-products if you want the` +
      `\nadditions too. Every product block in both files is complete, so both are` +
      `\nsafe with "Overwrite products with the same handle".` +
      `\n\n  diff export -> updated : what changes on existing products` +
      `\n  diff updated -> new    : what gets added` +
      `\n\n${ready} of ${newRows.length} additions are complete; the rest carry placeholders` +
      `\n(see sync-report). Delete their rows before importing, or fill color-map.csv.`,
  );
}

/** Cheap rename hint for the deleted list: same SKU ignoring size/kit tokens. */
function nearestSku(sku, amBySku) {
  const strip = (s) =>
    s.replace(new RegExp(`\\s*(${SKU_SUFFIX_ORDER.map((t) => t.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})$`), "").trim();
  const base = strip(sku);
  if (!base || base === sku) return "";
  for (const candidate of amBySku.keys()) {
    if (strip(candidate) === base) return candidate;
  }
  return "";
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

main();
