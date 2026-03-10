import { createReadStream } from 'fs';
import { parse } from 'csv-parse';
import type { ShopifyProduct } from './types.js';
import { COLUMN_TO_PROPERTY } from './types.js';

/**
 * Parse the LLM-generated product CSV file
 */
export async function parseProductCSV(
  filePath: string
): Promise<ShopifyProduct[]> {
  const products: ShopifyProduct[] = [];

  const parser = createReadStream(filePath).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      relax_column_count: true,
      trim: true,
    })
  );

  for await (const record of parser) {
    const product = recordToProduct(record);
    if (product) {
      products.push(product);
    }
  }

  return products;
}

/**
 * Convert a CSV record to a ShopifyProduct
 */
function recordToProduct(
  record: Record<string, string>
): ShopifyProduct | null {
  // Check for SKU - required field
  const sku = record['SKU']?.trim();
  if (!sku) {
    return null;
  }

  // Build product object from CSV columns
  const product: Partial<ShopifyProduct> = {};

  for (const [columnName, propertyName] of Object.entries(COLUMN_TO_PROPERTY)) {
    const value = record[columnName]?.trim() || '';
    product[propertyName] = value;
  }

  return product as ShopifyProduct;
}

/**
 * Validate that a CSV has the expected columns
 */
export async function validateCSVColumns(filePath: string): Promise<{
  valid: boolean;
  missing: string[];
  extra: string[];
}> {
  const parser = createReadStream(filePath).pipe(
    parse({
      columns: true,
      to: 1, // Only read first row to get headers
    })
  );

  let headers: string[] = [];

  for await (const record of parser) {
    headers = Object.keys(record);
    break;
  }

  const expectedColumns = Object.keys(COLUMN_TO_PROPERTY);
  const missing = expectedColumns.filter((col) => !headers.includes(col));
  const extra = headers.filter((col) => !expectedColumns.includes(col));

  return {
    valid: missing.length === 0,
    missing,
    extra,
  };
}
