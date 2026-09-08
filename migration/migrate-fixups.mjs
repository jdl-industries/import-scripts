import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { SIZE_METAOBJECT, SIZE_RENAMES, SIZE_VOCABULARY } from "../sync-config.js";

const P=(f)=>parse(fs.readFileSync(f),{columns:true,skip_empty_lines:true,relax_column_count:true,bom:true});
const esc=(v)=>{if(v==null)return"";const s=String(v);return /[",\n\r]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;};
const W=(f,h,rows)=>{fs.mkdirSync(path.dirname(f),{recursive:true});
 fs.writeFileSync(f,[h.map(esc).join(","),...rows.map(r=>h.map(x=>esc(r[x]??"")).join(","))].join("\n")+"\n");};
const norm=s=>(s||"").trim().toUpperCase().replace(/\s+/g," ");
const r=P("Products.csv");
const O=process.argv[2]||"migration";
const date=new Date().toISOString().slice(0,10);
const SZ="Metafield: custom.size [list.metaobject_reference]";

// hydrate product-level
const cols=Object.keys(r[0]).filter(h=>/^Metafield:/.test(h)).concat(["Title","Option1 Name","Status"]);
const carry=new Map();
r.forEach(x=>{if(!carry.has(x.Handle))carry.set(x.Handle,{});const c=carry.get(x.Handle);cols.forEach(k=>{if((x[k]||"").trim())c[k]=x[k]})});
const hyd=r.map(x=>{const c=carry.get(x.Handle)||{};const o={...x};cols.forEach(k=>{if(!(o[k]||"").trim()&&c[k])o[k]=c[k]});return o});

// --- A. blank Variant SKUs on real products -------------------------------
const INTENDED={
 "hentzen-pg-6-w28-mil-prf-85285-type-i-qpl":"AXPG-6-W28  G2",
 "hentzen-pg-6-w3-mil-prf-85285-type-i-qpl":"AXPG-6-W3  G2",
 "hentzen-31111rpx-t1-mil-prf-85285e-type-i":"HZK31111RPX-T1",
};
const skuRows=[];
for(const x of r){
 if(!INTENDED[x.Handle])continue;
 if((x["Variant SKU"]||"").trim())continue;
 skuRows.push({ID:x.ID,Handle:x.Handle,Command:"MERGE","Variant ID":x["Variant ID"],
  "Variant Command":"MERGE","Variant SKU":INTENDED[x.Handle],__note:"was blank"});
}

// --- B. legacy size values -> current enumeration --------------------------
const renameRows=[];
const byHandle=new Map();
hyd.forEach(x=>{if(!byHandle.has(x.Handle))byHandle.set(x.Handle,[]);byHandle.get(x.Handle).push(x)});
for(const [h,rows] of byHandle){
 if(!rows.some(x=>SIZE_RENAMES[(x["Option1 Value"]||"").trim()]))continue;
 // every variant of the product, so custom.size can be rebuilt correctly
 const sizes=rows.map(x=>{const v=(x["Option1 Value"]||"").trim();return SIZE_RENAMES[v]||v;});
 const distinct=[...new Set(sizes)].sort((a,b)=>SIZE_VOCABULARY.indexOf(a)-SIZE_VOCABULARY.indexOf(b));
 const handles=distinct.map(s=>SIZE_METAOBJECT[s]).filter(Boolean);
 rows.forEach((x,i)=>{
  const was=(x["Option1 Value"]||"").trim();
  const now=SIZE_RENAMES[was]||was;
  if(was===now && i!==0) return;           // untouched variant, nothing to say
  renameRows.push({ID:x.ID,Handle:h,Command:"MERGE",
   [SZ]: i===0 && handles.length===distinct.length ? handles.join(", ") : "",
   "Variant ID":x["Variant ID"],"Variant Command":"MERGE","Variant SKU":x["Variant SKU"],
   "Option1 Name":"Size","Option1 Value":now,
   __was: was===now?"":was});});
}

console.log("--- 03e fixups ---");
console.log("  blank Variant SKUs to set : "+skuRows.length);
skuRows.forEach(x=>console.log("      "+x.Handle.slice(0,48).padEnd(50)+"<- "+x["Variant SKU"]));
console.log("  legacy size values to rename : "+renameRows.filter(x=>x.__was).length+"  (across "+new Set(renameRows.map(x=>x.Handle)).size+" products, "+renameRows.length+" rows emitted)");
renameRows.filter(x=>x.__was).forEach(x=>console.log("      "+x.Handle.slice(0,44).padEnd(46)+x.__was+"  ->  "+x["Option1 Value"]));
console.log("  custom.size rebuilt on "+renameRows.filter(x=>(x[SZ]||"").trim()).length+" product(s)");
renameRows.filter(x=>(x[SZ]||"").trim()).forEach(x=>console.log("      "+x.Handle.slice(0,44).padEnd(46)+x[SZ]));

if(skuRows.length) W(path.join(O,`03e-fill-skus-${date}.csv`),
 ["ID","Handle","Command","Variant ID","Variant Command","Variant SKU","__note"],skuRows);
if(renameRows.length) W(path.join(O,`03f-size-renames-${date}.csv`),
 ["ID","Handle","Command",SZ,"Variant ID","Variant Command","Variant SKU","Option1 Name","Option1 Value","__was"],renameRows);
console.log("\nWrote 03e / 03f to "+O+"/");
