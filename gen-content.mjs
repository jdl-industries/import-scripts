#!/usr/bin/env node

/**
 * Draft handles, titles and descriptions for new products.
 *
 * Writes new-product-content.csv, which sync-matrixify.js reads back. Each
 * field has a "Confirmed" column that wins over the "Drafted" one, so edits
 * survive regeneration -- the same handoff shape as the colour map.
 *
 * On descriptions: AccountMate's long description is family-level boilerplate.
 * 23 of the 51 new products are AXPG-6 variants that would otherwise carry
 * byte-identical copy, which reads as duplicate content. Each description
 * therefore OPENS with what is unique to the product -- part number, colour
 * name and code, spec, pack format -- before the shared family paragraph.
 *
 * Usage: node gen-content.mjs <sync-outdir>
 */

import fs from "fs";
import { parse } from "csv-parse/sync";
import {
  NEW_PRODUCT_HANDLE,
  MIL_SPEC_PATTERNS,
  MIL_SPEC_UNMAPPABLE,
  PARENT_COLLECTION,
  APPLICATION_ATTRS,
  classifyCategory,
} from "./sync-config.js";

// --- terse description + spec, per MPN (confirmed by the user) --------------
const T = {
  "AX-10": ["Polyurethane Accelerator", ""],
  "AX-17": ["Polyurethane Accelerator", ""],
  "AX-1440-SW": ["Silver-White Reflective Paint", ""],
  "SR-12": ["Medium Topcoat Reducer", ""],
  "EF-2-BK1": ["Flat Black Epoxy Topcoat", "MIL-PRF-22750"],
  "EG-2-BK1": ["Gloss Black Epoxy Topcoat", "MIL-PRF-22750"],
  "EG-2-G1": ["Gloss Gray Epoxy Topcoat", "MIL-PRF-22750"],
  "EG-2-W1": ["Gloss White Epoxy Topcoat", "MIL-PRF-22750"],
  "EP-3-GN2": ["Green Epoxy Primer", "DMS 1786"],
  "PF-6-BK1": ["Flat Black Topcoat", "MIL-PRF-85285 Type IV"],
  "PS-6-BR6": ["Semi-Gloss Brown Topcoat", "MIL-PRF-85285 Type IV"],
  "PG-21-G2": ["Gray Polyurethane Topcoat", "BAMS 565-002"],
  "PG-6-B127": ["Gloss Blue Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-B483": ["Jet Blue Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-B487": ["Gloss Blue Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-BK1": ["Gloss Black Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-BK3": ["Gloss Black Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-C1": ["Gloss Clear Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-C19": ["Clear Touch-Up Kit", "MIL-PRF-85285 Type I"],
  // BASE is the base component sold without catalyst -- a distinct product from
  // the mixed PG-6-G1 kit, not another size of it.
  "PG-6-G1 BASE": ["Gloss Gray Topcoat Base", "MIL-PRF-85285 Type I"],
  "PG-6-G28": ["Gloss Gray Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-G36": ["Gloss Gray Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-G38": ["Gray Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-G70318": ["Gray Standard-Cure Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-G9": ["Gloss Gray Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-W138": ["Matterhorn White Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-W2": ["Gloss White Touch-Up Kit", "MIL-PRF-85285 Type I"],
  "PG-6-W29": ["Gloss White Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-W39": ["Jet Glo White Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-W5": ["Gloss White Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-W65": ["Gloss White Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-W7": ["Gloss White Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-W76": ["Gloss White Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-W9": ["Gloss White Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-Y122": ["Gloss Yellow Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-Y26": ["Gloss Yellow Topcoat", "MIL-PRF-85285 Type I"],
  "PNF-14-BK1": ["Black Non-Skid Walkway", "AA-59166 Type II"],
  "PS-1-W7": ["Semi-Gloss White Topcoat", "FAR 25.853"],
  "TF-1-BK1": ["Flat Black PTFE Topcoat", "BMS 10-86"],
  "TF-1-BR1": ["Flat Brown PTFE Topcoat", "BAMS 565-005"],
  "TS-1-G1": ["Gray PTFE Topcoat", "BAMS 565-005"],
  "TS-1-G70318K1": ["Gray PTFE Topcoat", "BAMS 565-005"],
  "TS-1-W1": ["Semi-Gloss White PTFE Topcoat", "BAMS 565-005"],
  "WF-3-B36": ["Flat Blue Interior Waterbase", "DPM 5949"],
  "WF-3-BK1": ["Flat Black Interior Waterbase", "DPM 5949"],
  "WF-3-BR1": ["Flat Brown Interior Waterbase", "DPM 5949"],
  "WF-3-G7": ["Flat Gray Interior Waterbase", "DPM 5949"],
  "WF-3-GN1": ["Flat Green Interior Waterbase", "DPM 5949"],
  "WF-3-W37": ["Oyster White Interior Waterbase", "DPM 5949"],
  "WF-3-W71": ["Sail White Interior Waterbase", "DPM 5949"],
  "WS-3-W10": ["White Water-Reducible Topcoat", "BMS 10-83"],
  "22167WEP": ["Off-White Epoxy Primer", "MIL-DTL-53022F Type IV"],
  "35554ZPX": ["Gray Flat Topcoat", "MIL-PRF-85285 Type IV"],
};

// --- family copy -----------------------------------------------------------
// Matched by MPN prefix, longest first. `body` is the shared paragraph;
// `uses` closes with concrete applications, which is what long-tail search
// actually matches on.
const FAMILIES = [
  {
    match: /^AX-1440/,
    family: "Reflective Alert",
    body: "Alert is a specialty reflective coating for surfaces that must remain visible at night. It dries to a finish that reflects light back toward its source, and adheres to steel, aluminium, concrete and wood.",
    uses: "Typical uses include runway and ramp markings, obstruction marking, and safety striping on ground support equipment.",
  },
  {
    match: /^AX-(10|17)/,
    family: "Polyurethane Accelerator",
    body: "Polyurethane accelerators speed the dry time of polyurethane topcoats without altering the cured film. They are especially useful below 80&deg;F, where normal cure times become impractical.",
    uses: "Typical uses include repair and touch-up work, and small areas such as stripes, numbers and other markings.",
  },
  {
    match: /^SR-/,
    family: "Topcoat Reducer",
    body: "A medium-evaporation reducer for adjusting the viscosity of Hentzen topcoats to suit spray equipment and ambient conditions.",
    uses: "Use the medium grade for general-purpose spraying in moderate temperatures.",
  },
  {
    match: /^E[FG]-2/,
    family: "High-Solids Epoxy Topcoat",
    body: "A two-component high-solids epoxy topcoat providing maximum protection against chemicals, aviation fuels, hydraulic fluids and other corrosive media. VOC content is below 420 g/L.",
    uses: "Typical uses include aircraft interiors and exteriors, ground support equipment, and any surface exposed to fuel or hydraulic fluid.",
  },
  {
    match: /^EP-3/,
    family: "Epoxy Primer",
    body: "A two-component epoxy primer providing corrosion resistance and a sound base for polyurethane and epoxy topcoats.",
    uses: "Typical uses include aluminium and steel aircraft structures prior to topcoating.",
  },
  {
    match: /^P[FS]-6/,
    family: "High-Solids Polyurethane Topcoat",
    body: "A high-solids, chemically cured polyurethane exterior topcoat. Once fully cured it resists Skydrol, marring and abrasion, and holds colour and gloss under prolonged UV exposure.",
    uses: "Typical uses include aircraft exteriors, ground support equipment and military vehicles.",
  },
  {
    match: /^PG-6/,
    family: "High-Solids Polyurethane Topcoat",
    body: "Part of Hentzen's low-VOC High Solids Polyurethane topcoat series, formulated for aircraft and equipment requiring chemical resistance and long-term colour retention. Fully cured films resist Skydrol and marring, and meet demanding aerospace requirements for hardness, flexibility, and gloss retention.",
    uses: "Typical uses include commercial and military aircraft exteriors, ground support equipment, and any surface subject to hydraulic fluid or fuel exposure.",
  },
  {
    match: /^PG-21/,
    family: "High-Solids Polyurethane Topcoat",
    body: "A high-solids polyurethane topcoat qualified to Airbus BAMS 565-002, offering chemical resistance and colour retention on exterior aircraft surfaces.",
    uses: "Typical uses include Airbus airframe exteriors and associated ground equipment.",
  },
  {
    match: /^PNF-14/,
    family: "Non-Skid Walkway Coating",
    body: "The PN-14 series is a high-solids, chemically cured two-component polyurethane non-skid walkway coating. It provides maximum wear resistance and protects against hydraulic fluids, including Skydrol, and aviation fuels.",
    uses: "Typical uses include wing walkways, maintenance platforms, steps and other foot-traffic surfaces.",
  },
  {
    match: /^PS-1/,
    family: "Abrasion-Resistant Polyurethane Topcoat",
    body: "An abrasion-resistant polyurethane topcoat formulated for interior surfaces that see heavy contact wear, and tested to FAR 25.853 vertical burn and OSU 65/65 heat-release requirements.",
    uses: "Typical uses include cabin interiors, galleys, lavatories and cargo linings.",
  },
  {
    match: /^T[FS]-1/,
    family: "PTFE-Reinforced Polyurethane Topcoat",
    body: "A high-solids polyurethane topcoat reinforced with PTFE (Teflon) for a low-friction, easily cleaned surface with excellent release characteristics.",
    uses: "Typical uses include leading edges, radomes, and surfaces where soil release and cleanability matter.",
  },
  {
    match: /^WF-3/,
    family: "Water-Base Interior Flat Topcoat",
    body: "A flat water-base topcoat for plastic substrates including ABS, polycarbonate and polysulfone commonly used in aircraft and marine cabin interiors. It offers strong adhesion, mar and stain resistance, and easy cleaning, and suits areas where low smoke emission and heat release are required.",
    uses: "Typical uses include sidewall and ceiling panels, stowage bins, and cabin trim.",
  },
  {
    match: /^WS-3/,
    family: "Water-Reducible Polyurethane Topcoat",
    body: "A water-reducible polyurethane topcoat combining low VOC content with the durability of a solvent-borne polyurethane, qualified to Boeing BMS 10-83 Type IV.",
    uses: "Typical uses include cabin interiors and components where solvent emissions must be minimised.",
  },
  {
    match: /^22167WEP/,
    family: "Epoxy Primer",
    body: "A four-component epoxy primer meeting MIL-DTL-53022 Type IV, Class U, supplied as a mixed kit. It provides corrosion protection on prepared metal prior to CARC or polyurethane topcoating.",
    uses: "Typical uses include military ground vehicles and support equipment.",
  },
  {
    match: /^35554ZPX/,
    family: "Aerospace Polyurethane Topcoat",
    body: "A high-solids aerospace polyurethane topcoat qualified to MIL-PRF-85285 Type IV, Class H, supplied as a mixed gallon kit.",
    uses: "Typical uses include military aircraft exteriors and support equipment.",
  },
];

// Where the terse title phrase reads awkwardly inside a sentence, the lead uses
// this instead. The title itself is unchanged.
const LEAD_OVERRIDE = {
  "PNF-14-BK1": "black non-skid walkway coating",
  "PG-6-G1 BASE": "gloss gray topcoat base component, supplied without catalyst",
  "PG-6-C19": "clear touch-up kit",
  "PG-6-W2": "gloss white touch-up kit",
};

const COLOUR_WORDS = {
  BK: "black", W: "white", G: "gray", B: "blue", Y: "yellow", C: "clear", BR: "brown", GN: "green", R: "red",
};

const P = (f) => parse(fs.readFileSync(f), { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true });
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const attr = (x, n) => {
  for (let i = 1; i <= 19; i++) if ((x[`Attribute ${i} name`] || "").trim() === n) return (x[`Attribute ${i} value(s)`] || "").trim();
  return "";
};

const O = process.argv[2];
const pick = (p) => fs.readdirSync(O).filter((x) => x.startsWith(p)).sort().pop();
const np = P(O + "/" + pick("new-products"));
const rep = P(O + "/" + pick("sync-report"));
const am = P("AccountMate Export 2026-08-27.csv");
const amBy = new Map();
am.forEach((x) => x.SKU && amBy.set(norm(x.SKU), x));
const action = new Map(rep.filter((r) => r.File === "new").map((r) => [r["Variant SKU"] + "||" + r.Handle, r["Handle Source"]]));

const SIZE = [" G", " KIT", "-LVOC KIT", "-2G", "K-1/4 GL", "2-OZ/KIT", "2-OZ/KT", "KIT-2GL", "KIT-1GL", "K-5GL", "K-2GL", "2GLKT", "4OZ/K", "6OZ/K", "GL/KT", "QT/KT", "GK-1", "GK-2", "G-1", "_2G", "_G", "GL", "G1", "G2", "G4", "Q2", "QT"].sort((a, b) => b.length - a.length);
const base = (s) => { let v = norm(s); for (const t of SIZE) if (v.endsWith(t)) return v.slice(0, -t.length).trim(); return v; };

/** Colour phrase from the AccountMate "Color specs:" block, e.g. "BAC 701 BLACK". */
function colourPhrase(amRow) {
  const d = String(amRow?.["Short description"] || "").replace(/\\n/g, "\n");
  const m = d.match(/Color specs:<\/i><\/strong>\s*([^\n<]+)/i);
  if (!m) return "";
  return m[1].trim().replace(/\s+/g, " ");
}

/**
 * Decode the entities AccountMate leaves in its description HTML.
 *
 * Applied REPEATEDLY until stable: the long Description field is double-encoded
 * ("&amp;amp;") while Short description is single ("&amp;"). One pass leaves
 * "&amp;" behind, whose embedded semicolon then splits a qualification in half
 * -- "CLASS A&amp;B, GRADE D" became two entries, "CLASS A&amp" and "B, GRADE D".
 */
function decode(t) {
  let out = String(t || "").replace(/\\n/g, "\n");
  let prev;
  do {
    prev = out;
    out = out.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  } while (out !== prev);
  return out;
}

/** Pull one labelled block ("QPL", "Meets the requirements of") from a description. */
function specBlock(amRow, label) {
  const d = decode(amRow?.Description) + "\n" + decode(amRow?.["Short description"]);
  const m = d.match(new RegExp(label + ":<\\/i><\\/strong>\\s*([^\\n<]+)", "i"));
  return m ? m[1].trim() : "";
}

/** Split a spec block into individual qualifications. */
const splitSpecs = (block) =>
  block.split(";").map((x) => x.trim()).filter((x) => x && x.length > 2 && !/^amp$/i.test(x));

const unmappedSpecs = new Map();

/**
 * Resolve one spec string to a metaobject handle, or null. Records anything
 * MIL-shaped that cannot be resolved, so it is reported rather than lost.
 */
function milHandle(spec, sku) {
  for (const [re, handle] of MIL_SPEC_PATTERNS) if (re.test(spec)) return handle;
  if (/\bMIL-/i.test(spec)) {
    const why = MIL_SPEC_UNMAPPABLE.some((re) => re.test(spec)) ? "no matching metaobject" : "type/class not resolvable";
    if (!unmappedSpecs.has(spec)) unmappedSpecs.set(spec, { why, skus: [] });
    unmappedSpecs.get(spec).skus.push(sku);
  }
  return null;
}

const rows = [];
const seen = new Set();
const missing = [];

for (const r of np) {
  if (action.get(r["Variant SKU"] + "||" + r.Handle) === "add-variant") continue;
  if (seen.has(r.Handle)) continue;
  seen.add(r.Handle);

  const mpn = NEW_PRODUCT_HANDLE.normalizeMpn(base(r["Variant SKU"]));
  const t = T[mpn];
  if (!t) { missing.push(mpn); continue; }
  const [desc, spec] = t;
  const amRow = amBy.get(norm(r["Variant SKU"]));
  const fam = FAMILIES.find((f) => f.match.test(mpn));
  const title = ["Hentzen " + mpn, desc, spec].filter(Boolean).join(", ");
  const handle = ["hentzen", slug(mpn), spec ? slug(spec) : ""].filter(Boolean).join("-");

  // Lead sentence: unique per product. Part number + colour + what it is + spec.
  const colour = colourPhrase(amRow);
  const amColour = attr(amRow || {}, "Color");
  const leadNoun = LEAD_OVERRIDE[mpn] || desc.toLowerCase();
  const lead =
    `<p><strong>Hentzen ${mpn}</strong> is a ${leadNoun}` +
    (colour ? ` matched to ${colour.replace(/\b([A-Z]{2,})\b/g, (w) => w)}` : amColour ? ` in ${amColour.toLowerCase()}` : "") +
    (spec ? `, qualified to ${spec}` : "") +
    ".</p>";

  const bodyParts = [lead];
  if (fam) {
    bodyParts.push(`<p>${fam.body}</p>`);
    bodyParts.push(`<p>${fam.uses}</p>`);
  }
  const body = bodyParts.join("\n");

  // --- specifications ------------------------------------------------------
  const qplBlock = specBlock(amRow, "QPL");
  const meetsBlock = specBlock(amRow, "Meets the requirements of");
  const qplSpecs = splitSpecs(qplBlock);
  const allSpecs = [...qplSpecs, ...splitSpecs(meetsBlock)];

  // custom.qpl: only specs named in the QPL block -- that block is the
  // certification claim; "Meets the requirements of" is not the same thing.
  const qplHandles = [...new Set(qplSpecs.map((x) => milHandle(x, r["Variant SKU"])).filter(Boolean))];
  // custom.mil_specs: every MIL spec the product is qualified for, from either block.
  const milHandles = [...new Set(allSpecs.map((x) => milHandle(x, r["Variant SKU"])).filter(Boolean))];
  // compliance_certifications: everything that is NOT a MIL spec, deduped.
  const compliance = [...new Set(allSpecs.filter((x) => !/\bMIL-/i.test(x)))];

  const category = classifyCategory(desc, spec);
  const applications = APPLICATION_ATTRS.filter((n) => /^yes$/i.test(attr(amRow || {}, n)));

  rows.push({
    SKU: r["Variant SKU"],
    "Confirmed Handle": "",
    "Drafted Handle": handle,
    "Confirmed Title": "",
    "Drafted Title": title,
    "Confirmed Body HTML": "",
    "Drafted Body HTML": body,
    "Confirmed Mil Specs": "",
    "Drafted Mil Specs": milHandles.join(", "),
    "Confirmed QPL": "",
    "Drafted QPL": qplHandles.join(", "),
    "Confirmed Compliance": "",
    "Drafted Compliance": compliance.join("; "),
    "Confirmed Applications": "",
    "Drafted Applications": applications.join("; "),
    "Parent Collection": PARENT_COLLECTION[category],
    NSN: "",
    MPN: mpn,
    Description: desc,
    Spec: spec,
    Family: fam ? fam.family : "(none)",
  });
}

const H = [
  "SKU",
  "Confirmed Handle", "Drafted Handle",
  "Confirmed Title", "Drafted Title",
  "Confirmed Body HTML", "Drafted Body HTML",
  "Confirmed Mil Specs", "Drafted Mil Specs",
  "Confirmed QPL", "Drafted QPL",
  "Confirmed Compliance", "Drafted Compliance",
  "Confirmed Applications", "Drafted Applications",
  "Parent Collection",
  "NSN",
  "MPN", "Description", "Spec", "Family",
];
const esc = (v) => (/[",\n\r]/.test(String(v ?? "")) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ""));
fs.writeFileSync("new-product-content.csv", [H.join(","), ...rows.map((r) => H.map((h) => esc(r[h])).join(","))].join("\n") + "\n");

console.log(`drafted ${rows.length} products` + (missing.length ? `; no draft for: ${missing.join(", ")}` : ""));
const byFam = {};
rows.forEach((r) => (byFam[r.Family] = (byFam[r.Family] || 0) + 1));
console.log("\nby family:");
Object.entries(byFam).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(3)}  ${k}`));
const uniqueLeads = new Set(rows.map((r) => r["Drafted Body HTML"].split("\n")[0]));
console.log(`\nunique opening paragraphs: ${uniqueLeads.size} of ${rows.length}`);
console.log(`avg description length: ${Math.round(rows.reduce((a, r) => a + r["Drafted Body HTML"].length, 0) / rows.length)} chars`);
const n = (f) => rows.filter((r) => (r[f] || "").trim()).length;
console.log(`\nfields populated: mil_specs ${n("Drafted Mil Specs")}, qpl ${n("Drafted QPL")}, ` +
  `compliance ${n("Drafted Compliance")}, applications ${n("Drafted Applications")}, ` +
  `parent_collection ${n("Parent Collection")}, nsn ${n("NSN")}`);
if (unmappedSpecs.size) {
  console.log(`\nMIL specs found but NOT mapped to a metaobject (${unmappedSpecs.size}):`);
  for (const [spec, info] of unmappedSpecs) {
    console.log(`  ${JSON.stringify(spec)}`);
    console.log(`     ${info.why} -- affects ${info.skus.length} SKU(s)`);
  }
  console.log(`  These are left out of custom.mil_specs rather than guessed.`);
}
console.log("\nWrote new-product-content.csv");
