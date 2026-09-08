import fs from "fs";
import { parse } from "csv-parse/sync";
import { NEW_PRODUCT_HANDLE } from "./sync-config.js";

// Drafted descriptions + specs, keyed by the MPN base (SKU with AX rule applied
// and size stripped). Description is 2-4 terse words; spec is the MIL spec the
// product is certified/qualified to, else the primary qualification, else blank.
const T = {
  "AX-10":        ["Polyurethane Accelerator", ""],
  "AX-17":        ["Polyurethane Accelerator", ""],
  "AX-1440-SW":   ["Silver-White Reflective Paint", ""],
  "SR-12":       ["Medium Topcoat Reducer", ""],
  "EF-2-BK1":     ["Flat Black Epoxy Topcoat", "MIL-PRF-22750"],
  "EG-2-BK1":     ["Gloss Black Epoxy Topcoat", "MIL-PRF-22750"],
  "EG-2-G1":      ["Gloss Gray Epoxy Topcoat", "MIL-PRF-22750"],
  "EG-2-W1":      ["Gloss White Epoxy Topcoat", "MIL-PRF-22750"],
  "EP-3-GN2":     ["Green Epoxy Primer", "DMS 1786"],
  "PF-6-BK1":     ["Flat Black Topcoat", "MIL-PRF-85285 Type IV"],
  "PS-6-BR6":     ["Semi-Gloss Brown Topcoat", "MIL-PRF-85285 Type IV"],
  "PG-21-G2":     ["Gray Polyurethane Topcoat", "BAMS 565-002"],
  "PG-6-B127":    ["Gloss Blue Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-B483":    ["Jet Blue Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-B487":    ["Gloss Blue Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-BK1":     ["Gloss Black Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-BK3":     ["Gloss Black Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-C1":      ["Gloss Clear Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-C19":     ["Clear Touch-Up Kit", "MIL-PRF-85285 Type I"],
  "PG-6-G1":      ["Gloss Gray Topcoat Base", "MIL-PRF-85285 Type I"],
  "PG-6-G28":     ["Gloss Gray Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-G36":     ["Gloss Gray Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-G38":     ["Gray Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-G70318":  ["Gray Standard-Cure Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-G9":      ["Gloss Gray Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-W138":    ["Matterhorn White Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-W2":      ["Gloss White Touch-Up Kit", "MIL-PRF-85285 Type I"],
  "PG-6-W29":     ["Gloss White Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-W39":     ["Jet Glo White Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-W5":      ["Gloss White Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-W65":     ["Gloss White Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-W7":      ["Gloss White Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-W76":     ["Gloss White Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-W9":      ["Gloss White Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-Y122":    ["Gloss Yellow Topcoat", "MIL-PRF-85285 Type I"],
  "PG-6-Y26":     ["Gloss Yellow Topcoat", "MIL-PRF-85285 Type I"],
  "PNF-14-BK1":   ["Black Non-Skid Walkway", "AA-59166 Type II"],
  "PS-1-W7":      ["Semi-Gloss White Topcoat", "FAR 25.853"],
  "TF-1-BK1":    ["Flat Black PTFE Topcoat", "BMS 10-86"],
  "TF-1-BR1":     ["Flat Brown PTFE Topcoat", "BAMS 565-005"],
  "TS-1-G1":     ["Gray PTFE Topcoat", "BAMS 565-005"],
  "TS-1-G70318K1":["Gray PTFE Topcoat", "BAMS 565-005"],
  "TS-1-W1":      ["Semi-Gloss White PTFE Topcoat", "BAMS 565-005"],
  "WF-3-B36":     ["Flat Blue Interior Waterbase", "DPM 5949"],
  "WF-3-BK1":    ["Flat Black Interior Waterbase", "DPM 5949"],
  "WF-3-BR1":    ["Flat Brown Interior Waterbase", "DPM 5949"],
  "WF-3-G7":     ["Flat Gray Interior Waterbase", "DPM 5949"],
  "WF-3-GN1":    ["Flat Green Interior Waterbase", "DPM 5949"],
  "WF-3-W37":    ["Oyster White Interior Waterbase", "DPM 5949"],
  "WF-3-W71":     ["Sail White Interior Waterbase", "DPM 5949"],
  "WS-3-W10":    ["White Water-Reducible Topcoat", "BMS 10-83"],
  "WF-3-B36":     ["Flat Blue Interior Waterbase", "DPM 5949"],
  "WF-3-W71":     ["Sail White Interior Waterbase", "DPM 5949"],
  "22167WEP": ["Off-White Epoxy Primer", "MIL-DTL-53022F Type IV"],
  "35554ZPX":  ["Gray Flat Topcoat", "MIL-PRF-85285 Type IV"],
};

const O=process.argv[2];
const P=(f)=>parse(fs.readFileSync(f),{columns:true,skip_empty_lines:true,relax_column_count:true,bom:true});
const pick=p=>fs.readdirSync(O).filter(x=>x.startsWith(p)).sort().pop();
const np=P(O+"/"+pick("new-products")), rep=P(O+"/"+pick("sync-report"));
const norm=s=>(s||"").trim().toUpperCase().replace(/\s+/g," ");
const action=new Map(rep.filter(r=>r.File==="new").map(r=>[r["Variant SKU"]+"||"+r.Handle,r["Handle Source"]]));
const SIZE=[" G"," KIT","-2G","K-1/4 GL","2-OZ/KIT","2-OZ/KT","KIT-2GL","KIT-1GL","K-5GL","K-2GL","2GLKT","4OZ/K","6OZ/K","GL/KT","QT/KT","GK-1","GK-2","_2G","G-1","_G","GL","G1","G2","G4","Q2","QT","BASE"].sort((a,b)=>b.length-a.length);
const base=s=>{let v=norm(s);for(const t of SIZE)if(v.endsWith(t))return v.slice(0,-t.length).trim();return v};
const rows=[];const seen=new Set();const missing=[];
np.forEach(r=>{
 if(action.get(r["Variant SKU"]+"||"+r.Handle)==="add-variant")return;
 if(seen.has(r.Handle))return; seen.add(r.Handle);
 const mpn=NEW_PRODUCT_HANDLE.normalizeMpn(base(r["Variant SKU"]));
 const t=T[mpn];
 if(!t){missing.push(mpn+"  ("+norm(r["Variant SKU"])+")");return}
 const title=["Hentzen "+mpn, t[0], t[1]].filter(Boolean).join(", ");
 rows.push({SKU:r["Variant SKU"],Handle:r.Handle,"Confirmed Title":"","Drafted Title":title,MPN:mpn,Description:t[0],Spec:t[1]||""});
});
console.log("drafted "+rows.length+" titles"+(missing.length?"; NO DRAFT for "+missing.length+":":""));
missing.forEach(m=>console.log("   "+m));
console.log();
rows.slice(0,20).forEach(r=>console.log("  "+r["Drafted Title"]));
const H=["SKU","Handle","Confirmed Title","Drafted Title","MPN","Description","Spec"];
const esc=v=>/[",\n\r]/.test(String(v??""))?`"${String(v).replace(/"/g,'""')}"`:String(v??"");
fs.writeFileSync("new-product-titles.csv",[H.join(","),...rows.map(r=>H.map(h=>esc(r[h])).join(","))].join("\n")+"\n");
console.log("\nWrote new-product-titles.csv ("+rows.length+" rows)");
