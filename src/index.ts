import 'dotenv/config';
import { parseProductCSV, validateCSVColumns } from './parser.js';
import { ShopifyClient } from './shopify.js';

function printUsage(): void {
  console.log(`
JDL Shopify Import Tool

Imports products from a transformed CSV file into Shopify.

Usage:
  npm run dev -- <products.csv>
  npm run dev -- --validate <products.csv>
  npm run dev -- --dry-run <products.csv>

Options:
  --validate   Only validate CSV format, don't import
  --dry-run    Parse and display products without importing
  --help       Show this help message

Environment Variables (required for import):
  SHOPIFY_STORE_DOMAIN   Your Shopify store domain (e.g., store.myshopify.com)
  SHOPIFY_ACCESS_TOKEN   Admin API access token

CSV Format:
  The input CSV should be generated using an LLM with the transformation prompt.
  See "catalog creation prompt.md" for the expected format.

Examples:
  npm run dev -- products.csv              # Import products to Shopify
  npm run dev -- --validate products.csv   # Validate CSV format only
  npm run dev -- --dry-run products.csv    # Preview without importing
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse flags
  const validateOnly = args.includes('--validate');
  const dryRun = args.includes('--dry-run');
  const showHelp = args.includes('--help') || args.includes('-h');

  if (showHelp) {
    printUsage();
    process.exit(0);
  }

  // Get CSV file path
  const positionalArgs = args.filter((arg) => !arg.startsWith('--'));
  const csvPath = positionalArgs[0];

  if (!csvPath) {
    console.error('Error: CSV file path is required');
    printUsage();
    process.exit(1);
  }

  // Validate CSV columns
  console.log(`Validating CSV: ${csvPath}`);
  const validation = await validateCSVColumns(csvPath);

  if (validation.missing.length > 0) {
    console.error('\nError: Missing required columns:');
    validation.missing.forEach((col) => console.error(`  - ${col}`));
    process.exit(1);
  }

  if (validation.extra.length > 0) {
    console.log('\nNote: Extra columns will be ignored:');
    validation.extra.forEach((col) => console.log(`  - ${col}`));
  }

  console.log('CSV format valid.\n');

  if (validateOnly) {
    console.log('Validation complete.');
    process.exit(0);
  }

  // Parse products
  console.log('Parsing products...');
  const products = await parseProductCSV(csvPath);
  console.log(`Found ${products.length} products.\n`);

  if (products.length === 0) {
    console.log('No products to import.');
    process.exit(0);
  }

  // Dry run - just show products
  if (dryRun) {
    console.log('Dry run - products parsed:\n');
    for (const product of products) {
      console.log(`  ${product.sku}: ${product.title}`);
      console.log(`    Price: $${product.regularPrice}`);
      console.log(`    Mil Spec: ${product.militarySpecification || 'N/A'}`);
      console.log(`    URL: /${product.urlHandle}`);
      console.log('');
    }
    console.log('Dry run complete. No products were imported.');
    process.exit(0);
  }

  // Validate Shopify credentials
  if (!process.env.SHOPIFY_STORE_DOMAIN || !process.env.SHOPIFY_ACCESS_TOKEN) {
    console.error(
      'Error: SHOPIFY_STORE_DOMAIN and SHOPIFY_ACCESS_TOKEN environment variables are required.'
    );
    console.error('Set these in your .env file or export them in your shell.');
    process.exit(1);
  }

  // Import to Shopify
  console.log('Importing to Shopify...\n');

  const client = new ShopifyClient();
  const results = await client.importProducts(products, (current, total, sku) => {
    process.stdout.write(`\r  [${current}/${total}] ${sku}`.padEnd(60));
  });

  console.log('\n');
  console.log(`Import complete:`);
  console.log(`  Succeeded: ${results.success}`);
  console.log(`  Failed: ${results.errors.length}`);

  if (results.errors.length > 0) {
    console.log('\nErrors:');
    for (const error of results.errors) {
      console.log(`  ${error.sku}: ${error.error}`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
