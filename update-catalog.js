#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuration ---
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const API_VERSION = '2024-01';

// --- CLI Argument Parsing ---
function parseArgs() {
  const args = process.argv.slice(2);
  const config = { dryRun: false, inputFile: null };

  for (const arg of args) {
    if (arg === '--dry-run' || arg === '-d') {
      config.dryRun = true;
    } else if (!arg.startsWith('-')) {
      config.inputFile = arg;
    }
  }

  return config;
}

// --- CSV Parsing ---
function parseCSV(content) {
  const rows = [];
  let headers = [];
  let currentRow = [];
  let currentField = '';
  let inQuotes = false;
  let isFirstRow = true;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentField += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      currentRow.push(currentField.trim());
      currentField = '';
    } else if ((char === '\n' || (char === '\r' && nextChar === '\n')) && !inQuotes) {
      if (char === '\r') i++; // skip \n in \r\n
      currentRow.push(currentField.trim());
      currentField = '';

      if (isFirstRow) {
        headers = currentRow;
        isFirstRow = false;
      } else if (currentRow.some(field => field)) {
        const rowObj = {};
        headers.forEach((header, idx) => {
          rowObj[header] = currentRow[idx] || '';
        });
        rowObj._raw = currentRow.join(',');
        rows.push(rowObj);
      }
      currentRow = [];
    } else if (char !== '\r') {
      currentField += char;
    }
  }

  // Handle last row if no trailing newline
  if (currentRow.length > 0 || currentField) {
    currentRow.push(currentField.trim());
    if (currentRow.some(field => field)) {
      const rowObj = {};
      headers.forEach((header, idx) => {
        rowObj[header] = currentRow[idx] || '';
      });
      rowObj._raw = currentRow.join(',');
      rows.push(rowObj);
    }
  }

  return { headers, rows };
}

// --- CSV Writing ---
function writeCSV(filePath, headers, rows) {
  if (rows.length === 0) return;

  const escapeCSVValue = (val) => {
    if (val == null) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [
    headers.map(escapeCSVValue).join(','),
    ...rows.map(row => headers.map(h => escapeCSVValue(row[h])).join(','))
  ];

  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

// --- Tiered Pricing Transformation ---
function transformTieredPricing(tieredPricesStr, regularPrice) {
  if (!tieredPricesStr || !tieredPricesStr.trim()) {
    return null;
  }

  const basePrice = parseFloat(regularPrice);
  const pairs = tieredPricesStr.split(',').map(p => p.trim()).filter(Boolean);
  const quantityBreaks = [];
  const discountEntry = { name: 'All customers' };

  for (const pair of pairs) {
    const [qty, price] = pair.split(':').map(s => s.trim());
    const qtyNum = parseInt(qty, 10);

    if (qtyNum === 1) {
      discountEntry['1'] = null;
    } else {
      quantityBreaks.push(qtyNum);
      const tieredPrice = parseFloat(price);
      const discount = (basePrice - tieredPrice).toFixed(2);
      discountEntry[qty] = discount;
    }
  }

  quantityBreaks.sort((a, b) => a - b);

  return {
    discounts: [discountEntry],
    quantityBreaks,
    discountType: 'price'
  };
}

// --- Shopify API ---
async function shopifyGraphQL(query, variables = {}) {
  const url = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Shopify API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function findProductBySKU(sku) {
  const query = `
    query findBySKU($query: String!) {
      productVariants(first: 1, query: $query) {
        edges {
          node {
            id
            sku
            price
            product {
              id
              title
            }
          }
        }
      }
    }
  `;

  const result = await shopifyGraphQL(query, { query: `sku:${sku}` });

  if (result.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  }

  const edges = result.data?.productVariants?.edges || [];
  if (edges.length === 0) return null;

  return edges[0].node;
}

async function updateVariant(variantId, productId, price, tieredPricingJson) {
  // Update price using productVariantsBulkUpdate
  const priceMutation = `
    mutation updateVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          price
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const priceResult = await shopifyGraphQL(priceMutation, {
    productId: productId,
    variants: [{ id: variantId, price: price }]
  });

  if (priceResult.errors) {
    throw new Error(`GraphQL errors (price): ${JSON.stringify(priceResult.errors)}`);
  }

  const priceUserErrors = priceResult.data?.productVariantsBulkUpdate?.userErrors || [];
  if (priceUserErrors.length > 0) {
    throw new Error(`User errors (price): ${JSON.stringify(priceUserErrors)}`);
  }

  // Update metafield using metafieldsSet
  if (tieredPricingJson) {
    const metafieldMutation = `
      mutation setMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            namespace
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const metafieldResult = await shopifyGraphQL(metafieldMutation, {
      metafields: [{
        ownerId: variantId,
        namespace: 'app--339692257281',
        key: 'tiered_pricing',
        value: tieredPricingJson,
        type: 'json'
      }]
    });

    if (metafieldResult.errors) {
      throw new Error(`GraphQL errors (metafield): ${JSON.stringify(metafieldResult.errors)}`);
    }

    const metafieldUserErrors = metafieldResult.data?.metafieldsSet?.userErrors || [];
    if (metafieldUserErrors.length > 0) {
      throw new Error(`User errors (metafield): ${JSON.stringify(metafieldUserErrors)}`);
    }
  }

  return { id: variantId, price };
}

// --- Main ---
async function main() {
  const config = parseArgs();

  if (!config.inputFile) {
    console.error('Usage: node update-catalog.js <input-file.csv> [--dry-run]');
    process.exit(1);
  }

  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) {
    console.error('Error: SHOPIFY_STORE and SHOPIFY_TOKEN environment variables are required');
    process.exit(1);
  }

  if (!fs.existsSync(config.inputFile)) {
    console.error(`Error: Input file not found: ${config.inputFile}`);
    process.exit(1);
  }

  console.log(`Reading input file: ${config.inputFile}`);
  if (config.dryRun) {
    console.log('*** DRY RUN MODE - No changes will be made ***\n');
  }

  const content = fs.readFileSync(config.inputFile, 'utf-8');
  const { headers, rows } = parseCSV(content);

  console.log(`Found ${rows.length} rows to process\n`);

  const missingProducts = [];
  const updatedProducts = [];
  const failedUpdates = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const sku = row['SKU'];
    const regularPrice = row['Regular price'];
    const tieredPrices = row['Fixed Tiered Prices'];

    console.log(`[${i + 1}/${rows.length}] Processing SKU: ${sku}`);

    if (!sku) {
      console.log('  Skipping: No SKU');
      continue;
    }

    try {
      const variant = await findProductBySKU(sku);

      if (!variant) {
        console.log('  Not found in Shopify');
        missingProducts.push(row);
        continue;
      }

      console.log(`  Found: ${variant.product.title} (current price: ${variant.price})`);

      const tieredPricingObj = transformTieredPricing(tieredPrices, regularPrice);
      const tieredPricingJson = tieredPricingObj ? JSON.stringify(tieredPricingObj) : null;

      console.log(`  New price: ${regularPrice}`);
      if (tieredPricingJson) {
        console.log(`  Tiered pricing: ${tieredPricingJson}`);
      }

      if (config.dryRun) {
        console.log('  [DRY RUN] Would update variant');
        updatedProducts.push(row);
      } else {
        await updateVariant(variant.id, variant.product.id, regularPrice, tieredPricingJson);
        console.log('  Updated successfully');
        updatedProducts.push(row);
      }
    } catch (error) {
      console.log(`  Error: ${error.message}`);
      row._error = error.message;
      failedUpdates.push(row);
    }
  }

  // Write output files
  const outputDir = path.dirname(config.inputFile);

  if (missingProducts.length > 0) {
    const missingFile = path.join(outputDir, 'missing_products.csv');
    writeCSV(missingFile, headers, missingProducts);
    console.log(`\nWrote ${missingProducts.length} missing products to: ${missingFile}`);
  }

  if (updatedProducts.length > 0) {
    const updatedFile = path.join(outputDir, 'updated_products.csv');
    writeCSV(updatedFile, headers, updatedProducts);
    console.log(`Wrote ${updatedProducts.length} updated products to: ${updatedFile}`);
  }

  if (failedUpdates.length > 0) {
    const failedFile = path.join(outputDir, 'failed_updates.csv');
    writeCSV(failedFile, headers, failedUpdates);
    console.log(`Wrote ${failedUpdates.length} failed updates to: ${failedFile}`);
  }

  console.log('\n--- Summary ---');
  console.log(`Total processed: ${rows.length}`);
  console.log(`Updated: ${updatedProducts.length}`);
  console.log(`Missing: ${missingProducts.length}`);
  console.log(`Failed: ${failedUpdates.length}`);

  if (config.dryRun) {
    console.log('\n*** This was a dry run - no actual changes were made ***');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
