# JDL Import Tool

WooCommerce to Shopify product catalog import tool for aerospace and industrial coatings. Transforms product data using Claude AI to generate SEO-optimized titles, descriptions, and metadata.

## Prerequisites

- Node.js 18+
- npm
- Anthropic API key (for Claude)
- Shopify Admin API credentials (optional, for direct import)

## Installation

```bash
npm install
```

## Configuration

Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env
```

Required environment variables:

| Variable | Description | Required |
|----------|-------------|----------|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude | Yes |
| `SHOPIFY_STORE_DOMAIN` | Your Shopify store domain (e.g., `store.myshopify.com`) | Only for `--import` |
| `SHOPIFY_ACCESS_TOKEN` | Shopify Admin API access token | Only for `--import` |

### Getting a Shopify Access Token

1. Go to your Shopify Admin → Settings → Apps and sales channels
2. Click "Develop apps" → "Create an app"
3. Configure Admin API scopes: `write_products`, `read_products`
4. Install the app and copy the Admin API access token

## Usage

### Generate CSV Only

Transform WooCommerce export to Shopify-compatible CSV:

```bash
# Using ts-node for development
npm run dev -- input.csv output.csv

# Using compiled JavaScript
npm run build
npm start -- input.csv output.csv
```

### Generate CSV and Import to Shopify

```bash
npm run dev -- --import input.csv output.csv
```

### Command Line Options

```
Usage:
  npm run dev -- [options] <input.csv> [output.csv]

Options:
  --import    After generating CSV, also import products to Shopify via Admin API
  --help      Show help message

Arguments:
  input.csv   Path to WooCommerce product export CSV (default: input.csv)
  output.csv  Path for generated Shopify CSV (default: output.csv)
```

## Input Format

The tool expects a WooCommerce product export CSV with the following structure:

| Column | Description |
|--------|-------------|
| SKU | Product SKU |
| Name | Product name |
| Short description | Contains mil spec, QPL info (HTML) |
| Description | Full product description (HTML) |
| Regular price | Product price |
| Weight (lbs) | Product weight |
| Length/Width/Height (in) | Product dimensions |

Product attributes are expected in WooCommerce's attribute column format:
- `Attribute 1 name`, `Attribute 1 value(s)`
- `Attribute 2 name`, `Attribute 2 value(s)`
- etc.

Expected attributes:
- Manufacturer
- Vendor SKU
- Barcode1 (often contains NSN)
- Hazardous (Yes/No)
- Aviation (Yes/No)
- Marine (Yes/No)
- Industrial (Yes/No)
- Special packaging (Yes/No)
- Lead time

## Output Format

The tool generates a CSV with 23 columns:

1. SKU
2. Title
3. Description
4. Regular Price
5. Weight
6. Length
7. Width
8. Height
9. Aviation
10. Marine
11. Industrial
12. Special Packaging
13. Category
14. Is Hazmat
15. Manufacturer Part Number
16. QPL
17. NSN
18. Military Specification
19. Compliance and Certifications
20. Lead Time
21. Page Title
22. Meta Description
23. URL Handle

See `catalog creation prompt.md` for detailed field specifications.

## Development

### Project Structure

```
src/
├── index.ts        # CLI entry point
├── parser.ts       # WooCommerce CSV parsing
├── transformer.ts  # LLM-based content transformation
├── output.ts       # Shopify CSV generation
├── shopify.ts      # Shopify Admin API client
└── types.ts        # TypeScript type definitions
```

### Scripts

```bash
npm run dev      # Run with ts-node (development)
npm run build    # Compile TypeScript to JavaScript
npm start        # Run compiled JavaScript
```

### How Transformation Works

1. **Parsing**: The WooCommerce CSV is parsed, extracting standard columns and attribute pairs into structured product objects.

2. **Specification Extraction**: Regular expressions extract:
   - Military specifications (MIL-PRF-XXXXX, MIL-DTL-XXXXX, etc.)
   - QPL qualifications
   - NSN (National Stock Numbers)
   - Other certifications (BMS, MEP, FMS, LMCO specs)

3. **LLM Generation**: Each product is sent to Claude to generate:
   - SEO-optimized title following the format: `{Manufacturer} {Part Numbers}, {Description}, {MIL-SPEC} {Type} {Class} {(QPL)}`
   - Human-readable product description
   - Page title (max 70 chars)
   - Meta description (max 160 chars)
   - URL handle

4. **Output**: Transformed products are written to CSV and optionally imported to Shopify.

### Adding New Fields

1. Add the field to `ShopifyProduct` interface in `src/types.ts`
2. Add the column name to `OUTPUT_COLUMNS` array in `src/types.ts`
3. Update `transformProduct()` in `src/transformer.ts` to populate the field
4. Update `productToRow()` in `src/output.ts` to include the field in the correct position
5. If importing to Shopify, update `buildProductInput()` in `src/shopify.ts`
6. Document the field in `catalog creation prompt.md`

### Modifying the LLM Prompt

The prompt sent to Claude is in `src/transformer.ts` in the `buildPrompt()` function. Modify this to change how titles, descriptions, or other generated content is formatted.

### Rate Limiting

- The Shopify import includes a 250ms delay between API calls to avoid rate limits.
- Claude API calls are made sequentially (one product at a time) to manage costs and avoid rate limits.

## Troubleshooting

### "ANTHROPIC_API_KEY environment variable is required"

Ensure your `.env` file exists and contains a valid API key:

```bash
ANTHROPIC_API_KEY=sk-ant-api03-...
```

### CSV parsing errors

The parser uses relaxed options for quotes and column counts. If you still see parsing errors, check for:
- Unescaped quotes in product descriptions
- Inconsistent column counts between rows

### Shopify import errors

Common issues:
- **Invalid handle**: URL handles must be unique and contain only lowercase letters, numbers, and dashes
- **Missing required fields**: Ensure products have SKU and title
- **Rate limiting**: The tool includes delays, but if you hit limits, wait and retry

## License

Private - JDL Industries
