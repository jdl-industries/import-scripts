/**
 * Transformed product data from LLM-generated CSV
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
 * CSV column headers (must match LLM output format)
 */
export const CSV_COLUMNS = [
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

/**
 * Map CSV column name to ShopifyProduct property
 */
export const COLUMN_TO_PROPERTY: Record<string, keyof ShopifyProduct> = {
  'SKU': 'sku',
  'Title': 'title',
  'Description': 'description',
  'Regular Price': 'regularPrice',
  'Weight': 'weight',
  'Length': 'length',
  'Width': 'width',
  'Height': 'height',
  'Aviation': 'aviation',
  'Marine': 'marine',
  'Industrial': 'industrial',
  'Special Packaging': 'specialPackaging',
  'Category': 'category',
  'Is Hazmat': 'isHazmat',
  'Manufacturer Part Number': 'manufacturerPartNumber',
  'QPL': 'qpl',
  'NSN': 'nsn',
  'Military Specification': 'militarySpecification',
  'Compliance and Certifications': 'complianceAndCertifications',
  'Lead Time': 'leadTime',
  'Page Title': 'pageTitle',
  'Meta Description': 'metaDescription',
  'URL Handle': 'urlHandle',
};
