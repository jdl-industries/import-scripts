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
 *   --changed-only   Narrow updated-products to just the rows that changed
 */

import fs from "fs";
import path from "path";
import { specTitle, specHandle, baseSpec, expandSpec } from "./spec-parser.mjs";
import { readAccountMate, specStrings } from "./accountmate.mjs";
import {
  SURCHARGE,
  UOM_TO_SIZE,
  SKU_SUFFIX_SIZE_OVERRIDE,
  SKU_SUFFIX_OVERRIDE_ORDER,
  SIZE_METAOBJECT,
  SIZE_METAFIELD_COL,
  SIZE_VOCABULARY,
  NEW_PRODUCT_HANDLE,
  COLOR_PATTERNS,
  COLOR_SCOPE_CONFIDENCE,
  COLOR_MAP_FILE,
  NEW_PRODUCT_DEFAULTS,
  MATRIXIFY,
  MATRIXIFY_FIELD_MAP,
  MATRIXIFY_NEW_COLUMNS,
  PRODUCT_CATEGORY,
  CATEGORY_COLUMNS,
  classifyCategory,
  PRODUCT_TYPE,
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

/** Canonical field lookup, resolved by the format adapter. */
const getField = (row, field) => (AM ? AM.get(row, field) : "");

const getSource = (row, source) =>
  source.field ? getField(row, source.field) : String(row[source.col] ?? "").trim();

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

/** Semicolon-delimited input -> JSON array, one element per value. */
function jsonList(v) {
  const parts = String(v || "").split(";").map((x) => x.trim()).filter(Boolean);
  return parts.length ? JSON.stringify(parts) : "";
}

/**
 * compliance_certifications is a list metafield holding ONE element whose text
 * is semicolon-delimited -- ["a; b; c"], not ["a","b","c"]. That is the shape
 * the catalog already uses and what the storefront expects.
 */
function jsonBlob(v) {
  const parts = String(v || "").split(";").map((x) => x.trim()).filter(Boolean);
  return parts.length ? JSON.stringify([parts.join("; ")]) : "";
}

/**
 * Shopify pricing derived from AccountMate. One place, so the update path and
 * the new-product path cannot drift.
 *
 *   neither surcharge set   price = AccountMate price
 *                           compare-at CLEARED, indicator false
 *   surcharge AMOUNT set    price = price + amount
 *                           compare-at = amount, indicator true
 *   surcharge PERCENT set   price = price + (price * percent/100)
 *                           compare-at = price * percent/100, indicator true
 *
 * Amount wins if both are present. Clearing compare-at when the surcharge drops
 * to zero matters: 57 SKUs currently carry a stale compare-at from a surcharge
 * AccountMate no longer reports, which the storefront renders as a struck-out
 * price.
 */
function computePricing(amRow, { allowDefaultSurcharge = false } = {}) {
  const base = parseFloat(getField(amRow, SURCHARGE.basePriceField));
  const amount = parseFloat(getField(amRow, SURCHARGE.amountField)) || 0;
  const percent = parseFloat(getField(amRow, SURCHARGE.percentField)) || 0;

  let surcharge = 0;
  let source = "";
  if (amount > 0) {
    surcharge = amount;
    source = "amount";
  } else if (percent > 0 && Number.isFinite(base)) {
    surcharge = +(base * (percent / 100)).toFixed(2);
    source = "percent";
  }

  // New products only: AccountMate leaves both fields at 0 on newly-added
  // items, so fall back to the catalog-standard rate. Never applied to an
  // existing product -- those always reflect what AccountMate reports.
  let defaulted = false;
  const fallback = SURCHARGE.defaultPercentForNewProducts;
  if (allowDefaultSurcharge && surcharge === 0 && fallback && Number.isFinite(base) && base > 0) {
    surcharge = +(base * (fallback / 100)).toFixed(2);
    defaulted = surcharge > 0;
    source = "default";
  }

  return {
    price: Number.isFinite(base) ? (base + surcharge).toFixed(2) : "",
    // "" means CLEAR the field -- not "leave it alone".
    compareAt: surcharge > 0 ? surcharge.toFixed(2) : "",
    hasSurcharge: surcharge > 0,
    source,
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

/**
 * Titles for new products, from new-product-titles.csv.
 *
 * AccountMate's Name field is just the SKU, so a title cannot be derived from
 * the data. This map is authored once per product and read back on every run --
 * the same handoff shape as the colour map. "Confirmed Title" wins if set,
 * otherwise "Drafted Title" is used.
 */
const CONTENT_MAP_FILE = "new-product-content.csv";

/**
 * Authored handle / title / body for new products, keyed by SKU. Each field has
 * a "Confirmed" column that wins over the "Drafted" one, so hand edits survive
 * regeneration.
 */
function loadContentMap(file) {
  if (!fs.existsSync(file)) return new Map();
  const { rows } = parseCSV(fs.readFileSync(file, "utf-8"));
  const m = new Map();
  const pickField = (r, name) => (r[`Confirmed ${name}`] || "").trim() || (r[`Drafted ${name}`] || "").trim();
  for (const r of rows) {
    const k = normalizeSku(r.SKU);
    if (!k) continue;
    m.set(k, {
      handle: pickField(r, "Handle"),
      title: pickField(r, "Title"),
      body: pickField(r, "Body HTML"),
      description: (r.Description || "").trim(),
      spec: (r.Spec || "").trim(),
      milSpecs: pickField(r, "Mil Specs"),
      qpl: pickField(r, "QPL"),
      compliance: pickField(r, "Compliance"),
      applications: pickField(r, "Applications"),
      parentCollection: (r["Parent Collection"] || "").trim(),
      nsn: (r.NSN || "").trim(),
    });
  }
  return m;
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
// Set by main() once the AccountMate file is read; every field lookup goes
// through it so this file is agnostic to which export format was supplied.
let AM = null;

/**
 * Specifications for a product, normalised and expanded. The named export has
 * dedicated QPL / Meets specs columns; the legacy one required regex-parsing
 * them out of the description HTML. Either way the same pipeline applies.
 */
function productSpecs(amRow) {
  const raw = specStrings(amRow, AM.get, AM.format);
  const clean = (list) => [...new Set(list.flatMap((x) => expandSpec(x)).filter((x) => x && x.length > 2))];
  return { approved: clean(raw.approved), meets: clean(raw.meets) };
}

const APPROVED_SPECS_COL = "Metafield: custom.approved_specifications [list.metaobject_reference]";
const MEETS_SPECS_COL = "Metafield: custom.meets_specifications [list.metaobject_reference]";

/**
 * Base-specification tags for a product.
 *
 * Metafields are not indexed by Shopify search, but tags are -- and buyers
 * commonly search the base number ("mil-prf-85285") rather than the full
 * qualified spec. Every specification the product meets OR is approved for
 * contributes its base. Where a spec IS its own base ("MEP 10-068") the title
 * is used directly.
 */
const tagSlug = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * Searchable tags for a product.
 *
 * Metafields are not indexed by Shopify search but tags are, and buyers search
 * base spec numbers, series codes and colour codes rather than fully qualified
 * strings. Three sources contribute:
 *
 *   specifications  the BASE of every spec met or approved ("mil-prf-85285")
 *   series          the family code ("pg-6")
 *   NSN             the national stock number ("8010-01-582-7282")
 *   colour specs    the normalised colour code ("37038", "bac-707")
 *
 * Colour specs are messy in the source -- "BAC  707  GRAY", "BLACK FCS# 37038",
 * "BAC 706; FSD 37038" -- so they go through the same extractor used for the
 * colour metafield, which yields the canonical code.
 */
function specBaseTags(amRow) {
  const { approved, meets } = productSpecs(amRow);
  const tags = [...approved, ...meets].map((t) => tagSlug(baseSpec(t) || t));

  const series = getField(amRow, "series");
  if (series) tags.push(tagSlug(series));

  // NSN is a primary search key for military buyers.
  const nsn = getField(amRow, "nsn");
  if (nsn) tags.push(tagSlug(nsn));

  // Semicolon-delimited; each part carries at most one code.
  for (const part of getField(amRow, "colorSpecs").split(";")) {
    const c = extractColor(part);
    if (c) tags.push(tagSlug(c.value));
  }

  return [...new Set(tags.filter(Boolean))];
}

/**
 * Merge tags into an existing list without disturbing what is already there.
 * Returns null when nothing new would be added, so unchanged products are not
 * rewritten. Comparison is case-insensitive; existing order is preserved.
 */
function mergeTags(existing, add) {
  const cur = String(existing || "").split(",").map((t) => t.trim()).filter(Boolean);
  const seen = new Set(cur.map((t) => t.toLowerCase()));
  const out = [...cur];
  for (const t of add) {
    if (!seen.has(t.toLowerCase())) {
      out.push(t);
      seen.add(t.toLowerCase());
    }
  }
  return out.length === cur.length ? null : out.join(", ");
}

/** AccountMate spec lists -> metaobject references for the two product fields. */
function specMetafields(amRow) {
  const { approved, meets } = productSpecs(amRow);
  const refs = (list) => list.map((t) => `product_specification.${specHandle(t)}`).join(", ");
  return { [APPROVED_SPECS_COL]: refs(approved), [MEETS_SPECS_COL]: refs(meets) };
}

const MIGRATION_COLOUR_PATTERN_COL = "Metafield: shopify.color-pattern [list.metaobject_reference]";
const MIGRATION_SAE_COL = "Metafield: custom.sae_color [single_line_text_field]";

const PRODUCT_LEVEL_CARRY = [
  "Title",
  "Tags",
  "Body HTML",
  "Vendor",
  "Type",
  "Status",
  "Published",
  "Metafield: custom.compare_at_indicates_surcharge [boolean]",
  // Colour lives in the output header for NEW products, so add-variant rows
  // must echo it back -- a blank cell would clear the colour of a live product.
  MIGRATION_COLOUR_PATTERN_COL,
  MIGRATION_SAE_COL,
  SIZE_METAFIELD_COL,
  APPROVED_SPECS_COL,
  MEETS_SPECS_COL,
  ...CATEGORY_COLUMNS,
  "Metafield: custom.mil_specs [list.metaobject_reference]",
  "Metafield: custom.qpl [list.metaobject_reference]",
  "Metafield: custom.compliance_certifications [list.single_line_text_field]",
  "Metafield: custom.applications [list.single_line_text_field]",
  "Metafield: custom.parent_collection [collection_reference]",
  "Metafield: custom.nsn [single_line_text_field]",
];

// --- grouping --------------------------------------------------------------

/**
 * Product identity under the current architecture: one product per colour /
 * chemistry, with Size as the only variant axis. The product is therefore the
 * SKU with its size token stripped.
 *
 *   HZK31136WPX-T1          -> HZK31136WPX-T1   (Gallon)
 *   HZK31136WPX-T1 QT/KT    -> HZK31136WPX-T1   (Quart)
 *   HZK31136WPX-T1 4OZ/K    -> HZK31136WPX-T1   (4oz Kit)
 *
 * This replaces the old PREFIX_TO_HANDLE table, which existed only to group
 * colours as variants of a shared product.
 */
const SIZE_TOKENS = [
  ...SKU_SUFFIX_OVERRIDE_ORDER,
  "-LVOC KIT",
  " KIT",
  "-2G",
  "GL/KT",
  "_2G",
  "_G",
  "GL",
  "G1",
  "G2",
  "G4",
  "GK-1",
  "GK-2",
  "G-1",
].sort((a, b) => b.length - a.length);

function skuBase(sku) {
  const v = normalizeSku(sku);
  for (const t of SIZE_TOKENS) if (v.endsWith(t)) return v.slice(0, -t.length).trim();
  return v;
}

/**
 * Size resolution, AccountMate first:
 *   1. an unambiguous SKU suffix (UoM is coarser -- "KIT" covers both a
 *      5-gallon and a 1.25-gallon kit)
 *   2. the Unit of Measure map
 * Unresolved is reported, never defaulted: a wrong size mislabels what ships.
 */
function resolveSize(sku, amRow) {
  const s = normalizeSku(sku);
  for (const token of SKU_SUFFIX_OVERRIDE_ORDER) {
    if (s.endsWith(token.toUpperCase())) {
      return { value: SKU_SUFFIX_SIZE_OVERRIDE[token], source: "SKU suffix" };
    }
  }
  if (amRow) {
    const uom = getField(amRow, "unitOfMeasure").toUpperCase();
    if (UOM_TO_SIZE[uom]) return { value: UOM_TO_SIZE[uom], source: "AccountMate UoM" };
    if (uom) return { value: "", source: "", unmappedUom: uom };
  }
  return { value: "", source: "" };
}

/** hentzen-{mpn}-{spec}, per the agreed scheme. */
function buildHandle(amRow, sku) {
  // Prefer the AccountMate Vendor SKU, falling back to the SKU base. Strip any
  // trailing size token -- "PG-21-G2 Q2" would otherwise put a size in the URL,
  // which is wrong now that size is a variant.
  // Derive the MPN from the SKU, not the Vendor SKU field: that field carries
  // real errors ("PAINT", "JDL-12", and AXTF-1-BR1 listed as AXTS-1-BR1).
  // The SKU is the client's canonical identifier.
  let mpn = NEW_PRODUCT_HANDLE.normalizeMpn(skuBase(sku));
  const slug = (v) =>
    String(v)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const spec = NEW_PRODUCT_HANDLE.specFrom(amRow);
  return [NEW_PRODUCT_HANDLE.prefix, slug(mpn), spec ? slug(spec) : ""].filter(Boolean).join("-");
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
    // Set once at creation, then owned by hand -- never re-synced.
    if (f.newProductsOnly) continue;
    const raw = getSource(amRow, f.source);

    // blankPolicy "overwrite" means an EMPTY AccountMate value is written
    // through, clearing the field. The previous guard also required
    // `raw !== ""`, which made the policy a no-op for genuinely empty values --
    // the exact case it exists for.
    const overwriteBlank = f.blankPolicy === "overwrite";
    if (isBlank(raw, f.treatZeroAsBlank) && !overwriteBlank) {
      const cur = (baseRow[f.col] || "").trim();
      if (cur) skipped.push({ col: f.col, current: cur, reason: "blank in AccountMate" });
      continue;
    }

    const value = f.transform ? f.transform(raw) : raw;
    if ((value === "" || value == null) && !overwriteBlank) continue;

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
  // Specification lists, parsed from the AccountMate description blocks.
  // Written in both directions: if AccountMate stops listing a spec the stale
  // reference is cleared rather than left behind.
  for (const [col, want] of Object.entries(specMetafields(amRow))) {
    if (!baselineHasColumn(col)) {
      // Column not in the export yet -- nothing to diff against, so write it
      // and report, rather than silently skipping.
      if (want) {
        undiffable.push(col);
        changes[col] = want;
      }
      continue;
    }
    if (valuesDiffer(want, baseRow[col], "string")) changes[col] = want;
  }

  // Base-specification tags, merged into whatever the product already carries.
  const mergedTags = mergeTags(baseRow["Tags"], specBaseTags(amRow));
  if (mergedTags !== null) {
    changes["Tags"] = mergedTags;
    // The complete list is written, existing tags included, so REPLACE is
    // idempotent and matches the convention already in the catalog.
    changes["Tags Command"] = "REPLACE";
  }

  const pricing = computePricing(amRow);
  if (pricing.price && valuesDiffer(pricing.price, baseRow[MATRIXIFY.priceCol], "number")) {
    changes[MATRIXIFY.priceCol] = pricing.price;
  }
  // compare-at and the indicator track the surcharge in BOTH directions: when
  // AccountMate stops reporting one, the stale values must be cleared.
  const curCompareAt = (baseRow[MATRIXIFY.compareAtCol] || "").trim();
  if (pricing.hasSurcharge) {
    if (valuesDiffer(pricing.compareAt, curCompareAt, "number")) {
      changes[MATRIXIFY.compareAtCol] = pricing.compareAt;
    }
  } else if (curCompareAt) {
    changes[MATRIXIFY.compareAtCol] = "";
  }
  if (baselineHasColumn(MATRIXIFY.indicatorCol)) {
    const want = pricing.hasSurcharge ? "true" : "false";
    if (valuesDiffer(want, baseRow[MATRIXIFY.indicatorCol], "string")) {
      changes[MATRIXIFY.indicatorCol] = want;
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
  --changed-only   Narrow updated-products to just the rows that changed
                   (default mirrors the baseline row-for-row)

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
  // updated-products mirrors the baseline row-for-row by default, so it can be
  // diffed against it directly. Every row already carries complete current
  // values (a blank cell would clear the field), so unchanged rows cost little.
  const changedOnly = args.includes("--changed-only");
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

  AM = readAccountMate(amFile);
  const amRows = AM.rows;
  const { headers: baseHeaders, rows: baseRowsRaw } = parseCSV(fs.readFileSync(baseFile, "utf-8"));
  const baseRows = hydrateBaseline(baseRowsRaw, baseHeaders);
  const headerSet = new Set(baseHeaders);
  const baselineHasColumn = (c) => headerSet.has(c);

  console.log(`AccountMate: ${amFile}  (${amRows.length} rows, ${AM.format} format)`);
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
    const raw = AM.get(r, "sku");
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
  // Titles live alongside the script, not in outdir -- they are authored once
  // and version-controlled, unlike the per-run outputs.
  const contentMap = loadContentMap(CONTENT_MAP_FILE);
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
    // The named format has a dedicated Color specs column carrying the code;
    // the legacy one only had it buried in the description text.
    const g = extractColor(getField(amRow, "colorSpecs") || getField(amRow, "shortDescription"));
    colorMap.set(sku, {
      SKU: sku,
      "Confirmed Color": "",
      "Extracted Guess": g ? g.value : "",
      Source: g ? g.source : "",
      Confidence: g ? g.confidence : "",
      // The AccountMate "Color" field is unused: 13 broad names ("WHITE") that
      // cannot resolve to a colour handle. "Color specs" carries the code.
      "AccountMate Color": getField(amRow, "colorSpecs"),
      Evidence: g ? g.snippet : getField(amRow, "colorSpecs") || getField(amRow, "shortDescription").slice(0, 120),
    });
    added++;
  }
  const confirmed = [...colorMap.values()].filter((r) => (r["Confirmed Color"] || "").trim()).length;
  console.log(`Content:    ${contentMap.size} authored products (${CONTENT_MAP_FILE})`);
  console.log(`Colour map: ${colorMap.size} entries (${seeded} seeded, ${added} newly queued)`);
  console.log(`  confirmed: ${confirmed}   pending: ${colorMap.size - confirmed}\n`);

  // --- updated ------------------------------------------------------------
  // Every column this sync is allowed to put in an output file. Because a blank
  // cell clears the field in Matrixify, the file must contain ONLY columns we
  // understand and can populate correctly -- never the full 112-column export.
  const managedColumns = [
    "Tags",
    "Tags Command",
    APPROVED_SPECS_COL,
    MEETS_SPECS_COL,
    MATRIXIFY.priceCol,
    MATRIXIFY.compareAtCol,
    MATRIXIFY.indicatorCol,
    // Written when a discontinued variant is retired in place.
    "Variant Inventory Policy",
    // Matrixify refuses a quantity write without a tracker: "To set inventory
    // quantity, set also the value for Variant Inventory Tracker". Carried from
    // the baseline so every row that writes a qty has one.
    "Variant Inventory Tracker",
    ...MATRIXIFY_FIELD_MAP.filter((f) => !f.newProductsOnly).flatMap((f) => [
      f.col,
      ...Object.keys(f.companions || {}),
    ]),
  ].filter((c, i, a) => a.indexOf(c) === i);

  // A handle is still LIVE if at least one of its variants is present in
  // AccountMate. This distinguishes a VARIANT retirement (the product survives
  // with its other sizes) from a PRODUCT retirement (nothing left to sell).
  const handleHasLiveVariant = new Set();
  for (const r of baseRows) {
    const k = normalizeSku(r[MATRIXIFY.skuCol]);
    if (k && amBySku.has(k)) handleHasLiveVariant.add(r[MATRIXIFY.handleCol]);
  }
  const isArchived = (r) => /^archived$/i.test((r["Status"] || "").trim());

  const updatedRows = [];
  let retiredVariants = 0;
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

      // A baseline row with no AccountMate match is a discontinued SKU.
      //
      // If the product still has a live variant, retire this one IN PLACE --
      // zero the stock and stop selling it -- leaving the product and its
      // surviving sizes alone. Archiving the whole product would take those
      // down too. Only products with nothing left go to deleted-products.
      if (!amRow) {
        if (!isArchived(target) && handleHasLiveVariant.has(target[MATRIXIFY.handleCol])) {
          const row = {
            [MATRIXIFY.handleCol]: target[MATRIXIFY.handleCol],
            [MATRIXIFY.commandCol]: MATRIXIFY.command,
            [MATRIXIFY.variantCommandCol]: MATRIXIFY.command,
            [MATRIXIFY.skuCol]: target[MATRIXIFY.skuCol],
          };
          for (const col of managedColumns) {
            if (row[col] === undefined) row[col] = target[col] ?? "";
          }
          if (target["ID"]) row["ID"] = target["ID"];
          if (target["Variant ID"]) row["Variant ID"] = target["Variant ID"];

          const changes = {};
          if (valuesDiffer("0", target["Variant Inventory Qty"], "integer")) {
            changes["Variant Inventory Qty"] = "0";
          }
          if (valuesDiffer("deny", target["Variant Inventory Policy"], "string")) {
            changes["Variant Inventory Policy"] = "deny";
          }
          Object.assign(row, changes);
          row.__changed = Object.keys(changes).join("; ");
          if (Object.keys(changes).length) retiredVariants++;
          if (!changedOnly || Object.keys(changes).length) updatedRows.push(row);
          continue;
        }

        if (changedOnly) continue;
        const passthrough = {
          [MATRIXIFY.handleCol]: target[MATRIXIFY.handleCol],
          [MATRIXIFY.commandCol]: MATRIXIFY.command,
          [MATRIXIFY.variantCommandCol]: MATRIXIFY.command,
          [MATRIXIFY.skuCol]: target[MATRIXIFY.skuCol],
        };
        for (const col of managedColumns) {
          if (passthrough[col] === undefined) passthrough[col] = target[col] ?? "";
        }
        if (target["ID"]) passthrough["ID"] = target["ID"];
        if (target["Variant ID"]) passthrough["Variant ID"] = target["Variant ID"];
        passthrough.__changed = "";
        updatedRows.push(passthrough);
        continue;
      }

      const { changes, ratcheted, undiffable, hasChanges } = detectChanges(
        amRow,
        target,
        baselineHasColumn,
      );
      ratcheted.forEach((r) => ratchetReport.push({ sku, ...r }));
      undiffable.forEach((c) => undiffableCols.add(c));
      if (!hasChanges) {
        unchanged++;
        if (changedOnly) continue;
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
      if (verbose && hasChanges) console.log(`  UPDATE ${sku}: ${row.__changed}`);
    }
  }

  // Any row writing a quantity must carry a tracker. Three baseline variants
  // have neither; they only need one if AccountMate supplies stock for them,
  // in which case "shopify" matches the other 238.
  for (const row of updatedRows) {
    if ((row["Variant Inventory Qty"] ?? "").toString().trim() === "") continue;
    if (!(row["Variant Inventory Tracker"] ?? "").toString().trim()) {
      row["Variant Inventory Tracker"] = "shopify";
    }
  }

  // --- new ----------------------------------------------------------------
  // Under colour-as-product / size-as-variant, new SKUs split two ways:
  //   * another SIZE of a product that already exists -> add a variant
  //   * a new colour / chemistry                      -> create a product
  // Grouping by SKU base decides which, and groups several new sizes of the
  // same new product into one product with several variants.
  const newRows = [];
  const triage = { newProducts: 0, addedVariants: 0, noSize: 0, noColour: 0 };
  let defaultedSurcharges = 0;

  // Existing products, indexed by the SKU base they represent.
  const baseToProduct = new Map();
  for (const r of baseRows) {
    const k = skuBase(r[MATRIXIFY.skuCol]);
    if (k && !baseToProduct.has(k)) baseToProduct.set(k, r);
  }

  // Group the new SKUs by product.
  const newGroups = new Map();
  for (const { sku, amRow } of newSkus) {
    const k = skuBase(sku);
    if (!newGroups.has(k)) newGroups.set(k, []);
    newGroups.get(k).push({ sku, amRow });
  }

  for (const [base, members] of newGroups) {
    const existing = baseToProduct.get(base);
    // Sizes this product will have once the new SKUs land: the existing
    // variants' sizes plus the new ones. custom.size is a list replaced
    // wholesale, so it must cover all of them.
    const sizes = new Set();
    if (existing) {
      baseRows
        .filter((r) => r[MATRIXIFY.handleCol] === existing[MATRIXIFY.handleCol])
        .forEach((r) => {
          const v = (r["Option1 Value"] || "").trim();
          if (v) sizes.add(v);
        });
    }

    // Title is a PRODUCT-level field, so it must be resolved once for the group
    // and written identically on every row. Looking it up per-variant left the
    // second size of a new product titled with its raw SKU, which -- since a
    // present-but-different value overwrites -- would have clobbered the real
    // title set by the first row.
    const groupContent = members.map(({ sku }) => contentMap.get(sku)).find((c) => c && c.title) || null;

    const memberRows = [];
    for (const { sku, amRow } of members) {
      const size = resolveSize(sku, amRow);
      if (!size.value) triage.noSize++;
      else sizes.add(size.value);

      const row = {
        [MATRIXIFY.commandCol]: MATRIXIFY.command,
        [MATRIXIFY.variantCommandCol]: MATRIXIFY.command,
        [MATRIXIFY.skuCol]: AM.get(amRow, "sku"),
        "Option1 Name": "Size",
        "Option1 Value": size.value || "NEEDS-SIZE",
      };

      if (existing) {
        // Adding a variant: every PRODUCT-level column present must carry the
        // product's current value, since a blank cell clears the field.
        row[MATRIXIFY.handleCol] = existing[MATRIXIFY.handleCol];
        for (const col of PRODUCT_LEVEL_CARRY) {
          if ((row[col] ?? "") === "" && (existing[col] ?? "") !== "") row[col] = existing[col];
        }
      } else {
        const colour = (colorMap.get(sku)?.["Confirmed Color"] || "").trim();
        if (!colour) triage.noColour++;
        // An authored handle wins: it carries the spec exactly as the confirmed
        // title does, which buildHandle can only approximate from the raw
        // description text.
        row[MATRIXIFY.handleCol] = groupContent?.handle || buildHandle(amRow, sku);
        // AccountMate's Name is just the SKU, so an authored title is the only
        // usable source. Falls back to the SKU and is flagged for review.
        row["Title"] = groupContent?.title || sku;
        row["Body HTML"] = groupContent?.body || getField(amRow, "description") || "";
        row["Status"] = NEW_PRODUCT_DEFAULTS.Status;
        row["Published"] = NEW_PRODUCT_DEFAULTS.Published;
        row["Vendor"] = getField(amRow, "manufacturer") || NEW_PRODUCT_DEFAULTS.Vendor;
        row["Variant Taxable"] = "true";
        row["Variant Inventory Tracker"] = "shopify";
        row["Variant Inventory Policy"] = "deny";
        row["Variant Fulfillment Service"] = "manual";
        row["Variant Requires Shipping"] = "true";
        // Category is REQUIRED: custom.size is a category metafield and is
        // rejected outright on a product with no category.
        Object.assign(row, specMetafields(amRow));

        const kind = classifyCategory(groupContent?.description, groupContent?.spec);
        Object.assign(row, PRODUCT_CATEGORY[kind]);
        row["Type"] = PRODUCT_TYPE[kind];

        // Tags: "hazmat" when the product is hazardous, plus the base form of
        // each mil spec it is qualified for ("mil-prf-85285").
        const isHazmat = /^yes$/i.test(getField(amRow, "hazardous"));
        const tags = [...new Set([isHazmat ? "hazmat" : "", ...specBaseTags(amRow)].filter(Boolean))];
        if (tags.length) {
          row["Tags"] = tags.join(", ");
          row["Tags Command"] = "REPLACE";
        }

        // Authored / derived product metafields. Written only when non-empty --
        // a blank cell would clear the field, and these columns are shared with
        // add-variant rows.
        const meta = {
          "Metafield: custom.mil_specs [list.metaobject_reference]": (groupContent?.milSpecs || "")
            .split(",").map((x) => x.trim()).filter(Boolean)
            .map((h) => (h.startsWith("military_specification.") ? h : `military_specification.${h}`))
            .join(", "),
          "Metafield: custom.qpl [list.metaobject_reference]": (groupContent?.qpl || "")
            .split(",").map((x) => x.trim()).filter(Boolean)
            .map((h) => (h.startsWith("military_specification.") ? h : `military_specification.${h}`))
            .join(", "),
          // list.single_line_text_field is stored as a JSON array, one element
          // per value -- NOT a semicolon-delimited blob. (The existing catalog
          // has several of these as a single element containing semicolons;
          // that is the shape being corrected here.)
          "Metafield: custom.compliance_certifications [list.single_line_text_field]": jsonBlob(groupContent?.compliance),
          "Metafield: custom.applications [list.single_line_text_field]": jsonList(groupContent?.applications),
          "Metafield: custom.parent_collection [collection_reference]": groupContent?.parentCollection || "",
          "Metafield: custom.nsn [single_line_text_field]": groupContent?.nsn || "",
        };
        for (const [k, v] of Object.entries(meta)) if (v) row[k] = v;
        // Colour is a METAFIELD now, not a variant option, so an unconfirmed
        // colour no longer blocks the import -- it just leaves the field unset.
        if (colour) {
          row[MIGRATION_COLOUR_PATTERN_COL] = colour.startsWith("shopify--color-pattern.")
            ? colour
            : `shopify--color-pattern.${colour}`;
          if (/^\d{5}$/.test(colour)) row[MIGRATION_SAE_COL] = colour;
        }
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

      row.__action = existing ? "add-variant" : "new-product";
      row.__sizeSource = size.source;
      row.__needsReview = [
        !size.value ? "size" : "",
        !existing && !groupContent?.title ? "title" : "",
        !existing && !groupContent?.body ? "description" : "",
        !existing && !(colorMap.get(sku)?.["Confirmed Color"] || "").trim() ? "colour" : "",
        !pricing.price ? "price" : "",
        !row["Variant Weight"] ? "weight" : "",
      ]
        .filter(Boolean)
        .join("; ");
      memberRows.push(row);
    }

    // custom.size goes on the product's FIRST row only, listing every distinct
    // size in vocabulary order. Omitted entirely if any size lacks a metaobject,
    // rather than writing a dangling reference.
    const ordered = [...sizes].sort((x, y) => SIZE_VOCABULARY.indexOf(x) - SIZE_VOCABULARY.indexOf(y));
    const handles = ordered.map((sz) => SIZE_METAOBJECT[sz]).filter(Boolean);
    if (memberRows.length && handles.length === ordered.length && ordered.length) {
      memberRows[0][SIZE_METAFIELD_COL] = handles.join(", ");
    }
    memberRows[0] && (memberRows[0].__sizes = ordered.join(" | "));

    if (existing) triage.addedVariants += memberRows.length;
    else triage.newProducts++;
    newRows.push(...memberRows);
  }

  // Same pairing rule as updated-products: a quantity write needs a tracker.
  // New products get one from NEW_PRODUCT_DEFAULTS, but rows adding a size to
  // an existing product do not, so this covers them.
  for (const row of newRows) {
    if ((row["Variant Inventory Qty"] ?? "").toString().trim() === "") continue;
    if (!(row["Variant Inventory Tracker"] ?? "").toString().trim()) {
      row["Variant Inventory Tracker"] = "shopify";
    }
  }

  // --- deleted ------------------------------------------------------------
  // A SKU belongs here only if it is live in Shopify and absent from
  // AccountMate. Products already Archived are retired -- listing them again
  // every run buries the handful of genuinely new discontinuations.
  const deletedRows = [];
  let archivedSkipped = 0;
  for (const sku of deletedSkus) {
    for (const r of baseBySku.get(sku)) {
      if (isArchived(r)) {
        archivedSkipped++;
        continue;
      }
      // Retired in place as a variant above. Still listed here so this file is a
      // complete record of everything AccountMate has dropped -- the Reason
      // column distinguishes it from a product with nothing left to sell.
      const retiredInPlace = handleHasLiveVariant.has(r[MATRIXIFY.handleCol]);
      deletedRows.push({
        "Variant SKU": r[MATRIXIFY.skuCol],
        Handle: r[MATRIXIFY.handleCol],
        Title: r["Title"] || "",
        Status: r["Status"] || "",
        "Variant Price": r[MATRIXIFY.priceCol] || "",
        "Variant Inventory Qty": r["Variant Inventory Qty"] || "",
        Reason: retiredInPlace
          ? "Retired in place -- variant discontinued, product still sells other sizes"
          : "Not present in AccountMate export",
        "Suggested Action": retiredInPlace
          ? "No action needed -- updated-products sets inventory 0 and policy deny"
          : "Mark inactive",
      });
    }
  }

  // --- duplicate Size within a product ------------------------------------
  // Size is now the ONLY variant option, so it alone identifies a variant.
  // Shopify rejects two variants sharing an option value. This must cover NEW
  // products as well as variants added to existing ones -- an earlier version
  // checked only the latter and missed AXPG-6-W39G2/G4, which both report UoM
  // GALKIT and so both resolve to "1 Gallon Kit".
  const combos = new Map();
  for (const r of newRows) {
    const k = `${r[MATRIXIFY.handleCol]}||${(r["Option1 Value"] || "").trim()}`;
    if (!combos.has(k)) combos.set(k, []);
    combos.get(k).push(r[MATRIXIFY.skuCol]);
  }
  // Existing variants of a product occupy sizes too.
  for (const r of baseRows) {
    const k = `${r[MATRIXIFY.handleCol]}||${(r["Option1 Value"] || "").trim()}`;
    if (combos.has(k)) combos.get(k).push(`${r[MATRIXIFY.skuCol]} (existing)`);
  }
  const dupCombos = [...combos.entries()].filter(([, v]) => v.length > 1);

  // --- report -------------------------------------------------------------
  console.log("--- Summary ---");
  const retiredListed = deletedRows.filter((r) => r.Reason.startsWith("Retired in place")).length;
  console.log(
    `  deleted-products : ${deletedRows.length} rows` +
      (retiredListed ? `  (${retiredListed} retired in place, ${deletedRows.length - retiredListed} to retire)` : "") +
      (archivedSkipped ? `  [${archivedSkipped} archived skipped]` : ""),
  );
  const changedRowCount = updatedRows.filter((r) => r.__changed).length;
  console.log(
    `  updated-products : ${updatedRows.length} rows -- ${changedRowCount} changed, ` +
      `${updatedRows.length - changedRowCount} unchanged` +
      (changedOnly ? " [--changed-only]" : ` (mirrors the ${baseRows.length}-row baseline)`),
  );
  if (retiredVariants) {
    console.log(`      variants retired in place: ${retiredVariants}  (qty 0 + policy deny)`);
  }
  console.log(`  new-products     : ${newRows.length} rows`);
  console.log(`      new products created   : ${triage.newProducts}`);
  console.log(`      sizes added to existing: ${triage.addedVariants}`);
  if (triage.noSize) console.log(`      UNRESOLVED size        : ${triage.noSize}  (blocks import)`);
  if (triage.noColour) console.log(`      awaiting a colour      : ${triage.noColour}  (metafield only, does not block)`);
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
    console.log(`\n  DUPLICATE SIZE within a product -- Shopify rejects these:`);
    dupCombos.slice(0, 8).forEach(([k, v]) => {
      const [h, c] = k.split("||");
      console.log(`    ${h}`);
      console.log(`      "${c}" claimed by: ${v.join("  |  ")}`);
    });
    console.log(`    Usually AccountMate's UoM is too coarse to tell two pack`);
    console.log(`    sizes apart. Fix UOM_TO_SIZE / SKU_SUFFIX_SIZE_OVERRIDE, or`);
    console.log(`    drop one row before importing.`);
  }

  // Split out rows Shopify would reject, so new-products is directly
  // importable. Nothing is dropped -- blocked rows go to their own file with
  // the reason, and rejoin automatically once the underlying issue is fixed.
  const blockedSkus = new Map();
  for (const r of newRows) {
    if ((r["Option1 Value"] || "") === "NEEDS-SIZE") {
      blockedSkus.set(r[MATRIXIFY.skuCol], "size could not be resolved from AccountMate");
    }
  }
  for (const [key, skus] of dupCombos) {
    const [, size] = key.split("||");
    // Keep the first claimant, block the rest -- they collide on Size.
    skus.filter((x) => !x.endsWith("(existing)")).slice(1).forEach((sku) =>
      blockedSkus.set(sku, `duplicate Size "${size}" within this product`),
    );
  }
  const importableNewRows = newRows.filter((r) => !blockedSkus.has(r[MATRIXIFY.skuCol]));
  const blockedNewRows = newRows.filter((r) => blockedSkus.has(r[MATRIXIFY.skuCol]));

  if (dryRun) {
    console.log("\n[dry run] nothing written.");
    return;
  }

  // --- write --------------------------------------------------------------
  fs.mkdirSync(outdir, { recursive: true });
  const version = nextVersion(outdir, date);

  const idCols = ["ID", "Variant ID"];
  // Columns for updated-products. newProductsOnly fields are omitted: with
  // clear-on-blank semantics, merely including the column would wipe the value.
  const mappedCols = MATRIXIFY_FIELD_MAP.filter((f) => !f.newProductsOnly).flatMap((f) => [
    f.col,
    ...Object.keys(f.companions || {}),
  ]);
  const newOnlyCols = MATRIXIFY_FIELD_MAP.filter((f) => f.newProductsOnly).map((f) => f.col);
  const updHeaders = [
    ...idCols,
    "Tags",
    "Tags Command",
    APPROVED_SPECS_COL,
    MEETS_SPECS_COL,
    // Written when a discontinued variant is retired in place (qty 0 + deny).
    "Variant Inventory Policy",
    "Variant Inventory Tracker",
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
    ...newOnlyCols,
    MATRIXIFY.handleCol,
    MATRIXIFY.commandCol,
    MATRIXIFY.variantCommandCol,
    MATRIXIFY.skuCol,
    ...MATRIXIFY_NEW_COLUMNS,
    // Required: custom.size is a category metafield and is rejected on a
    // product with no category.
    ...CATEGORY_COLUMNS,
    "Metafield: custom.mil_specs [list.metaobject_reference]",
    "Metafield: custom.qpl [list.metaobject_reference]",
    "Metafield: custom.compliance_certifications [list.single_line_text_field]",
    "Metafield: custom.applications [list.single_line_text_field]",
    "Metafield: custom.parent_collection [collection_reference]",
    "Metafield: custom.nsn [single_line_text_field]",
    APPROVED_SPECS_COL,
    MEETS_SPECS_COL,
    "Tags",
    "Tags Command",
    SIZE_METAFIELD_COL,
    MIGRATION_COLOUR_PATTERN_COL,
    MIGRATION_SAE_COL,
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
  writeCSV(path.join(outdir, `new-products-${date}-${version}.csv`), newHeaders, strip(importableNewRows, newHeaders));
  if (blockedNewRows.length) {
    writeCSV(
      path.join(outdir, `new-products-BLOCKED-${date}-${version}.csv`),
      [...newHeaders, "__blockedBecause"],
      blockedNewRows.map((r) => ({ ...r, __blockedBecause: blockedSkus.get(r[MATRIXIFY.skuCol]) })),
    );
  }
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
        "Handle Source": r.__action,
      })),
    ],
  );
  writeCSV(colorMapPath, COLOR_MAP_HEADERS, [...colorMap.values()]);

  console.log(`\nWrote to ${outdir}/`);
  console.log(`  updated-products-${date}-${version}.csv  (${updatedRows.length} rows, Command: MERGE)`);
  console.log(`  new-products-${date}-${version}.csv      (${importableNewRows.length} rows, ready to import)`);
  if (blockedNewRows.length) {
    console.log(`  new-products-BLOCKED-${date}-${version}.csv  (${blockedNewRows.length} rows held back)`);
    blockedNewRows.forEach((r) =>
      console.log(`      ${r[MATRIXIFY.skuCol].padEnd(24)}${blockedSkus.get(r[MATRIXIFY.skuCol])}`),
    );
  }
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
