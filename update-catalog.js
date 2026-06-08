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

// --- Field Mapping: CSV Column -> Shopify Field ---
// skipCompare: true means we can't fetch the current value from Shopify, so we'll always include
//              these fields in updates when there are other changes (use --sync-all to force)
const FIELD_MAP = {
  'Regular price': { shopifyField: 'price', type: 'variant', compare: 'number' },
  'Stock': { shopifyField: 'inventory', type: 'inventory', compare: 'integer' },
  'Weight (lbs)': { shopifyField: 'weight', type: 'variant', compare: 'number', unit: 'POUNDS' },
  'Length (in)': { shopifyField: 'length', type: 'metafield', namespace: 'custom', compare: 'dimension', unit: 'INCHES' },
  'Width (in)': { shopifyField: 'width', type: 'metafield', namespace: 'custom', compare: 'dimension', unit: 'INCHES' },
  'Height (in)': { shopifyField: 'height', type: 'metafield', namespace: 'custom', compare: 'dimension', unit: 'INCHES' },
  'Attribute 1 value(s)': { shopifyField: 'color', type: 'option', compare: 'string', skipCompare: true },
  'Attribute 8 value(s)': { shopifyField: 'manufacturer_part_number', type: 'metafield', namespace: 'custom', compare: 'string' },
  'Attribute 12 value(s)': { shopifyField: 'is_hazmat', type: 'metafield', namespace: 'custom', compare: 'string' },
};

// --- CLI Argument Parsing ---
function parseArgs() {
  const args = process.argv.slice(2);
  const config = { dryRun: false, syncAll: false, inputFile: null };

  for (const arg of args) {
    if (arg === '--dry-run' || arg === '-d') {
      config.dryRun = true;
    } else if (arg === '--sync-all' || arg === '-a') {
      config.syncAll = true;
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
            selectedOptions {
              name
              value
            }
            inventoryItem {
              id
              measurement {
                weight {
                  value
                  unit
                }
              }
            }
            inventoryQuantity
            product {
              id
              title
            }
            metafields(first: 10, namespace: "custom") {
              edges {
                node {
                  key
                  value
                }
              }
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

  const variant = edges[0].node;

  // Flatten metafields for easier access
  variant.metafieldsMap = {};
  for (const edge of variant.metafields?.edges || []) {
    variant.metafieldsMap[edge.node.key] = edge.node.value;
  }

  // Flatten options for easier access
  variant.optionsMap = {};
  for (const opt of variant.selectedOptions || []) {
    variant.optionsMap[opt.name.toLowerCase()] = opt.value;
  }

  return variant;
}

async function getLocationId() {
  const query = `
    query {
      locations(first: 1, includeLegacy: true) {
        edges {
          node {
            id
            name
            isActive
          }
        }
      }
    }
  `;

  const result = await shopifyGraphQL(query);

  if (result.errors) {
    console.error('Location query errors:', JSON.stringify(result.errors, null, 2));
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  }

  const edges = result.data?.locations?.edges || [];

  if (edges.length === 0) {
    console.error('Location query returned no locations. Full response:', JSON.stringify(result, null, 2));
    throw new Error('No locations found in Shopify store');
  }

  const location = edges[0].node;
  console.log(`Found location: "${location.name}" (${location.id})`);

  return location.id;
}

// --- Comparison Helpers ---
function compareValues(csvValue, shopifyValue, compareType) {
  if (csvValue === '' || csvValue === null || csvValue === undefined) {
    return true; // Empty CSV value means no change needed
  }

  if (compareType === 'number') {
    const csvNum = parseFloat(csvValue);
    const shopifyNum = parseFloat(shopifyValue);
    if (isNaN(csvNum)) return true; // Invalid CSV value, skip
    if (isNaN(shopifyNum)) return false; // Shopify has no value, CSV does
    return Math.abs(csvNum - shopifyNum) < 0.001; // Float comparison with tolerance
  }

  if (compareType === 'integer') {
    const csvInt = parseInt(csvValue, 10);
    const shopifyInt = parseInt(shopifyValue, 10);
    if (isNaN(csvInt)) return true;
    if (isNaN(shopifyInt)) return false;
    return csvInt === shopifyInt;
  }

  if (compareType === 'dimension') {
    // Shopify dimension metafields are JSON: {"value": 8.0, "unit": "INCHES"}
    const csvNum = parseFloat(csvValue);
    if (isNaN(csvNum)) return true;
    if (!shopifyValue) return false; // Shopify has no value, CSV does
    try {
      const parsed = JSON.parse(shopifyValue);
      const shopifyNum = parseFloat(parsed.value);
      if (isNaN(shopifyNum)) return false;
      return Math.abs(csvNum - shopifyNum) < 0.001;
    } catch {
      return false; // Can't parse Shopify value, assume different
    }
  }

  // String comparison
  return String(csvValue).trim() === String(shopifyValue || '').trim();
}

function getShopifyValue(variant, fieldConfig) {
  switch (fieldConfig.type) {
    case 'variant':
      if (fieldConfig.shopifyField === 'price') {
        return variant.price;
      }
      if (fieldConfig.shopifyField === 'weight') {
        return variant.inventoryItem?.measurement?.weight?.value;
      }
      break;
    case 'inventory':
      return variant.inventoryQuantity;
    case 'metafield':
      return variant.metafieldsMap?.[fieldConfig.shopifyField];
    case 'option':
      return variant.optionsMap?.[fieldConfig.shopifyField];
  }
  return null;
}

function detectChanges(row, variant, syncAll = false) {
  const changes = {
    variant: {},      // price, weight
    inventory: null,  // stock quantity
    metafields: [],   // custom metafields
    options: {},      // color, etc.
  };
  let hasComparableChanges = false;
  const pendingSkipCompareFields = []; // Fields we can't compare, add later if needed

  // Helper to add a field change
  function addChange(fieldConfig, csvValue) {
    switch (fieldConfig.type) {
      case 'variant':
        if (fieldConfig.shopifyField === 'price') {
          changes.variant.price = csvValue;
        } else if (fieldConfig.shopifyField === 'weight') {
          changes.variant.weight = parseFloat(csvValue);
          changes.variant.weightUnit = fieldConfig.unit;
        }
        break;
      case 'inventory':
        changes.inventory = parseInt(csvValue, 10);
        break;
      case 'metafield':
        if (fieldConfig.compare === 'dimension') {
          // Dimension metafields need JSON value with unit
          changes.metafields.push({
            namespace: fieldConfig.namespace,
            key: fieldConfig.shopifyField,
            value: JSON.stringify({ value: parseFloat(csvValue), unit: fieldConfig.unit }),
            type: 'dimension'
          });
        } else {
          changes.metafields.push({
            namespace: fieldConfig.namespace,
            key: fieldConfig.shopifyField,
            value: csvValue,
            type: 'single_line_text_field'
          });
        }
        break;
      case 'option':
        changes.options[fieldConfig.shopifyField] = csvValue;
        break;
    }
  }

  for (const [csvColumn, fieldConfig] of Object.entries(FIELD_MAP)) {
    const csvValue = row[csvColumn];
    if (csvValue === '' || csvValue === null || csvValue === undefined) {
      continue; // Skip empty CSV values
    }

    // Fields marked skipCompare can't be compared (we can't fetch current value from Shopify)
    if (fieldConfig.skipCompare) {
      pendingSkipCompareFields.push({ fieldConfig, csvValue });
      continue;
    }

    const shopifyValue = getShopifyValue(variant, fieldConfig);
    const isEqual = compareValues(csvValue, shopifyValue, fieldConfig.compare);

    if (!isEqual) {
      hasComparableChanges = true;
      addChange(fieldConfig, csvValue);
    }
  }

  // Handle tiered pricing separately (legacy)
  const tieredPrices = row['Fixed Tiered Prices'];
  const regularPrice = row['Regular price'];
  if (tieredPrices && tieredPrices.trim()) {
    const tieredPricingObj = transformTieredPricing(tieredPrices, regularPrice);
    if (tieredPricingObj) {
      hasComparableChanges = true;
      changes.metafields.push({
        namespace: 'app--339692257281',
        key: 'tiered_pricing',
        value: JSON.stringify(tieredPricingObj),
        type: 'json'
      });
    }
  }

  // Include skipCompare fields only if:
  // 1. --sync-all flag is set, OR
  // 2. There are other comparable changes (piggyback on the update)
  if (syncAll || hasComparableChanges) {
    for (const { fieldConfig, csvValue } of pendingSkipCompareFields) {
      addChange(fieldConfig, csvValue);
    }
  }

  const hasChanges = hasComparableChanges || (syncAll && pendingSkipCompareFields.length > 0);

  return { hasChanges, changes };
}

// --- Update Functions ---
async function updateVariantFields(variantId, productId, variantChanges) {
  if (Object.keys(variantChanges).length === 0) return;

  const variantInput = { id: variantId };
  if (variantChanges.price !== undefined) {
    variantInput.price = variantChanges.price;
  }
  if (variantChanges.weight !== undefined) {
    variantInput.weight = variantChanges.weight;
    variantInput.weightUnit = variantChanges.weightUnit;
  }

  const mutation = `
    mutation updateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const result = await shopifyGraphQL(mutation, {
    productId: productId,
    variants: [variantInput]
  });

  if (result.errors) {
    throw new Error(`GraphQL errors (variant): ${JSON.stringify(result.errors)}`);
  }

  const userErrors = result.data?.productVariantsBulkUpdate?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(`User errors (variant): ${JSON.stringify(userErrors)}`);
  }
}

async function updateInventory(inventoryItemId, locationId, quantity) {
  if (quantity === null || quantity === undefined) return;
  if (!locationId) {
    console.log('  Skipping inventory update: No location ID available');
    return;
  }

  const mutation = `
    mutation setInventory($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup {
          reason
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const result = await shopifyGraphQL(mutation, {
    input: {
      name: "available",
      reason: "correction",
      quantities: [{
        inventoryItemId: inventoryItemId,
        locationId: locationId,
        quantity: quantity
      }]
    }
  });

  if (result.errors) {
    throw new Error(`GraphQL errors (inventory): ${JSON.stringify(result.errors)}`);
  }

  const userErrors = result.data?.inventorySetQuantities?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(`User errors (inventory): ${JSON.stringify(userErrors)}`);
  }
}

async function updateMetafields(ownerId, metafields) {
  if (metafields.length === 0) return;

  const mutation = `
    mutation setMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const metafieldInputs = metafields.map(mf => ({
    ownerId: ownerId,
    namespace: mf.namespace,
    key: mf.key,
    value: mf.value,
    type: mf.type
  }));

  const result = await shopifyGraphQL(mutation, { metafields: metafieldInputs });

  if (result.errors) {
    throw new Error(`GraphQL errors (metafields): ${JSON.stringify(result.errors)}`);
  }

  const userErrors = result.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(`User errors (metafields): ${JSON.stringify(userErrors)}`);
  }
}

async function applyChanges(variant, changes, locationId) {
  await updateVariantFields(variant.id, variant.product.id, changes.variant);
  await updateInventory(variant.inventoryItem.id, locationId, changes.inventory);
  await updateMetafields(variant.id, changes.metafields);
}

// --- Change Description Helper ---
function describeChanges(changes) {
  const parts = [];

  if (changes.variant.price !== undefined) {
    parts.push(`price: ${changes.variant.price}`);
  }
  if (changes.variant.weight !== undefined) {
    parts.push(`weight: ${changes.variant.weight} lbs`);
  }
  if (changes.inventory !== null && changes.inventory !== undefined) {
    parts.push(`stock: ${changes.inventory}`);
  }
  for (const mf of changes.metafields) {
    if (mf.key === 'tiered_pricing') {
      parts.push('tiered pricing');
    } else if (mf.type === 'dimension') {
      // Parse dimension JSON for nicer display
      try {
        const dim = JSON.parse(mf.value);
        parts.push(`${mf.key}: ${dim.value}"`);
      } catch {
        parts.push(`${mf.key}: ${mf.value}`);
      }
    } else {
      parts.push(`${mf.key}: ${mf.value}`);
    }
  }

  return parts.join(', ');
}

// --- Main ---
async function main() {
  const config = parseArgs();

  if (!config.inputFile) {
    console.error('Usage: node update-catalog.js <input-file.csv> [--dry-run] [--sync-all]');
    console.error('  --dry-run, -d   Show what would be updated without making changes');
    console.error('  --sync-all, -a  Force sync all fields (including dimensions, etc.)');
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

  console.log(`Found ${rows.length} rows to process`);

  // Fetch location ID for inventory updates (required for stock changes)
  let locationId = null;
  console.log('Fetching inventory location...');
  try {
    locationId = await getLocationId();
    if (!locationId) {
      console.error('Error: getLocationId() returned null/undefined');
      console.error('Inventory updates will fail. Check your Shopify store has at least one location.\n');
    }
  } catch (error) {
    console.error(`Error fetching location ID: ${error.message}`);
    console.error('Inventory updates will be skipped.\n');
  }
  console.log('');

  const missingProducts = [];
  const updatedProducts = [];
  const unchangedProducts = [];
  const failedUpdates = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const sku = row['SKU'];

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

      console.log(`  Found: ${variant.product.title}`);

      const { hasChanges, changes } = detectChanges(row, variant, config.syncAll);

      if (!hasChanges) {
        console.log('  No changes needed');
        unchangedProducts.push(row);
        continue;
      }

      const changeDesc = describeChanges(changes);
      console.log(`  Changes: ${changeDesc}`);

      if (config.dryRun) {
        console.log('  [DRY RUN] Would update');
        updatedProducts.push(row);
      } else {
        await applyChanges(variant, changes, locationId);
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
  console.log(`Unchanged: ${unchangedProducts.length}`);
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
