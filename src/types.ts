/**
 * Raw product data parsed from WooCommerce CSV
 */
export interface WooCommerceProduct {
  sku: string;
  name: string;
  shortDescription: string;
  description: string;
  regularPrice: string;
  weight: string;
  length: string;
  width: string;
  height: string;
  attributes: Record<string, string>;
}

/**
 * Transformed product data for Shopify import
 */
export interface ShopifyProduct {
  sku: string;
  title: string;
  description: string;
  regularPrice: string;
  weight: string;
  length: string;
  width: string;
  height: string;
  aviation: string;
  marine: string;
  industrial: string;
  specialPackaging: string;
  category: string;
  isHazmat: string;
  manufacturerPartNumber: string;
  qpl: string;
  nsn: string;
  militarySpecification: string;
  complianceAndCertifications: string;
  leadTime: string;
  pageTitle: string;
  metaDescription: string;
  urlHandle: string;
}

/**
 * Extracted specification data from product descriptions
 */
export interface ExtractedSpecs {
  milSpec: string | null;
  qpl: string | null;
  nsn: string | null;
  certifications: string[];
  productType: string | null;
  color: string | null;
}

/**
 * LLM-generated content for a product
 */
export interface GeneratedContent {
  title: string;
  description: string;
  pageTitle: string;
  metaDescription: string;
  urlHandle: string;
}

/**
 * Output CSV column headers
 */
export const OUTPUT_COLUMNS = [
  'SKU',
  'Title',
  'Description',
  'Regular Price',
  'Weight',
  'Length',
  'Width',
  'Height',
  'Aviation',
  'Marine',
  'Industrial',
  'Special Packaging',
  'Category',
  'Is Hazmat',
  'Manufacturer Part Number',
  'QPL',
  'NSN',
  'Military Specification',
  'Compliance and Certifications',
  'Lead Time',
  'Page Title',
  'Meta Description',
  'URL Handle',
] as const;
