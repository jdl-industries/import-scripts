import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { readAccountMateExport } from "../src/parseAccountMate";
import { readShopifyCatalog } from "../src/parseShopify";
import { generateSyncPlan } from "../src/syncEngine";
import { buildProductGroupIndex, getShopifyProduct } from "../src/productResolver";
import { outputMatrixifySyncFiles } from "../src/writeMatrixifyFiles";

const DATA_DIR = path.resolve("data");
const AM_DIR = path.join(DATA_DIR, "accountmate");
const SHOPIFY_DIR = path.join(DATA_DIR, "shopify");
const RUNS_DIR = path.join(DATA_DIR, "runs");

function listCsvDates(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f))
    .map((f) => f.replace(".csv", ""))
    .sort();
}

function resolveInputs(targetDate?: string) {
  const amDates = listCsvDates(AM_DIR);
  const shopifyDates = listCsvDates(SHOPIFY_DIR);

  if (amDates.length === 0)
    throw new Error(`No AccountMate files found in ${AM_DIR}`);
  if (shopifyDates.length === 0)
    throw new Error(`No Shopify files found in ${SHOPIFY_DIR}`);

  // Resolve target date: use specified or the latest available AM date
  const selectedDate = targetDate || amDates[amDates.length - 1];
  const amIndex = amDates.indexOf(selectedDate);
  if (amIndex === -1)
    throw new Error(`AccountMate snapshot not found for date: ${selectedDate}`);

  const latestAmPath = path.join(AM_DIR, `${selectedDate}.csv`);
  const previousAmPath =
    amIndex > 0 ? path.join(AM_DIR, `${amDates[amIndex - 1]}.csv`) : null;

  // Resolve Shopify snapshot: if a specific AM date was requested, use the most
  // recent Shopify snapshot on/before that date for reproducibility. Otherwise
  // (default run), just use the latest Shopify snapshot available.
  let shopifyDate: string | undefined;
  if (targetDate) {
    const matchingShopifyDates = shopifyDates.filter((d) => d <= selectedDate);
    shopifyDate = matchingShopifyDates[matchingShopifyDates.length - 1];
  } else {
    shopifyDate = shopifyDates[shopifyDates.length - 1];
  }
  if (!shopifyDate)
    throw new Error(`No Shopify baseline found on or before: ${selectedDate}`);
  const shopifyPath = path.join(SHOPIFY_DIR, `${shopifyDate}.csv`);

  return { selectedDate, latestAmPath, previousAmPath, shopifyPath };
}

function getNextRunDir(dateStr: string): string {
  let runNumber = 1;
  while (true) {
    const runId = `${dateStr}_run-${String(runNumber).padStart(2, "0")}`;
    const dir = path.join(RUNS_DIR, runId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }
    runNumber++;
  }
}

function execute() {
  const { values } = parseArgs({
    options: {
      date: { type: "string", short: "d" }, // Optional: e.g. "2026-11-06"
    },
  });

  const { selectedDate, latestAmPath, previousAmPath, shopifyPath } =
    resolveInputs(values.date);

  console.log(`\n======================================================`);
  console.log(`Executing Sync for Date: ${selectedDate}`);
  console.log(`  Latest AM:   ${path.basename(latestAmPath)}`);
  console.log(
    `  Previous AM: ${previousAmPath ? path.basename(previousAmPath) : "(None - Baseline)"}`,
  );
  console.log(`  Shopify:     ${path.basename(shopifyPath)}`);
  console.log(`======================================================\n`);

  const latestAm = readAccountMateExport(latestAmPath);
  const previousAm = previousAmPath
    ? readAccountMateExport(previousAmPath)
    : {};
  const shopify = readShopifyCatalog(shopifyPath);

  const groupIndex = buildProductGroupIndex(latestAm, shopify);
  const plan = generateSyncPlan(
    previousAm,
    latestAm,
    shopify,
    (item, catalog) => getShopifyProduct(item, catalog, groupIndex),
  );

  const outDir = getNextRunDir(selectedDate);
  outputMatrixifySyncFiles(plan, outDir);

  console.log(`\nSync generation complete.`);
  console.log(`Output generated in:  ${path.relative(process.cwd(), outDir)}`);

  console.log(`\n--- Sync Reconciliation Summary ---`);
  console.log(`Total AccountMate SKUs:     ${Object.keys(latestAm).length}`);
  console.log(`  ├─ Trusted Updates:       ${plan.trustedUpdates.length}`);
  console.log(`  ├─ Unchanged (Skipped):   ${plan.unchanged.length}`);
  console.log(`  └─ New Product Drafts:    ${plan.newProductDrafts.length}`);
  console.log(
    `Total Handled:              ${plan.trustedUpdates.length + plan.unchanged.length + plan.newProductDrafts.length}`,
  );
  console.log(`\nShopify Deprecations:       ${plan.deprecations.length}`);
  console.log(`ERP Drift Warnings:         ${plan.driftReviews.length}`);
}

execute();
