import { createReadStream } from 'fs';
import { parse } from 'csv-parse';
import type { WooCommerceProduct } from './types.js';

/**
 * Parse a WooCommerce product export CSV file
 */
export async function parseWooCommerceCSV(
  filePath: string
): Promise<WooCommerceProduct[]> {
  const products: WooCommerceProduct[] = [];
  const records: Record<string, string>[] = [];

  const parser = createReadStream(filePath).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      relax_column_count: true,
    })
  );

  for await (const record of parser) {
    records.push(record);
  }

  for (const record of records) {
    const product = extractProduct(record);
    if (product) {
      products.push(product);
    }
  }

  return products;
}

/**
 * Extract product data from a raw CSV record
 */
function extractProduct(
  record: Record<string, string>
): WooCommerceProduct | null {
  const sku = record['SKU']?.trim();

  // Skip records without SKU
  if (!sku) {
    return null;
  }

  // Extract attributes from the WooCommerce attribute columns
  const attributes = extractAttributes(record);

  return {
    sku,
    name: record['Name']?.trim() || '',
    shortDescription: record['Short description']?.trim() || '',
    description: record['Description']?.trim() || '',
    regularPrice: record['Regular price']?.trim() || '',
    weight: record['Weight (lbs)']?.trim() || '',
    length: record['Length (in)']?.trim() || '',
    width: record['Width (in)']?.trim() || '',
    height: record['Height (in)']?.trim() || '',
    attributes,
  };
}

/**
 * Extract attributes from WooCommerce attribute columns
 * WooCommerce exports attributes as pairs: "Attribute N name" and "Attribute N value(s)"
 */
function extractAttributes(record: Record<string, string>): Record<string, string> {
  const attributes: Record<string, string> = {};

  // WooCommerce typically exports up to 20+ attribute pairs
  for (let i = 1; i <= 20; i++) {
    const nameKey = `Attribute ${i} name`;
    const valueKey = `Attribute ${i} value(s)`;

    const name = record[nameKey]?.trim();
    const value = record[valueKey]?.trim();

    if (name && value) {
      attributes[name] = value;
    }
  }

  return attributes;
}

/**
 * Helper to get attribute value with fallback
 */
export function getAttribute(
  product: WooCommerceProduct,
  name: string,
  defaultValue: string = ''
): string {
  return product.attributes[name] || defaultValue;
}
