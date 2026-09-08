#!/usr/bin/env node

/**
 * Migration steps 04-05: retire the consolidated products and stand up the
 * Product Family layer that replaces them.
 *
 * Import in this order -- each step depends on the one before:
 *
 *   05a-collections      one collection per dismantled family
 *   05b-metaobjects      product_family metaobjects, pointing at those collections
 *   05c-family-links     every child product -> its family metaobject
 *   04a-archive          the 5 consolidated products -> Archived
 *   04b-redirects        301 from each old product URL -> its family collection
 *
 * Archiving is last so the redirect target exists first, and so the family
 * links can still be derived from the consolidated products' variant lists.
 *
 * Usage:
 *   node migrate-families.mjs <matrixify-export.csv> [--outdir dir] [--dry-run]
 */

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { MIGRATION } from "../sync-config.js";

const P = (f) =>
  parse(fs.readFileSync(f), { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true });
const esc = (v) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const W = (f, h, rows) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, [h.map(esc).join(","), ...rows.map((r) => h.map((x) => esc(r[x] ?? "")).join(","))].join("\n") + "\n");
};
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");

const PF = "Metafield: custom.product_family [metaobject_reference]";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const dryRun = args.includes("--dry-run");
const outdir = flag("--outdir", "migration");
const baseFile = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--outdir");
if (!baseFile) {
  console.log("Usage: node migrate-families.mjs <matrixify-export.csv> [--outdir dir] [--dry-run]");
  process.exit(1);
}
const date = new Date().toISOString().slice(0, 10);

const rows = P(baseFile);
const headers = Object.keys(rows[0]);
const pcols = [...headers.filter((h) => /^Metafield:/.test(h)), "Title", "Body HTML", "Option1 Name", "Status", "Type", "Tags"];
const carry = new Map();
rows.forEach((x) => {
  if (!carry.has(x.Handle)) carry.set(x.Handle, {});
  const c = carry.get(x.Handle);
  pcols.forEach((k) => {
    if ((x[k] || "").trim()) c[k] = x[k];
  });
});
const hyd = rows.map((x) => {
  const c = carry.get(x.Handle) || {};
  const o = { ...x };
  pcols.forEach((k) => {
    if (!(o[k] || "").trim() && c[k]) o[k] = c[k];
  });
  o.__raw = x;
  return o;
});

// The consolidated products being dismantled -- each becomes one Product Family.
const consolidated = new Map();
hyd.forEach((x) => {
  if (x["Option1 Name"] !== "Color") return;
  if (MIGRATION.excludeHandles.includes(x.Handle)) return;
  if (!consolidated.has(x.Handle)) consolidated.set(x.Handle, []);
  consolidated.get(x.Handle).push(x);
});

// Standalone products, indexed by SKU, so each consolidated variant can be
// traced to the product that now represents it.
const standaloneBySku = new Map();
hyd.forEach((x) => {
  if (x["Option1 Name"] === "Color" || MIGRATION.excludeHandles.includes(x.Handle)) return;
  const k = norm(x["Variant SKU"]);
  if (k && !standaloneBySku.has(k)) standaloneBySku.set(k, x);
});

// Existing families, so we only create what is missing.
const existingFamilies = new Set(hyd.map((x) => (x[PF] || "").trim()).filter(Boolean));

console.log(`Baseline: ${baseFile}  (${rows.length} rows, ${new Set(rows.map((r) => r.Handle)).size} products)`);
console.log(`Consolidated products to dismantle: ${consolidated.size}\n`);

// --- 05a collections -------------------------------------------------------
// The collection reuses the retired product's handle. Collections and products
// have separate handle namespaces in Shopify, so this is safe -- and it keeps
// the family URL recognisably the same as the page it replaces.
const collectionRows = [];
const familyOf = new Map(); // consolidated handle -> metaobject reference
for (const [handle, variants] of consolidated) {
  const p = variants[0];
  collectionRows.push({
    Handle: handle,
    Command: "MERGE",
    Title: p.Title || handle,
    "Body HTML": p["Body HTML"] || "",
    Published: "true",
    "Published Scope": "web",
    "Sort Order": "best-selling",
    __variants: variants.length,
  });
  familyOf.set(handle, `product_family.${handle}`);
}

// --- 05b metaobjects -------------------------------------------------------
const metaobjectRows = [];
for (const [handle, variants] of consolidated) {
  const ref = familyOf.get(handle);
  metaobjectRows.push({
    Type: "product_family",
    Handle: handle,
    Command: "MERGE",
    "Field: name": variants[0].Title || handle,
    "Field: collection": handle,
    Status: "ACTIVE",
    __exists: existingFamilies.has(ref) ? "already exists" : "new",
  });
}

// --- 05c product -> family links -------------------------------------------
// Per the decision, an existing family reference IS overwritten: 4 children of
// the Aerospace Type I product currently point at the Ground Support Type II
// family, which is wrong.
const linkRows = [];
const reassigned = [];
const unmatched = [];
for (const [handle, variants] of consolidated) {
  const ref = familyOf.get(handle);
  for (const v of variants) {
    const sku = norm(v["Variant SKU"]);
    const target = sku ? standaloneBySku.get(sku) : null;
    if (!target) {
      unmatched.push({ sku: sku || "(blank)", from: handle });
      continue;
    }
    if (linkRows.some((r) => r.Handle === target.Handle)) continue; // one row per product
    const current = (target[PF] || "").trim();
    if (current && current !== ref) reassigned.push({ handle: target.Handle, from: current, to: ref });
    linkRows.push({
      ID: target.__raw["ID"] || "",
      Handle: target.Handle,
      Command: "MERGE",
      [PF]: ref,
      __family: handle,
      __was: current && current !== ref ? current : "",
    });
  }
}

// --- 04a archive -----------------------------------------------------------
const archiveRows = [];
for (const [handle, variants] of consolidated) {
  archiveRows.push({
    ID: variants[0].__raw["ID"] || "",
    Handle: handle,
    Command: "MERGE",
    Status: "Archived",
    __variants: variants.length,
    __replacedBy: `/collections/${handle}`,
  });
}

// --- 04b redirects ---------------------------------------------------------
const redirectRows = [];
for (const [handle] of consolidated) {
  redirectRows.push({ Command: "MERGE", Path: `/products/${handle}`, Target: `/collections/${handle}` });
}

// --- report ----------------------------------------------------------------
console.log("--- 05a collections ---");
collectionRows.forEach((r) => console.log(`  ${r.Handle.slice(0, 58).padEnd(60)}${r.__variants} variants`));
console.log("\n--- 05b metaobjects ---");
metaobjectRows.forEach((r) => console.log(`  product_family.${r.Handle.slice(0, 52).padEnd(54)}${r.__exists}`));
console.log("\n--- 05c family links ---");
console.log(`  products linked to a family: ${linkRows.length}`);
const perFam = {};
linkRows.forEach((r) => (perFam[r.__family] = (perFam[r.__family] || 0) + 1));
Object.entries(perFam).forEach(([k, v]) => console.log(`      ${String(v).padStart(3)}  ${k.slice(0, 58)}`));
if (reassigned.length) {
  console.log(`  reassigned from a different family (${reassigned.length}):`);
  reassigned.forEach((r) => console.log(`      ${r.handle.slice(0, 46).padEnd(48)}${r.from.replace("product_family.", "")}\n        -> ${r.to.replace("product_family.", "")}`));
}
if (unmatched.length) {
  console.log(`  WARNING: ${unmatched.length} consolidated variant(s) had no standalone product:`);
  unmatched.forEach((u) => console.log(`      ${u.sku.padEnd(24)}${u.from}`));
}
console.log("\n--- 04a archive ---");
archiveRows.forEach((r) => console.log(`  ${r.Handle.slice(0, 58).padEnd(60)}-> ${r.__replacedBy}`));
console.log("\n--- 04b redirects ---");
redirectRows.forEach((r) => console.log(`  ${r.Path.slice(0, 62).padEnd(64)}-> ${r.Target}`));

if (dryRun) {
  console.log("\n[dry run] nothing written.");
  process.exit(0);
}

W(path.join(outdir, `05a-collections-${date}.csv`),
  ["Handle", "Command", "Title", "Body HTML", "Published", "Published Scope", "Sort Order", "__variants"], collectionRows);
W(path.join(outdir, `05b-metaobjects-${date}.csv`),
  ["Type", "Handle", "Command", "Field: name", "Field: collection", "Status", "__exists"], metaobjectRows);
W(path.join(outdir, `05c-family-links-${date}.csv`),
  ["ID", "Handle", "Command", PF, "__family", "__was"], linkRows);
W(path.join(outdir, `04a-archive-consolidated-${date}.csv`),
  ["ID", "Handle", "Command", "Status", "__variants", "__replacedBy"], archiveRows);
W(path.join(outdir, `04b-redirects-${date}.csv`), ["Command", "Path", "Target"], redirectRows);

console.log(`\nWrote to ${outdir}/  -- import in this order:`);
console.log(`  05a-collections-${date}.csv      (Collections sheet)`);
console.log(`  05b-metaobjects-${date}.csv      (Metaobjects sheet)`);
console.log(`  05c-family-links-${date}.csv     (Products sheet)`);
console.log(`  04a-archive-consolidated-${date}.csv  (Products sheet)`);
console.log(`  04b-redirects-${date}.csv        (Redirects sheet)`);
console.log(`\nThe __ columns are review aids -- delete them before importing.`);
