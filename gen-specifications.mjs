#!/usr/bin/env node

/**
 * Emit a Matrixify Metaobjects sheet for Product Specifications that do not
 * exist yet.
 *
 * Specs are parsed out of the AccountMate description blocks, normalised, and
 * matched case-insensitively by title against the existing export. Only the
 * missing ones are written, so re-running is safe.
 *
 * Usage:
 *   node gen-specifications.mjs <accountmate.csv> [existing-specs.csv] [--outdir dir]
 */

import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { extractSpecs, specTitle, specHandle, baseSpec, governingBody } from "./spec-parser.mjs";

const P = (f) => parse(fs.readFileSync(f), { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true });
const esc = (v) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const W = (f, h, rows) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, [h.map(esc).join(","), ...rows.map((r) => h.map((x) => esc(r[x] ?? "")).join(","))].join("\n") + "\n");
};

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const outdir = flag("--outdir", "output");
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--outdir");
const [amFile, existingFile = "Product_Specifications.csv"] = positional;
if (!amFile) {
  console.log("Usage: node gen-specifications.mjs <accountmate.csv> [existing-specs.csv] [--outdir dir]");
  process.exit(1);
}
const date = new Date().toISOString().slice(0, 10);

// --- existing specs, keyed by lower-cased title ----------------------------
const existing = new Map();
if (fs.existsSync(existingFile)) {
  for (const r of P(existingFile)) {
    const title = (r["Display Name"] || "").trim();
    if (title) existing.set(title.toLowerCase(), r.Handle);
  }
}

// --- specs referenced by AccountMate ---------------------------------------
const am = P(amFile);
const seen = new Map(); // title -> { approvedFor, meetsFor }
for (const row of am) {
  const { approved, meets } = extractSpecs(row);
  for (const t of approved) {
    if (!seen.has(t)) seen.set(t, { approved: 0, meets: 0 });
    seen.get(t).approved++;
  }
  for (const t of meets) {
    if (!seen.has(t)) seen.set(t, { approved: 0, meets: 0 });
    seen.get(t).meets++;
  }
}

const missing = [...seen.keys()].filter((t) => !existing.has(t.toLowerCase())).sort();
const present = [...seen.keys()].filter((t) => existing.has(t.toLowerCase()));

// --- Matrixify Metaobjects sheet -------------------------------------------
// One row per FIELD, five per metaobject, "Top Row" on the first.
const FIELDS = ["title", "base_specification", "description", "collection", "governing_body"];
const rows = [];
for (const title of missing) {
  const handle = specHandle(title);
  const values = {
    title,
    base_specification: baseSpec(title),
    description: "",
    collection: "",
    governing_body: governingBody(title),
  };
  FIELDS.forEach((field, i) => {
    rows.push({
      ID: "",
      Handle: handle,
      Command: "MERGE",
      "Display Name": title,
      Status: "Active",
      "Updated At": "",
      "Definition: Handle": "product_specification",
      "Definition: Name": "Product Specification",
      "Top Row": i === 0 ? "true" : "",
      "Row #": String(i + 1),
      Field: field,
      Value: values[field],
    });
  });
}

console.log(`AccountMate: ${amFile}`);
console.log(`Existing specs: ${existingFile}  (${existing.size} known)\n`);
console.log(`specifications referenced by AccountMate : ${seen.size}`);
console.log(`  already exist                          : ${present.length}`);
console.log(`  to create                              : ${missing.length}`);

const noBody = missing.filter((t) => !governingBody(t));
if (noBody.length) {
  console.log(`\ngoverning body UNKNOWN for ${noBody.length} -- left blank, add a prefix to GOVERNING_BODY in spec-parser.mjs:`);
  noBody.forEach((t) => console.log(`    ${t}   (base: ${baseSpec(t)})`));
}

const byBody = {};
missing.forEach((t) => {
  const b = governingBody(t) || "(unknown)";
  byBody[b] = (byBody[b] || 0) + 1;
});
console.log("\nnew specs by governing body:");
Object.entries(byBody)
  .sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log(`  ${String(v).padStart(3)}  ${k}`));

if (rows.length) {
  const H = ["ID", "Handle", "Command", "Display Name", "Status", "Updated At", "Definition: Handle", "Definition: Name", "Top Row", "Row #", "Field", "Value"];
  const file = path.join(outdir, `new-specifications-${date}.csv`);
  W(file, H, rows);
  console.log(`\nWrote ${file}  (${missing.length} specs, ${rows.length} rows)`);
  console.log("Import as a Metaobjects sheet BEFORE the product files, which reference these.");
} else {
  console.log("\nNothing to create.");
}
