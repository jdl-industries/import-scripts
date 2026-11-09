#!/usr/bin/env node

/**
 * Sync Shopify catalog against AccountMate -- Matrixify edition
 *
 * Five output streams, split by trust level and review burden:
 *
 *   1. basic-updates    SKU already in Shopify. AccountMate-trusted fields
 *                        (SHOPIFY_FIELD_MAP, requireManualReview: false)
 *                        written unconditionally -- no diffing, no Shopify
 *                        baseline dependency at all.
 *   2. review-updates    SKU already in Shopify, but the AccountMate text
 *                        feeding a judgment-call field (colour, spec
 *                        references, manufacturer, MPN, title/handle inputs)
 *                        changed since the PREVIOUS AccountMate export.
 *                        Flagged for a human, never auto-written.
 *   3. new-variants      SKU not in Shopify, but its computed product Handle
 *                        already exists -- add a variant, trusted fields
 *                        only, light review (confirm the grouping guess).
 *   4. new-products       SKU not in Shopify, Handle doesn't exist either --
 *                        full review, same as the historical new-product flow.
 *   5. deleted-products  SKU in Shopify, absent from current AccountMate.
 *
 * Only stream 2 needs a PREVIOUS AccountMate export (an ordinary CLI arg --
 * the repo already keeps a long history of dated exports, there is nothing
 * to auto-manage). Streams 1/3/4/5 only need a lightweight Shopify IDENTITY
 * export (SKU / Handle / Status / Tags) -- never the
 * full ~25-metafield Matrixify template that caused a bug when its template
 * drifted (a missing column was silently written unconditionally while
 * being *reported* as "changed").
 *
 * Usage:
 *   node sync-matrixify.js <accountmate.csv> <prev-accountmate.csv> <shopify-identity.csv> [options]
 *
 * Options:
 *   --outdir <dir>   Output directory (default: ./output)
 *   --date <date>    Override the {date} stamp (default: today)
 *   --dry-run        Report only, write nothing
 *   --verbose        Per-SKU change detail
 */

import fs from "fs";
import path from "path";
import { specHandle, baseSpec, expandSpec } from "./spec-parser.mjs";
import { readAccountMate, specStrings } from "./accountmate.mjs";
import {
  SURCHARGE,
  UOM_TO_SIZE,
  SKU_SUFFIX_SIZE_OVERRIDE,
  SKU_SUFFIX_OVERRIDE_ORDER,
  NEW_PRODUCT_HANDLE,
  COLOR_PATTERNS,
  COLOR_SCOPE_CONFIDENCE,
  COLOR_MAP_FILE,
  NEW_PRODUCT_DEFAULTS,
  MATRIXIFY,
  SHOPIFY_FIELD_MAP,
  MATRIXIFY_COLUMNS,
  PRODUCT_CATEGORY,
  CATEGORY_COLUMNS,
  classifyCategory,
  PRODUCT_TYPE,
  manufacturerInfo,
  typeFromAccountMateCategory,
  genericSpecFrom,
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

/**
 * Set once at creation, then owned by hand -- never re-synced. AccountMate's
 * vendor part number is too unreliable to resync blind (it has carried
 * values like "PAINT" and "JDL-12"), so streams 1/2 never touch it.
 */
function isNewProductsOnly(entry) {
  return !!entry.newProductsOnly;
}

/**
 * Trusted (requireManualReview: false) SHOPIFY_FIELD_MAP entries, written
 * from the current AccountMate row's OWN data -- no baseline, no diffing.
 * `includeNewProductsOnly` is true only when creating a variant/product
 * (streams 3/4); streams 1/2 never include those columns at all, because a
 * blank cell would clear a hand-corrected value.
 */
function buildTrustedColumns(amRow, identityRow, includeNewProductsOnly) {
  const out = {};
  for (const entry of SHOPIFY_FIELD_MAP) {
    if (entry.requireManualReview) continue;
    if (isNewProductsOnly(entry) && !includeNewProductsOnly) continue;
    if (!entry.fn) continue;
    const col = MATRIXIFY_COLUMNS[entry.output];
    if (!col) continue;
    out[col] = entry.fn(
      amRow,
      AM,
      identityRow,
      computePricing,
      typeFromAccountMateCategory,
    );
  }
  return out;
}

const REVIEW_ENTRIES = SHOPIFY_FIELD_MAP.filter((e) => e.requireManualReview);
const REVIEW_SOURCE_FIELDS = [
  ...new Set(REVIEW_ENTRIES.flatMap((e) => e.sources)),
];

/** The derivation a human reviewer sees as a suggestion -- only the three
 * fields with a safe, deterministic re-derivation get one. */
function suggestReviewValue(output, amRow) {
  if (output === "colour") {
    const g = extractColor(
      getField(amRow, "colorSpecs") || getField(amRow, "shortDescription"),
    );
    return g ? g.value : "";
  }
  if (output === "approvedSpecifications") {
    return specMetafields(amRow)[APPROVED_SPECS_COL];
  }
  if (output === "meetsSpecifications") {
    return specMetafields(amRow)[MEETS_SPECS_COL];
  }
  return ""; // mpnReview / vendorHandlePrefixCategory / titleHandleInputs: flag only
}

/**
 * Which REVIEW_ENTRIES fired between the previous and current AccountMate
 * export for one SKU, by comparing the raw source text -- plain string
 * compare, trimmed. Every reviewed field is text (description, colour
 * specs, QPL, manufacturer, ...), so none of the numeric/dimension
 * reconciliation the old Shopify-baseline diff needed applies here.
 */
function diffReviewFields(prevAmRow, curAmRow) {
  const text = {};
  for (const f of REVIEW_SOURCE_FIELDS) {
    text[f] = {
      prev: String(getField(prevAmRow, f) || "").trim(),
      current: String(getField(curAmRow, f) || "").trim(),
    };
  }
  const triggered = REVIEW_ENTRIES.filter((e) =>
    e.sources.some((f) => text[f].prev !== text[f].current),
  ).map((e) => e.output);
  return { triggered, text };
}

/**
 * compliance_certifications is a list metafield holding ONE element whose text
 * is semicolon-delimited -- ["a; b; c"], not ["a","b","c"]. That is the shape
 * the catalog already uses and what the storefront expects.
 */
function jsonBlob(v) {
  const parts = String(v || "")
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length ? JSON.stringify([parts.join("; ")]) : "";
}

/**
 * Shopify price derived from AccountMate: base price plus whatever surcharge
 * AccountMate reports (amount wins over percent). One place, so streams 1, 3
 * and 4 cannot drift against each other.
 */
function computePricing(amRow) {
  const base = parseFloat(getField(amRow, SURCHARGE.basePriceField));
  const amount = parseFloat(getField(amRow, SURCHARGE.amountField)) || 0;
  const percent = parseFloat(getField(amRow, SURCHARGE.percentField)) || 0;

  let surcharge = 0;
  if (amount > 0) {
    surcharge = amount;
  } else if (percent > 0 && Number.isFinite(base)) {
    surcharge = +(base * (percent / 100)).toFixed(2);
  }

  return { price: Number.isFinite(base) ? (base + surcharge).toFixed(2) : "" };
}

// --- colour extraction (unchanged logic, see SYNC.md) ----------------------

const decodeDescription = (d) =>
  String(d || "")
    .replace(/\\n/g, "\n")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');

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
  const pickField = (r, name) =>
    (r[`Confirmed ${name}`] || "").trim() ||
    (r[`Drafted ${name}`] || "").trim();
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
  const clean = (list) => [
    ...new Set(
      list.flatMap((x) => expandSpec(x)).filter((x) => x && x.length > 2),
    ),
  ];
  return { approved: clean(raw.approved), meets: clean(raw.meets) };
}

const APPROVED_SPECS_COL =
  "Metafield: custom.approved_specifications [list.metaobject_reference]";
const MEETS_SPECS_COL =
  "Metafield: custom.meets_specifications [list.metaobject_reference]";

/**
 * Base-specification tags for a product.
 *
 * Metafields are not indexed by Shopify search, but tags are -- and buyers
 * commonly search the base number ("mil-prf-85285") rather than the full
 * qualified spec. Every specification the product meets OR is approved for
 * contributes its base. Where a spec IS its own base ("MEP 10-068") the title
 * is used directly.
 */
const tagSlug = (v) =>
  String(v)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Searchable tags for a product: the BASE of every spec met or approved, the
 * series code, the NSN, and any colour code found in the colour specs text.
 */
function specBaseTags(amRow) {
  const { approved, meets } = productSpecs(amRow);
  const tags = [...approved, ...meets].map((t) => tagSlug(baseSpec(t) || t));

  const series = getField(amRow, "series");
  if (series) tags.push(tagSlug(series));

  const nsn = getField(amRow, "nsn");
  if (nsn) tags.push(tagSlug(nsn));

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
  const cur = String(existing || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
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
  const refs = (list) =>
    list.map((t) => `product_specification.${specHandle(t)}`).join(", ");
  return {
    [APPROVED_SPECS_COL]: refs(approved),
    [MEETS_SPECS_COL]: refs(meets),
  };
}

const MIGRATION_COLOUR_PATTERN_COL =
  "Metafield: shopify.color-pattern [list.metaobject_reference]";
const MIGRATION_SAE_COL =
  "Metafield: custom.sae_color [single_line_text_field]";

// --- grouping --------------------------------------------------------------

/**
 * Product identity under the current architecture: one product per colour /
 * chemistry, with Size as the only variant axis. The product is therefore the
 * SKU with its size token stripped.
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

function stripKnownSizeSuffix(text) {
  const v = normalizeSku(text);
  for (const t of SIZE_TOKENS)
    if (v.endsWith(t)) return v.slice(0, -t.length).trim();
  return v;
}

function skuBase(sku, info) {
  const custom = info?.groupKey?.(sku);
  if (custom) return normalizeSku(custom);
  return stripKnownSizeSuffix(sku);
}

/**
 * MPN for a non-Hentzen manufacturer with no partNumberFrom() of its own.
 * Vendor part number is NOT a reliable source on its own, so it only wins
 * when it is recognizably the SAME identifier as the SKU-derived base.
 */
function defaultPartNumber(sku, vendorPartNumber, info) {
  const skuMpn = skuBase(sku, info);
  const vpn = stripKnownSizeSuffix(vendorPartNumber);
  const alnum = (s) =>
    String(s || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  const a = alnum(vpn);
  const b = alnum(skuMpn);
  const related =
    a.length >= 3 &&
    b.length >= 3 &&
    (a === b || a.includes(b) || b.includes(a));
  const purelyNumeric = /^[0-9]+$/.test(a);
  return related && !purelyNumeric ? vpn : skuMpn;
}

/**
 * Size resolution, AccountMate first:
 *   1. a manufacturer-specific override (e.g. 3M's width-from-SKU)
 *   2. an unambiguous SKU suffix
 *   3. the Unit of Measure map
 * Unresolved is reported, never defaulted: a wrong size mislabels what ships.
 */
function resolveSize(sku, amRow, info) {
  const custom = info?.resolveSize?.(sku, amRow);
  if (custom) return custom;
  const s = normalizeSku(sku);
  for (const token of SKU_SUFFIX_OVERRIDE_ORDER) {
    if (s.endsWith(token.toUpperCase())) {
      return { value: SKU_SUFFIX_SIZE_OVERRIDE[token], source: "SKU suffix" };
    }
  }
  if (amRow) {
    const uom = getField(amRow, "unitOfMeasure").toUpperCase();
    if (UOM_TO_SIZE[uom])
      return { value: UOM_TO_SIZE[uom], source: "AccountMate UoM" };
    if (uom) return { value: "", source: "", unmappedUom: uom };
  }
  return { value: "", source: "" };
}

const slug = (v) =>
  String(v)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * {manufacturer-prefix}-{mpn}[-{spec}], per the agreed scheme. This is also
 * the trust anchor for stream classification: a new SKU whose computed
 * handle already exists in the Shopify identity export is a NEW VARIANT of
 * that product, not a new product.
 */
function buildHandle(amRow, sku) {
  const info = manufacturerInfo(getField(amRow, "manufacturer"));
  const isHentzen = !info || info.handlePrefix === "hentzen";

  if (!isHentzen) {
    const prefix = info.handlePrefix || slug(getField(amRow, "manufacturer"));
    const mpn =
      info.partNumberFrom?.(getField(amRow, "description")) ||
      defaultPartNumber(sku, getField(amRow, "vendorPartNumber"), info);
    const descriptor = getField(amRow, "shortDescription");
    const spec = genericSpecFrom(getField(amRow, "qpl"), descriptor);
    return [prefix, slug(mpn), slug(descriptor), spec ? slug(spec) : ""]
      .filter(Boolean)
      .join("-");
  }

  let mpn = NEW_PRODUCT_HANDLE.normalizeMpn(skuBase(sku));
  const spec = NEW_PRODUCT_HANDLE.specFrom(amRow);
  return [NEW_PRODUCT_HANDLE.prefix, slug(mpn), spec ? slug(spec) : ""]
    .filter(Boolean)
    .join("-");
}

// ===========================================================================
// Shopify identity export
// ===========================================================================

/**
 * The lightweight Shopify export streams 1/3/4/5 need: SKU, Handle, and the
 * two product-level columns Matrixify only populates on a product's top row
 * (Status, Tags) -- carried forward by Handle so every row, not just the
 * first, reads correctly.
 */
function loadIdentityExport(file) {
  const { rows } = parseCSV(fs.readFileSync(file, "utf-8"));
  const carryCols = ["Status", "Tags"];
  const carry = new Map();
  for (const r of rows) {
    const h = r[MATRIXIFY.handleCol];
    if (!carry.has(h)) carry.set(h, {});
    const c = carry.get(h);
    for (const col of carryCols)
      if ((r[col] || "").trim() !== "") c[col] = r[col];
  }
  return rows.map((r) => {
    const c = carry.get(r[MATRIXIFY.handleCol]) || {};
    const out = { ...r };
    for (const col of carryCols) {
      if ((out[col] || "").trim() === "" && c[col] != null) out[col] = c[col];
    }
    return out;
  });
}

/**
 * Classify a current-AccountMate SKU that has no exact match in Shopify:
 * "new-variant" if its computed handle already exists (add it to that
 * product), "new-product" otherwise. The Handle set from the identity
 * export is the trust anchor -- not a recomputed SKU-base lookup -- so the
 * risk this rests on (buildHandle() determinism) is visible and reviewable,
 * not buried in an internal grouping key.
 */
function classifyMatch(amRow, sku, identitySkuSet, identityHandleSet) {
  if (identitySkuSet.has(sku)) return "basic";
  const handle = buildHandle(amRow, sku);
  return identityHandleSet.has(handle) ? "new-variant" : "new-product";
}

// ===========================================================================
// Main
// ===========================================================================

function nextVersion(outdir, date) {
  let v = 1;
  while (fs.existsSync(path.join(outdir, `basic-updates-${date}-v${v}.csv`)))
    v++;
  return `v${v}`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length < 3) {
    console.log(`
Sync Shopify catalog against AccountMate (Matrixify format)

Usage:
  node sync-matrixify.js <accountmate.csv> <prev-accountmate.csv> <shopify-identity.csv> [options]

Options:
  --outdir <dir>   Output directory (default: ./output)
  --date <date>    Override the {date} stamp (default: today)
  --dry-run        Report only, write nothing
  --verbose        Per-SKU change detail

<prev-accountmate.csv> is whatever AccountMate export was used last time --
the repo already keeps a long history of dated exports; pick a recent one.
It drives review-updates.csv only; streams 1/3/4/5 don't need it.

<shopify-identity.csv> is a lightweight Matrixify export: SKU, Handle,
Status, Tags, and ideally ID/Variant ID. It is NOT the full metafield-rich
export the old two-argument version needed.
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
    [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-"),
  );
  const positional = args.filter(
    (a, i) =>
      !a.startsWith("--") && !["--outdir", "--date"].includes(args[i - 1]),
  );
  const [amFile, prevAmFile, identityFile] = positional;

  AM = readAccountMate(amFile);
  const amRows = AM.rows;
  const prevAM = readAccountMate(prevAmFile);
  const identityRows = loadIdentityExport(identityFile);

  console.log(
    `AccountMate (current):  ${amFile}  (${amRows.length} rows, ${AM.format} format)`,
  );
  console.log(
    `AccountMate (previous): ${prevAmFile}  (${prevAM.rows.length} rows, ${prevAM.format} format)`,
  );
  if (prevAM.format !== AM.format) {
    console.log(
      `  NOTE: export format changed between runs (${prevAM.format} -> ${AM.format}).`,
    );
  }
  console.log(
    `Shopify identity:        ${identityFile}  (${identityRows.length} rows)\n`,
  );

  // --- index --------------------------------------------------------------
  // Matching is against the ACTIVE catalog only. A SKU can legitimately
  // appear on an Archived product left over from a past consolidation --
  // that's not a conflict, Shopify just hasn't had the stale record cleaned
  // up yet. Only a SKU live on more than one ACTIVE product is a real
  // problem worth refusing to guess at.
  const isActive = (r) => (r["Status"] || "").trim().toLowerCase() === "active";
  const isActiveOrDraft = (r) =>
    (r["Status"] || "").trim().toLowerCase() === "active" ||
    (r["Status"] || "").trim().toLowerCase() === "draft";

  const activeIdentityRows = identityRows.filter(isActiveOrDraft);

  const identityBySku = new Map();
  const identityByHandle = new Map();
  const handlesBySku = new Map();
  for (const r of activeIdentityRows) {
    const sku = normalizeSku(r[MATRIXIFY.skuCol]);
    if (sku) identityBySku.set(sku, r);
    const h = r[MATRIXIFY.handleCol];
    if (h && !identityByHandle.has(h)) identityByHandle.set(h, r);
    if (sku && h) {
      if (!handlesBySku.has(sku)) handlesBySku.set(sku, new Set());
      handlesBySku.get(sku).add(h);
    }
  }
  const ambiguousSkus = [...handlesBySku.entries()].filter(
    ([, handles]) => handles.size > 1,
  );
  if (ambiguousSkus.length) {
    console.log(
      `\n  SKU live on more than one ACTIVE Shopify product -- excluded ` +
        `from basic-updates, needs manual resolution (${ambiguousSkus.length}):`,
    );
    ambiguousSkus.forEach(([sku, handles]) =>
      console.log(`    ${sku}: ${[...handles].join("  |  ")}`),
    );
  }
  const ambiguousSkuSet = new Set(ambiguousSkus.map(([sku]) => sku));
  const identitySkuSet = new Set(identityBySku.keys());
  const identityHandleSet = new Set(identityByHandle.keys());

  const amBySku = new Map();
  const prevAmBySku = new Map();
  for (const r of amRows) {
    const raw = AM.get(r, "sku");
    if (raw) amBySku.set(normalizeSku(raw), r);
  }
  for (const r of prevAM.rows) {
    const raw = prevAM.get(r, "sku");
    if (raw) prevAmBySku.set(normalizeSku(raw), r);
  }

  // A SKU AccountMate currently wants to sell, but with no ACTIVE Shopify
  // record at all (every existing match -- if any -- is Archived/Draft).
  // Different from a genuine "new" SKU: this one has history, it's just not
  // live right now. Falls through to the new-product flow either way, but
  // worth its own signal rather than no explanation at all.
  const archivedOnlySkus = [...amBySku.keys()].filter(
    (sku) =>
      !identityBySku.has(sku) &&
      identityRows.some((r) => normalizeSku(r[MATRIXIFY.skuCol]) === sku),
  );
  if (archivedOnlySkus.length) {
    console.log(
      `\n  AccountMate SKU with no ACTIVE Shopify match (existing record(s) ` +
        `are Archived/Draft) -- treated as new, needs a reactivate-or-` +
        `create decision (${archivedOnlySkus.length}): ${archivedOnlySkus.join(", ")}`,
    );
  }

  const wsOnly = [];
  for (const r of amRows) {
    const raw = AM.get(r, "sku");
    if (!raw) continue;
    const sku = normalizeSku(raw);
    if (raw !== sku && identitySkuSet.has(sku)) {
      const exact = identityRows.some(
        (b) => (b[MATRIXIFY.skuCol] || "").trim() === raw,
      );
      if (!exact) wsOnly.push(raw);
    }
  }
  if (wsOnly.length) {
    console.log(
      `SKUs matched only after whitespace normalization (${wsOnly.length}):`,
    );
    wsOnly.forEach((s) => console.log(`  ${JSON.stringify(s)}`));
    console.log("  ^ worth fixing at the source in AccountMate\n");
  }

  // --- classify -------------------------------------------------------------
  const basicSkus = [];
  const newVariantSkus = [];
  const newProductSkus = [];
  for (const [sku, amRow] of amBySku) {
    const bucket = classifyMatch(amRow, sku, identitySkuSet, identityHandleSet);
    if (bucket === "basic") basicSkus.push({ sku, amRow });
    else if (bucket === "new-variant") newVariantSkus.push({ sku, amRow });
    else newProductSkus.push({ sku, amRow });
  }
  const deletedSkus = [...identitySkuSet].filter((s) => !amBySku.has(s));
  console.log(
    `Basic: ${basicSkus.length}   New variants: ${newVariantSkus.length}   ` +
      `New products: ${newProductSkus.length}   Deleted: ${deletedSkus.length}\n`,
  );

  // --- colour map ---------------------------------------------------------
  const contentMap = loadContentMap(CONTENT_MAP_FILE);
  const colorMapPath = path.join(outdir, COLOR_MAP_FILE);
  const colorMap = loadColorMap(colorMapPath);
  let added = 0;
  for (const { sku, amRow } of [...newVariantSkus, ...newProductSkus]) {
    if (colorMap.has(sku)) continue;
    const g = extractColor(
      getField(amRow, "colorSpecs") || getField(amRow, "shortDescription"),
    );
    colorMap.set(sku, {
      SKU: sku,
      "Confirmed Color": "",
      "Extracted Guess": g ? g.value : "",
      Source: g ? g.source : "",
      Confidence: g ? g.confidence : "",
      "AccountMate Color": getField(amRow, "colorSpecs"),
      Evidence: g
        ? g.snippet
        : getField(amRow, "colorSpecs") ||
          getField(amRow, "shortDescription").slice(0, 120),
    });
    added++;
  }
  const confirmed = [...colorMap.values()].filter((r) =>
    (r["Confirmed Color"] || "").trim(),
  ).length;
  console.log(
    `Content:    ${contentMap.size} authored products (${CONTENT_MAP_FILE})`,
  );
  console.log(
    `Colour map: ${colorMap.size} entries (${added} newly queued, ${confirmed} confirmed)\n`,
  );

  // --- tags helper ----------------------------------------------------------
  const TAGS_COL = "Tags";
  const TAGS_COMMAND_COL = "Tags Command";
  function tagColumns(amRow, currentTags) {
    const merged = mergeTags(currentTags, specBaseTags(amRow));
    const tags = merged !== null ? merged : currentTags || "";
    return tags ? { [TAGS_COL]: tags, [TAGS_COMMAND_COL]: "REPLACE" } : {};
  }

  // --- stream 1: basic updates ---------------------------------------------
  // Walk the IDENTITY export in its own row order, not AccountMate's --
  // Matrixify rejects a Handle or ID that reappears after other rows, and
  // the identity export (a real Matrixify export) already groups every
  // Handle's rows contiguously, so mirroring its order gives that for free.
  // `identityBySku` (built above) is already deduplicated to one row per
  // SKU -- the raw export can repeat a SKU across rows (one per image), and
  // iterating it directly would emit a duplicate basic-updates row for
  // each repeat. Map iteration order tracks first-insertion order, so
  // dedup doesn't disturb the Handle grouping.
  const basicAmBySku = new Map(
    basicSkus
      .filter(({ sku }) => !ambiguousSkuSet.has(sku))
      .map(({ sku, amRow }) => [sku, amRow]),
  );
  const basicRows = [];
  for (const [sku, identityRow] of identityBySku) {
    const amRow = basicAmBySku.get(sku);
    if (!amRow) continue;
    const row = {
      Action: "basic",
      "Variant SKU": identityRow[MATRIXIFY.skuCol],
      Handle: identityRow[MATRIXIFY.handleCol],
      "Review Reason": "",
      [MATRIXIFY.commandCol]: MATRIXIFY.command,
      [MATRIXIFY.variantCommandCol]: MATRIXIFY.command,
      ...buildTrustedColumns(amRow, identityRow, false),
      ...tagColumns(amRow, identityRow[TAGS_COL]),
    };
    if (identityRow["ID"]) row["ID"] = identityRow["ID"];
    if (identityRow["Variant ID"])
      row["Variant ID"] = identityRow["Variant ID"];

    const prevAmRow = prevAmBySku.get(sku);
    row["Changed Fields"] = prevAmRow
      ? diffReviewFields(prevAmRow, amRow).triggered.join("; ")
      : "";
    basicRows.push(row);
    if (verbose && row["Changed Fields"])
      console.log(`  BASIC ${sku}: ${row["Changed Fields"]}`);
  }

  // --- stream 2: review required --------------------------------------------
  // One row per HANDLE, not per SKU: product-scoped AccountMate fields
  // (manufacturer, colour specs, QPL, meets specs) repeat identically across
  // every size variant of the same product, so diffing per-SKU would
  // produce N near-identical review rows for one real decision.
  const reviewByHandle = new Map();
  for (const { sku, amRow } of basicSkus) {
    const prevAmRow = prevAmBySku.get(sku);
    if (!prevAmRow) continue;
    const { triggered, text } = diffReviewFields(prevAmRow, amRow);
    if (!triggered.length) continue;
    const handle = identityBySku.get(sku)[MATRIXIFY.handleCol];
    if (!reviewByHandle.has(handle)) {
      reviewByHandle.set(handle, {
        Handle: handle,
        skus: new Set(),
        triggered: new Set(),
        text: {},
        suggestions: {},
      });
    }
    const entry = reviewByHandle.get(handle);
    entry.skus.add(sku);
    for (const output of triggered) {
      entry.triggered.add(output);
      if (!entry.suggestions[output]) {
        entry.suggestions[output] = suggestReviewValue(output, amRow);
      }
    }
    for (const f of REVIEW_SOURCE_FIELDS) {
      if (!entry.text[f]) entry.text[f] = text[f];
    }
  }
  const reviewRows = [...reviewByHandle.values()].map((entry) => {
    const row = {
      Action: "review",
      "Variant SKU": [...entry.skus].join(" | "),
      Handle: entry.Handle,
      "Review Reason": [...entry.triggered].join("; "),
    };
    for (const f of REVIEW_SOURCE_FIELDS) {
      row[`Prev AM: ${f}`] = entry.text[f]?.prev || "";
      row[`Current AM: ${f}`] = entry.text[f]?.current || "";
    }
    for (const output of [
      "colour",
      "approvedSpecifications",
      "meetsSpecifications",
    ]) {
      if (!entry.triggered.has(output)) continue;
      row[`Suggested: ${output}`] = entry.suggestions[output] || "";
      row[`Confirmed: ${output}`] = "";
    }
    return row;
  });
  if (reviewRows.length) {
    console.log(`Review required: ${reviewRows.length} products\n`);
  }

  // --- stream 3: new variants of an existing product ------------------------
  const newVariantRows = [];
  const newVariantGroups = new Map();
  for (const { sku, amRow } of newVariantSkus) {
    const handle = buildHandle(amRow, sku);
    if (!newVariantGroups.has(handle)) newVariantGroups.set(handle, []);
    newVariantGroups.get(handle).push({ sku, amRow });
  }
  for (const [handle, members] of newVariantGroups) {
    const identityRow = identityByHandle.get(handle);
    for (const { sku, amRow } of members) {
      const info = manufacturerInfo(getField(amRow, "manufacturer"));
      const size = resolveSize(sku, amRow, info);
      const row = {
        Action: "new-variant",
        "Variant SKU": AM.get(amRow, "sku"),
        Handle: handle,
        "Review Reason":
          "confirm grouping: matched existing Handle via buildHandle()",
        [MATRIXIFY.commandCol]: MATRIXIFY.command,
        [MATRIXIFY.variantCommandCol]: MATRIXIFY.command,
        "Option1 Name": "Size",
        "Option1 Value": size.value || "NEEDS-SIZE",
        "Variant Inventory Tracker": "shopify",
        "Variant Inventory Policy": "deny",
        ...buildTrustedColumns(amRow, identityRow, true),
        ...tagColumns(amRow, identityRow?.[TAGS_COL]),
      };
      row.__sizeSource = size.source;
      newVariantRows.push(row);
    }
  }

  // --- stream 4: new products -----------------------------------------------
  const newProductRows = [];
  const triage = { newProducts: 0, noSize: 0, noColour: 0 };
  const newProductGroups = new Map();
  for (const { sku, amRow } of newProductSkus) {
    const base = skuBase(
      sku,
      manufacturerInfo(getField(amRow, "manufacturer")),
    );
    if (!newProductGroups.has(base)) newProductGroups.set(base, []);
    newProductGroups.get(base).push({ sku, amRow });
  }
  for (const [, members] of newProductGroups) {
    // Title no longer comes from here -- it's a straight AccountMate
    // pass-through (see below) -- so pick whichever member has an authored
    // Handle or Body HTML as the signal that this group has been curated.
    const groupContent =
      members
        .map(({ sku }) => contentMap.get(sku))
        .find((c) => c && (c.handle || c.body)) || null;

    const memberRows = [];
    for (const { sku, amRow } of members) {
      const info = manufacturerInfo(getField(amRow, "manufacturer"));
      const size = resolveSize(sku, amRow, info);
      if (!size.value) triage.noSize++;

      const colour = (colorMap.get(sku)?.["Confirmed Color"] || "").trim();
      if (!colour) triage.noColour++;

      const row = {
        Action: "new-product",
        [MATRIXIFY.commandCol]: MATRIXIFY.command,
        [MATRIXIFY.variantCommandCol]: MATRIXIFY.command,
        "Variant SKU": AM.get(amRow, "sku"),
        "Option1 Name": "Size",
        "Option1 Value": size.value || "NEEDS-SIZE",
        Handle: groupContent?.handle || buildHandle(amRow, sku),
        // Straight pass-through from AccountMate -- Shopify's Title matches
        // AccountMate's Short Description verbatim, no authoring involved.
        Title: getField(amRow, "shortDescription") || sku,
        "Body HTML": groupContent?.body || getField(amRow, "description") || "",
        Status: NEW_PRODUCT_DEFAULTS.Status,
        Published: NEW_PRODUCT_DEFAULTS.Published,
        Vendor:
          info?.vendor ||
          getField(amRow, "manufacturer") ||
          NEW_PRODUCT_DEFAULTS.Vendor,
        "Variant Taxable": "true",
        "Variant Inventory Tracker": "shopify",
        "Variant Inventory Policy": "deny",
        "Variant Fulfillment Service": "manual",
        "Variant Requires Shipping": "true",
        ...buildTrustedColumns(amRow, null, true),
        ...specMetafields(amRow),
      };

      const kind = info?.classify
        ? info.classify(getField(amRow, "shortDescription"))
        : classifyCategory(groupContent?.description, groupContent?.spec);
      Object.assign(row, PRODUCT_CATEGORY[kind]);
      row["Type"] =
        typeFromAccountMateCategory(getField(amRow, "categories")) ||
        PRODUCT_TYPE[kind];

      Object.assign(row, tagColumns(amRow, ""));

      const meta = {
        "Metafield: custom.mil_specs [list.metaobject_reference]": (
          groupContent?.milSpecs || ""
        )
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
          .map((h) =>
            h.startsWith("military_specification.")
              ? h
              : `military_specification.${h}`,
          )
          .join(", "),
        "Metafield: custom.qpl [list.metaobject_reference]": (
          groupContent?.qpl || ""
        )
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
          .map((h) =>
            h.startsWith("military_specification.")
              ? h
              : `military_specification.${h}`,
          )
          .join(", "),
        "Metafield: custom.compliance_certifications [list.single_line_text_field]":
          jsonBlob(groupContent?.compliance),
        "Metafield: custom.parent_collection [collection_reference]":
          groupContent?.parentCollection || "",
        "Metafield: custom.nsn [single_line_text_field]":
          groupContent?.nsn || "",
      };
      for (const [k, v] of Object.entries(meta)) if (v) row[k] = v;

      if (colour) {
        row[MIGRATION_COLOUR_PATTERN_COL] = colour.startsWith(
          "shopify--color-pattern.",
        )
          ? colour
          : `shopify--color-pattern.${colour}`;
        if (/^\d{5}$/.test(colour)) row[MIGRATION_SAE_COL] = colour;
      }

      row.__sizeSource = size.source;
      row["Review Reason"] = [
        !size.value ? "size" : "",
        !getField(amRow, "shortDescription") ? "title" : "",
        !groupContent?.body ? "description" : "",
        !colour ? "colour" : "",
        !row[MATRIXIFY_COLUMNS.variantPrice] ? "price" : "",
        !row[MATRIXIFY_COLUMNS.variantWeight] ? "weight" : "",
      ]
        .filter(Boolean)
        .join("; ");
      memberRows.push(row);
    }

    triage.newProducts++;
    newProductRows.push(...memberRows);
  }

  // --- hazmat tag ------------------------------------------------------------
  // Mirrors AccountMate directly: present if ANY SKU under the Handle is
  // hazardous. Applies uniformly across all three write streams.
  {
    const byHandle = new Map();
    for (const r of [...basicRows, ...newVariantRows, ...newProductRows]) {
      const h = r["Handle"];
      if (!h) continue;
      if (!byHandle.has(h)) byHandle.set(h, []);
      byHandle.get(h).push(r);
    }
    for (const group of byHandle.values()) {
      const isHazmat = group.some((r) => {
        const sku = normalizeSku(r["Variant SKU"]);
        const amRow = sku ? amBySku.get(sku) : null;
        return amRow && /^yes$/i.test(getField(amRow, "hazardous"));
      });
      for (const r of group) {
        const cur = String(r[TAGS_COL] ?? "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        const has = cur.some((t) => t.toLowerCase() === "hazmat");
        if (isHazmat === has) continue;
        r[TAGS_COL] = (
          isHazmat
            ? [...cur, "hazmat"]
            : cur.filter((t) => t.toLowerCase() !== "hazmat")
        ).join(", ");
        r[TAGS_COMMAND_COL] = "REPLACE";
      }
    }
  }

  // --- stream 5: deleted products --------------------------------------------
  const handleHasLiveVariant = new Set();
  for (const r of identityRows) {
    const k = normalizeSku(r[MATRIXIFY.skuCol]);
    if (k && amBySku.has(k)) handleHasLiveVariant.add(r[MATRIXIFY.handleCol]);
  }
  const isArchived = (r) => /^archived$/i.test((r["Status"] || "").trim());

  const deletedRows = [];
  // Discontinued variants whose product still sells other sizes get an
  // actual MERGE row here -- zero the stock, deny restock -- rather than
  // just a worklist entry. Narrow header, on purpose: the identity export
  // carries no variant metafields, so including those columns would clear
  // them. Tags/Type ARE echoed (they're product-level and would otherwise
  // be cleared for the whole product, not just this variant).
  const retiredRows = [];
  let archivedSkipped = 0;
  for (const sku of deletedSkus) {
    const r = identityBySku.get(sku);
    if (isArchived(r)) {
      archivedSkipped++;
      continue;
    }
    const retiredInPlace = handleHasLiveVariant.has(r[MATRIXIFY.handleCol]);
    if (retiredInPlace) {
      const row = {
        "Variant SKU": r[MATRIXIFY.skuCol],
        Handle: r[MATRIXIFY.handleCol],
        [MATRIXIFY.commandCol]: MATRIXIFY.command,
        [MATRIXIFY.variantCommandCol]: MATRIXIFY.command,
        "Variant Inventory Qty": "0",
        "Variant Inventory Policy": "deny",
        "Variant Inventory Tracker": "shopify",
      };
      if (r["ID"]) row["ID"] = r["ID"];
      if (r["Variant ID"]) row["Variant ID"] = r["Variant ID"];
      retiredRows.push(row);
    }
    deletedRows.push({
      Action: "deleted",
      "Variant SKU": r[MATRIXIFY.skuCol],
      Handle: r[MATRIXIFY.handleCol],
      "Review Reason": retiredInPlace ? "" : "mark inactive",
      Status: r["Status"] || "",
      Reason: retiredInPlace
        ? "Retired in place -- variant discontinued, product still sells other sizes"
        : "Not present in AccountMate export",
      "Suggested Action": retiredInPlace
        ? "No action needed -- see retired-variants.csv (qty 0, policy deny)"
        : "Mark inactive",
    });
  }

  // --- report -------------------------------------------------------------
  console.log("--- Summary ---");
  console.log(
    `  deleted-products : ${deletedRows.length} rows` +
      (archivedSkipped ? `  [${archivedSkipped} archived skipped]` : ""),
  );
  if (retiredRows.length)
    console.log(
      `  retired-variants : ${retiredRows.length} rows (qty 0, policy deny)`,
    );
  console.log(`  basic-updates    : ${basicRows.length} rows`);
  console.log(`  review-updates   : ${reviewRows.length} rows`);
  console.log(`  new-variants     : ${newVariantRows.length} rows`);
  console.log(
    `  new-products     : ${newProductRows.length} rows (${triage.newProducts} products)`,
  );
  if (triage.noSize)
    console.log(
      `      UNRESOLVED size        : ${triage.noSize}  (blocks import)`,
    );
  if (triage.noColour)
    console.log(
      `      awaiting a colour      : ${triage.noColour}  (metafield only, does not block)`,
    );

  // Split out rows Shopify would reject (an unresolved size only -- a
  // duplicate Size within a product is trusted not to occur, since
  // AccountMate's export is the complete, authoritative list of what
  // should be sold; if it ever does, Shopify rejects that row cleanly at
  // import time rather than this script guessing at it).
  const blockedSkus = new Map();
  for (const r of [...newVariantRows, ...newProductRows]) {
    if ((r["Option1 Value"] || "") === "NEEDS-SIZE") {
      blockedSkus.set(
        r["Variant SKU"],
        "size could not be resolved from AccountMate",
      );
    }
  }
  const importableNewVariantRows = newVariantRows.filter(
    (r) => !blockedSkus.has(r["Variant SKU"]),
  );
  const blockedNewVariantRows = newVariantRows.filter((r) =>
    blockedSkus.has(r["Variant SKU"]),
  );
  const importableNewProductRows = newProductRows.filter(
    (r) => !blockedSkus.has(r["Variant SKU"]),
  );
  const blockedNewProductRows = newProductRows.filter((r) =>
    blockedSkus.has(r["Variant SKU"]),
  );

  if (dryRun) {
    console.log("\n[dry run] nothing written.");
    return;
  }

  // --- write --------------------------------------------------------------
  fs.mkdirSync(outdir, { recursive: true });
  const version = nextVersion(outdir, date);

  const commonCols = ["Action", "Variant SKU", "Handle", "Review Reason"];
  const idCols = ["ID", "Variant ID"];
  const trustedCols = Object.values(MATRIXIFY_COLUMNS).filter(
    (c) => c !== MATRIXIFY_COLUMNS.mpnMetafield,
  );

  const basicHeaders = [
    ...commonCols,
    "Changed Fields",
    ...idCols,
    MATRIXIFY.commandCol,
    MATRIXIFY.variantCommandCol,
    ...trustedCols,
    TAGS_COL,
    TAGS_COMMAND_COL,
  ].filter((c, i, a) => a.indexOf(c) === i);

  const reviewHeaders = [
    ...commonCols,
    ...REVIEW_SOURCE_FIELDS.flatMap((f) => [
      `Prev AM: ${f}`,
      `Current AM: ${f}`,
    ]),
    ...["colour", "approvedSpecifications", "meetsSpecifications"].flatMap(
      (o) => [`Suggested: ${o}`, `Confirmed: ${o}`],
    ),
  ];

  const newVariantHeaders = [
    ...commonCols,
    MATRIXIFY.commandCol,
    MATRIXIFY.variantCommandCol,
    "Option1 Name",
    "Option1 Value",
    "Variant Inventory Tracker",
    "Variant Inventory Policy",
    ...trustedCols,
    MATRIXIFY_COLUMNS.mpnMetafield,
    TAGS_COL,
    TAGS_COMMAND_COL,
  ].filter((c, i, a) => a.indexOf(c) === i);

  const newProductHeaders = [
    ...commonCols,
    MATRIXIFY.commandCol,
    MATRIXIFY.variantCommandCol,
    "Option1 Name",
    "Option1 Value",
    "Title",
    "Body HTML",
    "Vendor",
    "Type",
    "Status",
    "Published",
    "Variant Taxable",
    "Variant Inventory Tracker",
    "Variant Inventory Policy",
    "Variant Fulfillment Service",
    "Variant Requires Shipping",
    ...CATEGORY_COLUMNS,
    "Metafield: custom.mil_specs [list.metaobject_reference]",
    "Metafield: custom.qpl [list.metaobject_reference]",
    "Metafield: custom.compliance_certifications [list.single_line_text_field]",
    "Metafield: custom.parent_collection [collection_reference]",
    "Metafield: custom.nsn [single_line_text_field]",
    APPROVED_SPECS_COL,
    MEETS_SPECS_COL,
    TAGS_COL,
    TAGS_COMMAND_COL,
    MIGRATION_COLOUR_PATTERN_COL,
    MIGRATION_SAE_COL,
    ...trustedCols,
    MATRIXIFY_COLUMNS.mpnMetafield,
  ].filter((c, i, a) => a.indexOf(c) === i);

  const strip = (rows, headers) =>
    rows.map((r) => {
      const o = {};
      headers.forEach((h) => (o[h] = r[h] ?? ""));
      return o;
    });

  writeCSV(
    path.join(outdir, `deleted-products-${date}-${version}.csv`),
    [
      "Action",
      "Variant SKU",
      "Handle",
      "Review Reason",
      "Status",
      "Reason",
      "Suggested Action",
    ],
    deletedRows,
  );
  if (retiredRows.length) {
    writeCSV(
      path.join(outdir, `retired-variants-${date}-${version}.csv`),
      [
        "Variant SKU",
        "Handle",
        "ID",
        "Variant ID",
        MATRIXIFY.commandCol,
        MATRIXIFY.variantCommandCol,
        "Variant Inventory Qty",
        "Variant Inventory Policy",
        "Variant Inventory Tracker",
      ],
      retiredRows,
    );
  }
  writeCSV(
    path.join(outdir, `basic-updates-${date}-${version}.csv`),
    basicHeaders,
    strip(basicRows, basicHeaders),
  );
  writeCSV(
    path.join(outdir, `review-updates-${date}-${version}.csv`),
    reviewHeaders,
    strip(reviewRows, reviewHeaders),
  );
  writeCSV(
    path.join(outdir, `new-variants-${date}-${version}.csv`),
    newVariantHeaders,
    strip(importableNewVariantRows, newVariantHeaders),
  );
  writeCSV(
    path.join(outdir, `new-products-${date}-${version}.csv`),
    newProductHeaders,
    strip(importableNewProductRows, newProductHeaders),
  );
  if (blockedNewVariantRows.length) {
    writeCSV(
      path.join(outdir, `new-variants-BLOCKED-${date}-${version}.csv`),
      [...newVariantHeaders, "__blockedBecause"],
      blockedNewVariantRows.map((r) => ({
        ...r,
        __blockedBecause: blockedSkus.get(r["Variant SKU"]),
      })),
    );
  }
  if (blockedNewProductRows.length) {
    writeCSV(
      path.join(outdir, `new-products-BLOCKED-${date}-${version}.csv`),
      [...newProductHeaders, "__blockedBecause"],
      blockedNewProductRows.map((r) => ({
        ...r,
        __blockedBecause: blockedSkus.get(r["Variant SKU"]),
      })),
    );
  }
  writeCSV(colorMapPath, COLOR_MAP_HEADERS, [...colorMap.values()]);

  console.log(`\nWrote to ${outdir}/`);
  console.log(
    `  basic-updates-${date}-${version}.csv     (${basicRows.length} rows, Command: MERGE)`,
  );
  console.log(
    `  review-updates-${date}-${version}.csv    (${reviewRows.length} rows, human review only)`,
  );
  console.log(
    `  new-variants-${date}-${version}.csv      (${importableNewVariantRows.length} rows)`,
  );
  console.log(
    `  new-products-${date}-${version}.csv      (${importableNewProductRows.length} rows)`,
  );
  console.log(
    `  deleted-products-${date}-${version}.csv  (${deletedRows.length} rows)`,
  );
  if (retiredRows.length)
    console.log(
      `  retired-variants-${date}-${version}.csv  (${retiredRows.length} rows, Command: MERGE)`,
    );
  console.log(`  ${COLOR_MAP_FILE}`);
  console.log(
    `\nEvery write row is Command: MERGE -- only the columns present are touched.`,
  );
}

main();
