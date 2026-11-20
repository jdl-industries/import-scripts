import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    type: { type: "string", short: "t" }, // 'am' | 'shopify'
    file: { type: "string", short: "f" }, // path to downloaded file
    date: { type: "string", short: "d" }, // YYYY-MM-DD (defaults to today)
  },
});

const today = new Date().toISOString().split("T")[0];
const targetDate = values.date || today;

if (!values.type || !values.file) {
  console.log(`
Usage:
  npx tsx scripts/ingest.ts --type <am|shopify> --file <path> [--date YYYY-MM-DD]

Examples:
  npx tsx scripts/ingest.ts -t am -f ~/Downloads/webfile.csv
  npx tsx scripts/ingest.ts -t shopify -f ~/Downloads/Products.csv
  `);
  process.exit(1);
}

const targetDir = path.resolve(
  "data",
  values.type === "am" ? "accountmate" : "shopify",
);
fs.mkdirSync(targetDir, { recursive: true });

const destPath = path.join(targetDir, `${targetDate}.csv`);
fs.copyFileSync(path.resolve(values.file), destPath);

console.log(`✓ Ingested [${values.type}] to: ${destPath}`);
