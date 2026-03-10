# JDL Shopify Import Tool

Import transformed product data into Shopify for JDL Industries aerospace/industrial coatings catalog.

## Overview

This tool is part of a two-step workflow for migrating products from WooCommerce to Shopify:

1. **Transform** (Manual with LLM): Use the prompt in `catalog creation prompt.md` with any LLM (ChatGPT, Claude, etc.) to transform WooCommerce export data into a Shopify-compatible CSV.

2. **Import** (This Tool): Use this CLI tool to import the transformed CSV into Shopify via the Admin API.

## Prerequisites

- Node.js 18+
- npm
- Shopify store with Admin API access

## Installation

```bash
npm install
```

## Configuration

Copy the example environment file and add your Shopify credentials:

```bash
cp .env.example .env
```

Required environment variables:

| Variable | Description |
|----------|-------------|
| `SHOPIFY_STORE_DOMAIN` | Your Shopify store domain (e.g., `store.myshopify.com`) |
| `SHOPIFY_ACCESS_TOKEN` | Admin API access token |

### Getting a Shopify Access Token

1. Go to Shopify Admin → Settings → Apps and sales channels
2. Click "Develop apps" → "Create an app"
3. Configure Admin API scopes:
   - `read_products`
   - `write_products`
4. Install the app and copy the Admin API access token

## Usage

### Step 1: Transform Products with LLM

1. Export products from WooCommerce as CSV
2. Open your preferred LLM (ChatGPT, Claude, etc.)
3. Paste the contents of `catalog creation prompt.md`
4. Attach or paste the WooCommerce CSV data
5. Ask the LLM to transform the products
6. Save the output as `products.csv`

**Tips for large catalogs:**
- Process in batches of 10-20 products at a time
- Use a model with large context window (Claude, GPT-4)
- Verify the first batch output before continuing

### Step 2: Import to Shopify

```bash
# Validate CSV format (no import)
npm run dev -- --validate products.csv

# Preview products without importing
npm run dev -- --dry-run products.csv

# Import products to Shopify
npm run dev -- products.csv
```

### Command Line Options

```
Usage:
  npm run dev -- <products.csv>
  npm run dev -- --validate <products.csv>
  npm run dev -- --dry-run <products.csv>

Options:
  --validate   Only validate CSV format, don't import
  --dry-run    Parse and display products without importing
  --help       Show help message
```

## CSV Format

The input CSV must have exactly these 23 columns (see `catalog creation prompt.md` for details):

| Column | Description |
|--------|-------------|
| SKU | Product SKU |
| Title | Product title |
| Description | Product description (HTML allowed) |
| Regular Price | Price as number |
| Weight | Weight in lbs |
| Length | Length in inches |
| Width | Width in inches |
| Height | Height in inches |
| Aviation | "Yes" or "No" |
| Marine | "Yes" or "No" |
| Industrial | "Yes" or "No" |
| Special Packaging | "Yes" or "No" |
| Category | Product category |
| Is Hazmat | "true" or "false" |
| Manufacturer Part Number | Vendor part number |
| QPL | QPL specification |
| NSN | National Stock Number |
| Military Specification | MIL spec |
| Compliance and Certifications | Other certifications |
| Lead Time | Days as integer |
| Page Title | SEO title (max 70 chars) |
| Meta Description | SEO description (max 160 chars) |
| URL Handle | URL slug |

## Development

### Project Structure

```
src/
├── index.ts    # CLI entry point
├── parser.ts   # CSV parsing and validation
├── shopify.ts  # Shopify Admin API client
└── types.ts    # TypeScript type definitions
```

### Scripts

```bash
npm run dev      # Run with tsx (development)
npm run build    # Compile TypeScript
npm start        # Run compiled JavaScript
```

### How Import Works

1. **Validation**: CSV is checked for required columns
2. **Parsing**: Products are extracted from CSV rows
3. **Upsert**: For each product:
   - Search Shopify for existing product by SKU
   - If found, update the product
   - If not found, create new product
4. **Rate Limiting**: 250ms delay between API calls

### Shopify Product Mapping

Products are created with:
- **Title, Description, Handle**: From CSV
- **Vendor**: Extracted from title (first word)
- **Product Type**: From Category column
- **Tags**: Aviation, Marine, Industrial, Hazmat flags
- **SEO**: Page title and meta description
- **Variant**: SKU, price, weight
- **Metafields**:
  - `custom.manufacturer_part_number`
  - `custom.qpl`
  - `custom.nsn`
  - `custom.military_specification`
  - `custom.compliance_certifications`
  - `custom.lead_time_days`
  - `custom.is_hazmat`

## Troubleshooting

### "Missing required columns"

Your CSV is missing expected columns. Check the column headers match exactly (case-sensitive). See the CSV Format section above.

### "SHOPIFY_STORE_DOMAIN and SHOPIFY_ACCESS_TOKEN are required"

Create a `.env` file with your Shopify credentials. See Configuration section.

### Shopify API errors

Common issues:
- **Invalid handle**: URL handles must be unique, lowercase, with only letters, numbers, and dashes
- **Rate limiting**: The tool includes delays, but if you hit limits, wait and retry
- **Missing scopes**: Ensure your app has `read_products` and `write_products` scopes

### Large imports

For catalogs with many products:
1. Transform in batches with the LLM
2. Combine batches into one CSV (keep only one header row)
3. Run the import tool

## License

Private - JDL Industries
