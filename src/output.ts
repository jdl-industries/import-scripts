import { createWriteStream } from 'fs';
import { stringify } from 'csv-stringify';
import type { ShopifyProduct } from './types.js';
import { OUTPUT_COLUMNS } from './types.js';

/**
 * Write transformed products to a Shopify-compatible CSV file
 */
export async function writeShopifyCSV(
  products: ShopifyProduct[],
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const writeStream = createWriteStream(outputPath);

    const stringifier = stringify({
      header: true,
      columns: OUTPUT_COLUMNS as unknown as string[],
    });

    stringifier.pipe(writeStream);

    for (const product of products) {
      stringifier.write(productToRow(product));
    }

    stringifier.end();

    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });
}

/**
 * Convert a ShopifyProduct to a CSV row array
 */
function productToRow(product: ShopifyProduct): string[] {
  return [
    product.sku,
    product.title,
    product.description,
    product.regularPrice,
    product.weight,
    product.length,
    product.width,
    product.height,
    product.aviation,
    product.marine,
    product.industrial,
    product.specialPackaging,
    product.category,
    product.isHazmat,
    product.manufacturerPartNumber,
    product.qpl,
    product.nsn,
    product.militarySpecification,
    product.complianceAndCertifications,
    product.leadTime,
    product.pageTitle,
    product.metaDescription,
    product.urlHandle,
  ];
}
