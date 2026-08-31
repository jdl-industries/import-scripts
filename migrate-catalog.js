#!/usr/bin/env node

/**
 * One-time catalog migration: consolidated colour-variant products -> standalone
 * products with Size as the only variant axis.
 *
 * Emits numbered step files, each importable on its own via Matrixify. They are
 * ORDERED: step 01 must be imported and verified before step 04, because 04
 * retires the only place 33 products' colours currently exist.
 *
 *   01-colour-backfill   colours from consolidated rows -> standalone twins
 *   02-size-conversion   73 "Title/Default Title" products -> Size option
 *   03-new-standalone    orphan variants -> new standalone products
 *   04-retire-consolidated  the consolidated products, to archive
 *   05-product-family    metaobjects + product links
 *
 * Usage:
 *   node migrate-catalog.js <matrixify-export.csv> [--outdir dir] [--dry-run]
 */

import fs from "fs";
import path from "path";
import {
  MIGRATION,
  UOM_TO_SIZE,
  SKU_SUFFIX_SIZE_OVERRIDE,
  SKU_SUFFIX_OVERRIDE_ORDER,
  SIZE_RENAMES,
  SIZE_VOCABULARY,
  SIZE_METAOBJECT,
  SIZE_METAFIELD_COL,
  SIZE_VOCABULARY as SV_UNUSED,
  ATTRIBUTE_SLOTS,
} from "./sync-config.js";

// --------------------------------------------------------------------------
// CSV (shared shape with sync-matrixify.js)
// --------------------------------------------------------------------------
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
      headers = row.map((h, i) => (i === 0 ? h.replace(/^﻿/, "") : h).trim());
      first = false;
    } else if (row.some((f) => f !== "")) {
      const o = {};
      headers.forEach((h, i) => (o[h] = row[i] ?? ""));
      rows.push(o);
    }
    row = [];
  };
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    const n = content[i + 1];
    if (c === '"') {
      if (inQuotes && n === '"') {
        field += '"';
        i++;
      } else inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((c === "\n" || (c === "\r" && n === "\n")) && !inQuotes) {
      if (c === "\r") i++;
      endRow();
    } else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) endRow();
  return { headers, rows };
}

const esc = (v) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function writeCSV(file, headers, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [headers.map(esc).join(","), ...rows.map((r) => headers.map((h) => esc(r[h] ?? "")).join(","))].join("\n") + "\n",
  );
}

const normalizeSku = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");

// --------------------------------------------------------------------------
// Baseline hydration -- product-level fields sit only on a product's top row.
// --------------------------------------------------------------------------
const PRODUCT_LEVEL_EXTRA = [
  "Title",
  "Body HTML",
  "Vendor",
  "Type",
  "Tags",
  "Status",
  "Published",
  "Option1 Name",
  "Option2 Name",
  "Category",
];

function hydrate(rows, headers) {
  const cols = [...headers.filter((h) => /^Metafield:/.test(h)), ...PRODUCT_LEVEL_EXTRA.filter((c) => headers.includes(c))];
  const carry = new Map();
  for (const r of rows) {
    if (!carry.has(r.Handle)) carry.set(r.Handle, {});
    const c = carry.get(r.Handle);
    for (const col of cols) if ((r[col] || "").trim() !== "") c[col] = r[col];
  }
  return rows.map((r) => {
    const c = carry.get(r.Handle) || {};
    const o = { ...r };
    for (const col of cols) if ((o[col] || "").trim() === "" && c[col] != null) o[col] = c[col];
    o.__raw = r;
    return o;
  });
}

/**
 * "17875 (White Gloss)" -> "shopify--color-pattern.17875"
 * Derivable for 36 of 39 values; the rest are named in MIGRATION.colourHandleOverrides.
 */
function colourToHandle(display) {
  const d = String(display || "").trim();
  if (!d) return null;
  const override = MIGRATION.colourHandleOverrides[d];
  if (override) return `${MIGRATION.colourNamespace}.${override}`;
  const code = (d.match(/^([A-Za-z0-9][A-Za-z0-9-]*)/) || [])[1];
  if (!code) return null;
  return `${MIGRATION.colourNamespace}.${code.toLowerCase()}`;
}

/** The bare code, for custom.sae_color: "17875 (White Gloss)" -> "17875". */
function colourToCode(display) {
  const d = String(display || "").trim();
  if (!d) return "";
  const m = d.match(/^([A-Za-z0-9][A-Za-z0-9-]*)/);
  // Only FED-STD-shaped codes belong in sae_color; names like "Clear Flat" do not.
  return m && /^\d{5}$/.test(m[1]) ? m[1] : "";
}

function getAttr(row, name) {
  for (let i = 1; i <= ATTRIBUTE_SLOTS; i++) {
    if ((row[`Attribute ${i} name`] || "").trim() === name) {
      return (row[`Attribute ${i} value(s)`] || "").trim();
    }
  }
  return "";
}

/**
 * Resolve a variant's Size, in order of authority:
 *   1. a curated Size already in the catalog for that SKU (consolidated twin or
 *      an existing Size product) -- this is the user's own decision
 *   2. AccountMate's Unit of Measure, via the mined UOM_TO_SIZE map
 *   3. the SKU's trailing size token
 * Anything still unresolved is reported rather than defaulted, because guessing
 * a size silently mislabels what a customer receives.
 */
function resolveSize(sku, curatedSizes, amRow) {
  // AccountMate is the source of truth for size. An unambiguous SKU suffix wins
  // over the UoM, since UoM is coarser ("KIT" covers both a 5-gallon and a
  // 1.25-gallon kit).
  for (const token of SKU_SUFFIX_OVERRIDE_ORDER) {
    if (sku.endsWith(token.toUpperCase())) {
      return { size: SKU_SUFFIX_SIZE_OVERRIDE[token], source: "SKU suffix" };
    }
  }
  if (amRow) {
    const uom = getAttr(amRow, "Unit of Measure").toUpperCase();
    if (UOM_TO_SIZE[uom]) return { size: UOM_TO_SIZE[uom], source: "AccountMate UoM" };
    if (uom) return { size: null, source: null, unmappedUom: uom };
  }
  // Last resort: a size the catalog already committed to, renamed into the
  // current enumeration if needed.
  const curated = curatedSizes.get(sku);
  if (curated) return { size: SIZE_RENAMES[curated] || curated, source: "existing catalog" };
  return { size: null, source: null };
}

// --------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.includes("--help")) {
    console.log(`
One-time catalog migration

Usage:
  node migrate-catalog.js <matrixify-export.csv> [--outdir dir] [--dry-run]
`);
    process.exit(args.includes("--help") ? 0 : 1);
  }
  const flag = (n, d) => {
    const i = args.indexOf(n);
    return i >= 0 && args[i + 1] ? args[i + 1] : d;
  };
  const dryRun = args.includes("--dry-run");
  const outdir = flag("--outdir", "migration");
  const baseFile = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--outdir");
  const now = new Date();
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");

  const { headers, rows: raw } = parseCSV(fs.readFileSync(baseFile, "utf-8"));
  const rows = hydrate(raw, headers);

  const byHandle = new Map();
  for (const r of rows) {
    if (!byHandle.has(r.Handle)) byHandle.set(r.Handle, []);
    byHandle.get(r.Handle).push(r);
  }
  const bySku = new Map();
  for (const r of rows) {
    const k = normalizeSku(r["Variant SKU"]);
    if (!k) continue;
    if (!bySku.has(k)) bySku.set(k, []);
    bySku.get(k).push(r);
  }

  const isConsolidated = (v) => v[0]["Option1 Name"] === "Color";
  const consolidated = [...byHandle.entries()].filter(
    ([h, v]) => isConsolidated(v) && !MIGRATION.excludeHandles.includes(h),
  );
  const excluded = [...byHandle.keys()].filter((h) => MIGRATION.excludeHandles.includes(h));

  console.log(`Baseline: ${baseFile}`);
  console.log(`  ${rows.length} rows, ${byHandle.size} products`);
  console.log(`  consolidated (Color/Size): ${consolidated.length}${excluded.length ? `, excluded: ${excluded.join(", ")}` : ""}\n`);

  const CP = MIGRATION.colourPatternCol;
  const SAE = MIGRATION.saeColourCol;

  // ---- STEP 01: colour backfill ------------------------------------------
  // The consolidated rows are the ONLY place 33 products' colours live. This
  // must be imported and verified before step 04 retires them.
  const backfill = [];
  const unmapped = [];
  for (const [, variants] of consolidated) {
    for (const v of variants) {
      const sku = normalizeSku(v["Variant SKU"]);
      if (!sku) continue;
      const twins = (bySku.get(sku) || []).filter((x) => x.Handle !== v.Handle && x["Option1 Name"] !== "Color");
      if (!twins.length) continue;
      const display = (v["Option1 Value"] || "").trim();
      const handle = colourToHandle(display);
      if (!handle) {
        unmapped.push({ sku, display });
        continue;
      }
      for (const t of twins) {
        const hasCp = (t[CP] || "").trim();
        const hasSae = (t[SAE] || "").trim();
        if (hasCp && hasSae) continue; // already complete
        const row = {
          ID: t.__raw["ID"] || t["ID"] || "",
          Handle: t.Handle,
          Command: "MERGE",
          Title: t.Title,
          [CP]: hasCp || handle,
          [SAE]: hasSae || colourToCode(display),
          __source: `${v.Handle} / ${display}`,
          __filled: [!hasCp ? "color-pattern" : "", !hasSae && colourToCode(display) ? "sae_color" : ""].filter(Boolean).join("; "),
        };
        if (row.__filled) backfill.push(row);
      }
    }
  }
  // One row per product.
  const seen = new Set();
  const backfillRows = backfill.filter((r) => {
    if (seen.has(r.Handle)) return false;
    seen.add(r.Handle);
    return true;
  });

  console.log("--- 01 colour backfill ---");
  console.log(`  products gaining colour: ${backfillRows.length}`);
  console.log(`    color-pattern filled : ${backfillRows.filter((r) => r.__filled.includes("color-pattern")).length}`);
  console.log(`    sae_color filled     : ${backfillRows.filter((r) => r.__filled.includes("sae_color")).length}`);
  if (unmapped.length) {
    console.log(`  UNMAPPED colours (${unmapped.length}) -- add to MIGRATION.colourHandleOverrides:`);
    [...new Set(unmapped.map((u) => u.display))].forEach((d) => console.log(`    ${JSON.stringify(d)}`));
  }

  if (!dryRun) {
    const H = ["ID", "Handle", "Command", "Title", CP, SAE, "__source", "__filled"];
    writeCSV(path.join(outdir, `01-colour-backfill-${date}.csv`), H, backfillRows);
    console.log(`\nWrote ${outdir}/01-colour-backfill-${date}.csv`);
  }

  // ---- STEP 02: Title/Default Title -> Size ------------------------------
  const amFile = args.find((a, i) => a.endsWith(".csv") && a !== baseFile && args[i - 1] !== "--outdir");
  let amBySku = new Map();
  if (amFile) {
    const { rows: amRows } = parseCSV(fs.readFileSync(amFile, "utf-8"));
    amRows.forEach((x) => {
      if (x.SKU) amBySku.set(normalizeSku(x.SKU), x);
    });
  }

  // Sizes the catalog has already committed to, per SKU.
  const curatedSizes = new Map();
  for (const r of rows) {
    const k = normalizeSku(r["Variant SKU"]);
    if (!k) continue;
    let size = null;
    if (r["Option1 Name"] === "Size") size = r["Option1 Value"];
    else if (r["Option2 Name"] === "Size") size = r["Option2 Value"];
    if (size && !curatedSizes.has(k)) curatedSizes.set(k, size.trim());
  }

  const legacy = [...byHandle.entries()].filter(
    ([h, v]) => v[0]["Option1 Name"] === "Title" && !MIGRATION.excludeHandles.includes(h),
  );
  const sizeRows = [];
  const unresolved = [];
  const outsideVocab = new Set();
  const unconfirmedHandles = new Set();

  for (const [handle, variants] of legacy) {
    // Resolve every variant first: custom.size is a PRODUCT-level list of the
    // product's distinct sizes, so it can only be built once the whole product
    // is known.
    const resolved = [];
    for (const v of variants) {
      const sku = normalizeSku(v["Variant SKU"]);
      const { size, source, unmappedUom } = resolveSize(sku, curatedSizes, amBySku.get(sku));
      if (!size) {
        unresolved.push({ handle, sku, unmappedUom });
        continue;
      }
      if (!SIZE_VOCABULARY.includes(size)) outsideVocab.add(size);
      resolved.push({ v, size, source });
    }
    if (!resolved.length) continue;

    // Distinct sizes, in vocabulary order, mapped to metaobject handles.
    const distinct = [...new Set(resolved.map((x) => x.size))].sort(
      (a, b) => SIZE_VOCABULARY.indexOf(a) - SIZE_VOCABULARY.indexOf(b),
    );
    const handles = [];
    let sizeMetafieldSafe = true;
    for (const d of distinct) {
      const handle = SIZE_METAOBJECT[d];
      if (!handle) {
        // No metaobject for this size -> writing it would create a dangling
        // reference, so custom.size is left blank and the gap reported.
        unconfirmedHandles.add(d);
        sizeMetafieldSafe = false;
        continue;
      }
      handles.push(handle);
    }

    resolved.forEach(({ v, size, source }, i) => {
      sizeRows.push({
        ID: v.__raw["ID"] || v["ID"] || "",
        Handle: handle,
        Command: "MERGE",
        Title: v.Title,
        // Product-level: only on the product's first row, and only when every
        // size in the list has a confirmed metaobject.
        [SIZE_METAFIELD_COL]: i === 0 && sizeMetafieldSafe ? handles.join(", ") : "",
        "Variant ID": v.__raw["Variant ID"] || v["Variant ID"] || "",
        "Variant Command": "MERGE",
        "Variant SKU": v.__raw["Variant SKU"] || "",
        "Option1 Name": "Size",
        "Option1 Value": size,
        __source: source,
        __sizes: i === 0 ? distinct.join(" | ") : "",
      });
    });
  }

  console.log("\n--- 02 size conversion ---");
  console.log(`  legacy Title/Default Title products: ${legacy.length}`);
  console.log(`  converted to a Size option        : ${sizeRows.length}`);
  const bySrc = {};
  sizeRows.forEach((r) => (bySrc[r.__source] = (bySrc[r.__source] || 0) + 1));
  Object.entries(bySrc).forEach(([k, v]) => console.log(`      ${String(v).padStart(3)}  from ${k}`));
  const dist = {};
  sizeRows.forEach((r) => (dist[r["Option1 Value"]] = (dist[r["Option1 Value"]] || 0) + 1));
  console.log("  resulting sizes:");
  Object.entries(dist)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`      ${String(v).padStart(3)}  ${k}`));
  if (outsideVocab.size) {
    console.log(`  NEW size values not in the existing vocabulary: ${[...outsideVocab].join(", ")}`);
  }
  const withMeta = sizeRows.filter((r) => (r[SIZE_METAFIELD_COL] || "").trim()).length;
  console.log(`  custom.size set on ${withMeta} product(s)`);
  if (unconfirmedHandles.size) {
    console.log(`  custom.size LEFT BLANK -- no metaobject for these sizes:`);
    [...unconfirmedHandles].forEach((h) => console.log(`      ${h}`));
    console.log(`      Create the metaobject, then add it to SIZE_METAOBJECT in sync-config.js.`);
  }
  if (unresolved.length) {
    console.log(`  UNRESOLVED (${unresolved.length}) -- no curated size, no AccountMate match, no SKU token:`);
    unresolved.forEach((u) =>
      console.log(`      ${u.sku.padEnd(26)}${u.unmappedUom ? `UoM "${u.unmappedUom}" has no enumeration value  ` : ""}${u.handle}`),
    );
    console.log(`      Left out of the file. Set these by hand or add a SKU token to sync-config.js.`);
  }

  if (!dryRun) {
    const H = ["ID", "Handle", "Command", "Title", SIZE_METAFIELD_COL, "Variant ID", "Variant Command", "Variant SKU", "Option1 Name", "Option1 Value", "__source", "__sizes"];
    writeCSV(path.join(outdir, `02-size-conversion-${date}.csv`), H, sizeRows);
    console.log(`\nWrote ${outdir}/02-size-conversion-${date}.csv`);
  }

  // ---- STEP 03: orphan consolidated variants -----------------------------
  // "Orphan" = a consolidated variant with no standalone twin. They are NOT all
  // new products. Under colour-as-product / size-as-variant they split three
  // ways, and the census decides which:
  //   a) another SIZE of a colour that already has a product -> add a variant
  //   b) a product that exists but has a blank Variant SKU    -> fill it in
  //   c) genuinely new                                        -> create it
  // Creating (a) or (b) standalone would fragment one colour across several URLs.
  const SIZE_TOKENS = [...SKU_SUFFIX_OVERRIDE_ORDER, "GL/KT", "_G", "G1", "G2", "G4", "GK-1", "GK-2", "G-1"].sort(
    (x, y) => y.length - x.length,
  );
  const skuBase = (sku) => {
    let v = normalizeSku(sku);
    for (const t of SIZE_TOKENS) if (v.endsWith(t)) return v.slice(0, -t.length).trim();
    return v;
  };

  const dupSkus = new Set();
  {
    const n = {};
    rows.forEach((x) => {
      const k = normalizeSku(x["Variant SKU"]);
      if (k) n[k] = (n[k] || 0) + 1;
    });
    Object.entries(n).forEach(([k, v]) => v > 1 && dupSkus.add(k));
  }
  const standalone = rows.filter(
    (x) => x["Option1 Name"] !== "Color" && !MIGRATION.excludeHandles.includes(x.Handle),
  );
  const standaloneByBase = new Map();
  standalone.forEach((x) => {
    const b = skuBase(x["Variant SKU"]);
    if (!b) return;
    if (!standaloneByBase.has(b)) standaloneByBase.set(b, x);
  });
  const blankSkuProducts = standalone.filter((x) => !(x["Variant SKU"] || "").trim());

  const orphans = rows.filter(
    (x) =>
      x["Option1 Name"] === "Color" &&
      !MIGRATION.excludeHandles.includes(x.Handle) &&
      normalizeSku(x["Variant SKU"]) &&
      !dupSkus.has(normalizeSku(x["Variant SKU"])),
  );

  const addVariantRows = [];
  const fillSkuRows = [];
  const newProductRows = [];
  const sizeMetafieldUpdates = new Map();

  const colourName = (display) => {
    const m = String(display || "").match(/\(([^)]+)\)\s*$/);
    return m ? m[1].trim() : String(display || "").trim();
  };
  const specFromTitle = (title) => {
    const m = String(title || "").match(/\(([^)]*(?:MIL|BMS|AMS|DOD)[^)]*)\)/i);
    return m ? m[1].trim() : "";
  };
  const mpnSlug = (mpn) =>
    String(mpn || "")
      .replace(/\s*\+.*$/, "")
      .replace(/^AX/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  for (const o of orphans) {
    const sku = normalizeSku(o["Variant SKU"]);
    const base = skuBase(sku);
    const size = o["Option2 Value"] || "";
    const target = standaloneByBase.get(base);
    const amRow = amBySku.get(sku);

    if (target) {
      // (a) another size of an existing colour product
      addVariantRows.push({
        ID: target.__raw["ID"] || "",
        Handle: target.Handle,
        Command: "MERGE",
        "Variant Command": "MERGE",
        "Variant SKU": o.__raw["Variant SKU"],
        "Option1 Name": "Size",
        "Option1 Value": size,
        "Variant Price": o.__raw["Variant Price"] || "",
        "Variant Compare At Price": o.__raw["Variant Compare At Price"] || "",
        "Variant Cost": o.__raw["Variant Cost"] || "",
        "Variant Weight": o.__raw["Variant Weight"] || "",
        "Variant Weight Unit": o.__raw["Variant Weight Unit"] || "lb",
        __from: o.Handle,
      });
      // The parent's custom.size list must grow to include the new size.
      if (!sizeMetafieldUpdates.has(target.Handle)) {
        // custom.size is a LIST and is replaced wholesale, so it must include the
        // product's existing sizes as well as the new one.
        //
        // The baseline export may predate step 02, in which case a product still
        // reads as "Title / Default Title" and appears to have no size at all.
        // Resolving each existing variant the same way step 02 does recovers the
        // real size, so this stays correct whether or not the export is fresh.
        const existing = new Set();
        rows
          .filter((x) => x.Handle === target.Handle)
          .forEach((x) => {
            if (x["Option1 Name"] === "Size" && (x["Option1 Value"] || "").trim()) {
              existing.add(x["Option1 Value"].trim());
              return;
            }
            const k = normalizeSku(x["Variant SKU"]);
            const { size: resolvedSize } = resolveSize(k, curatedSizes, amBySku.get(k));
            if (resolvedSize) existing.add(resolvedSize);
          });
        sizeMetafieldUpdates.set(target.Handle, { row: target, sizes: existing });
      }
      sizeMetafieldUpdates.get(target.Handle).sizes.add(size);
      continue;
    }

    // (b) an existing product whose Variant SKU is blank
    const blank = blankSkuProducts.find((x) => x.Handle.includes(base.replace(/^HZ?K?/, "").toLowerCase()));
    if (blank) {
      const fixedMpn = (blank["Metafield: custom.manufacturer_part_number [single_line_text_field]"] || "").replace(/31111RPX-71/gi, "31111RPX-T1");
      fillSkuRows.push({
        ID: blank.__raw["ID"] || "",
        Handle: blank.Handle,
        Command: "MERGE",
        Title: (blank.Title || "").replace(/31111RPX-71/gi, "31111RPX-T1"),
        "Metafield: custom.manufacturer_part_number [single_line_text_field]": fixedMpn,
        "Variant ID": blank.__raw["Variant ID"] || "",
        "Variant Command": "MERGE",
        "Variant SKU": o.__raw["Variant SKU"],
        __note: "filled blank SKU; corrected 71 -> T1 typo in title and MPN",
      });
      continue;
    }

    // (c) genuinely new standalone product
    const mpn = amRow ? getAttr(amRow, "Vendor SKU") : "";
    const spec = specFromTitle(o.Title);
    const slug = [mpnSlug(mpn || base), spec.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")]
      .filter(Boolean)
      .join("-");
    newProductRows.push({
      Handle: `hentzen-${slug}`,
      Command: "MERGE",
      // AccountMate is inconsistent about the AX prefix ("AXPG-6-W28" vs
      // "PG-6-W3"); strip it so the title matches the handle and the sibling
      // products, which use the PG-6-G1 form.
      Title: `Hentzen ${(mpn || base).replace(/\s*\+.*$/, "").replace(/^AX/i, "")}, ${colourName(o["Option1 Value"])} ${o.Type || "Topcoat"}${spec ? ` (${spec})` : ""}`,
      "Body HTML": o.__raw["Body HTML"] || o["Body HTML"] || "",
      Vendor: o.Vendor || "Hentzen",
      Type: o.Type || "",
      Tags: o.Tags || "",
      Status: "draft",
      Published: "false",
      Category: o.Category || "",
      [MIGRATION.colourPatternCol]: colourToHandle(o["Option1 Value"]) || "",
      [MIGRATION.saeColourCol]: colourToCode(o["Option1 Value"]),
      "Metafield: custom.mil_specs [list.metaobject_reference]": o["Metafield: custom.mil_specs [list.metaobject_reference]"] || "",
      "Metafield: custom.manufacturer_part_number [single_line_text_field]": mpn,
      [SIZE_METAFIELD_COL]: SIZE_METAOBJECT[size] || "",
      "Variant Command": "MERGE",
      "Variant SKU": o.__raw["Variant SKU"],
      "Option1 Name": "Size",
      "Option1 Value": size,
      "Variant Price": o.__raw["Variant Price"] || "",
      "Variant Compare At Price": o.__raw["Variant Compare At Price"] || "",
      "Variant Cost": o.__raw["Variant Cost"] || "",
      "Variant Weight": o.__raw["Variant Weight"] || "",
      "Variant Weight Unit": o.__raw["Variant Weight Unit"] || "lb",
      __from: o.Handle,
    });
  }

  // custom.size updates for products gaining a size
  const sizeUpdateRows = [];
  for (const [handle, { row, sizes }] of sizeMetafieldUpdates) {
    const ordered = [...sizes].sort((x, y) => SIZE_VOCABULARY.indexOf(x) - SIZE_VOCABULARY.indexOf(y));
    const handles = ordered.map((sz) => SIZE_METAOBJECT[sz]).filter(Boolean);
    if (handles.length !== ordered.length) continue;
    sizeUpdateRows.push({
      ID: row.__raw["ID"] || "",
      Handle: handle,
      Command: "MERGE",
      [SIZE_METAFIELD_COL]: handles.join(", "),
      __sizes: ordered.join(" | "),
    });
  }

  console.log("\n--- 03 orphan variants ---");
  console.log(`  orphans (consolidated variants with no standalone twin): ${orphans.length}`);
  console.log(`    a) added as a Size variant to an existing product : ${addVariantRows.length}`);
  console.log(`    b) filled a blank Variant SKU                     : ${fillSkuRows.length}`);
  console.log(`    c) created as a new standalone product            : ${newProductRows.length}`);
  console.log(`  custom.size updated on ${sizeUpdateRows.length} product(s) gaining a size`);
  if (newProductRows.length) {
    console.log("\n  new products:");
    newProductRows.forEach((r) => {
      console.log(`    ${r.Handle}`);
      console.log(`      ${r.Title}`);
      console.log(`      size=${r["Option1 Value"]}  colour=${r[MIGRATION.colourPatternCol]}  price=${r["Variant Price"]}`);
    });
  }
  if (fillSkuRows.length) {
    console.log("\n  blank SKU filled:");
    fillSkuRows.forEach((r) => console.log(`    ${r.Handle}  <- ${r["Variant SKU"]}`));
  }

  if (!dryRun) {
    if (addVariantRows.length) {
      writeCSV(
        path.join(outdir, `03a-add-size-variants-${date}.csv`),
        ["ID", "Handle", "Command", "Variant Command", "Variant SKU", "Option1 Name", "Option1 Value", "Variant Price", "Variant Compare At Price", "Variant Cost", "Variant Weight", "Variant Weight Unit", "__from"],
        addVariantRows,
      );
      writeCSV(
        path.join(outdir, `03b-size-metafield-${date}.csv`),
        ["ID", "Handle", "Command", SIZE_METAFIELD_COL, "__sizes"],
        sizeUpdateRows,
      );
    }
    if (fillSkuRows.length) {
      writeCSV(
        path.join(outdir, `03c-fill-blank-sku-${date}.csv`),
        ["ID", "Handle", "Command", "Title", "Metafield: custom.manufacturer_part_number [single_line_text_field]", "Variant ID", "Variant Command", "Variant SKU", "__note"],
        fillSkuRows,
      );
    }
    if (newProductRows.length) {
      writeCSV(path.join(outdir, `03d-new-standalone-${date}.csv`), Object.keys(newProductRows[0]), newProductRows);
    }
    console.log(`\nWrote 03a/03b/03c/03d to ${outdir}/`);
  }

  // Report what step 04 would strand if 01 is skipped.
  const wouldLose = [];
  for (const [, variants] of consolidated) {
    for (const v of variants) {
      const sku = normalizeSku(v["Variant SKU"]);
      if (!sku) continue;
      const twins = (bySku.get(sku) || []).filter((x) => x.Handle !== v.Handle && x["Option1 Name"] !== "Color");
      for (const t of twins) {
        if (!(t[CP] || "").trim() && !(t[SAE] || "").trim()) wouldLose.push(t.Handle);
      }
    }
  }
  console.log(`\n  Without step 01, retiring the consolidated products would strand`);
  console.log(`  ${new Set(wouldLose).size} products with no colour at all.`);
}

main();
