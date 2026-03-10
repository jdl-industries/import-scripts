import 'dotenv/config';
import { parseWooCommerceCSV } from './parser.js';
import { transformProduct } from './transformer.js';
import { writeShopifyCSV } from './output.js';
import { ShopifyClient } from './shopify.js';
import type { ShopifyProduct } from './types.js';

function printUsage(): void {
  console.log(`
JDL Import Tool - WooCommerce to Shopify Product Catalog Import

Usage:
  npm run dev -- [options] <input.csv> [output.csv]

Options:
  --import    After generating CSV, also import products to Shopify via Admin API
  --help      Show this help message

Environment Variables:
  ANTHROPIC_API_KEY      Required for LLM-based content generation
  SHOPIFY_STORE_DOMAIN   Required if using --import (e.g., your-store.myshopify.com)
  SHOPIFY_ACCESS_TOKEN   Required if using --import (Admin API access token)

Examples:
  npm run dev -- input.csv                    # Generate output.csv
  npm run dev -- input.csv products.csv       # Generate products.csv
  npm run dev -- --import input.csv           # Generate CSV and import to Shopify
`);
}

/**
 * Main entry point for the import tool
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse flags
  const importToShopify = args.includes('--import');
  const showHelp = args.includes('--help') || args.includes('-h');

  if (showHelp) {
    printUsage();
    process.exit(0);
  }

  // Remove flags from args
  const positionalArgs = args.filter((arg) => !arg.startsWith('--'));

  const inputPath = positionalArgs[0] || 'input.csv';
  const outputPath = positionalArgs[1] || 'output.csv';

  console.log(`Reading WooCommerce CSV from: ${inputPath}`);

  // Validate environment
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is required');
    process.exit(1);
  }

  if (importToShopify) {
    if (!process.env.SHOPIFY_STORE_DOMAIN || !process.env.SHOPIFY_ACCESS_TOKEN) {
      console.error(
        'Error: SHOPIFY_STORE_DOMAIN and SHOPIFY_ACCESS_TOKEN are required for --import'
      );
      process.exit(1);
    }
  }

  // Parse input CSV
  const products = await parseWooCommerceCSV(inputPath);
  console.log(`Parsed ${products.length} products`);

  // Transform products
  const transformedProducts: ShopifyProduct[] = [];
  let processed = 0;
  let errors = 0;

  for (const product of products) {
    try {
      process.stdout.write(
        `\rTransforming product ${processed + 1}/${products.length}: ${product.sku}`.padEnd(80)
      );

      const transformed = await transformProduct(product);
      transformedProducts.push(transformed);
      processed++;
    } catch (error) {
      console.error(`\nError transforming product ${product.sku}:`, error);
      errors++;
    }
  }

  console.log(`\nTransformed ${processed} products (${errors} errors)`);

  // Write output CSV
  await writeShopifyCSV(transformedProducts, outputPath);
  console.log(`Output written to: ${outputPath}`);

  // Import to Shopify if requested
  if (importToShopify) {
    console.log('\nImporting products to Shopify...');

    const client = new ShopifyClient();
    const results = await client.importProducts(
      transformedProducts,
      (current, total, sku) => {
        process.stdout.write(
          `\rImporting ${current}/${total}: ${sku}`.padEnd(80)
        );
      }
    );

    console.log(`\nImport complete: ${results.success} succeeded`);

    if (results.errors.length > 0) {
      console.log(`\n${results.errors.length} errors:`);
      for (const error of results.errors) {
        console.log(`  - ${error.sku}: ${error.error}`);
      }
    }
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
