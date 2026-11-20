export type ShopifyProductStatus = "Active" | "Archived" | "Draft";

/** Raw row format directly from Matrixify Products.csv */
export interface MatrixifyProductExportRow {
  ID: string;
  Handle: string;
  Tags: string;
  Status: string;
  "Variant ID": string;
  "Variant SKU": string;
}

export interface ShopifyVariant {
  variantId: string;
  productId: string;
  handle: string;
  sku: string;
  status: ShopifyProductStatus;
}

export interface ShopifyProduct {
  id: string;
  handle: string;
  status: ShopifyProductStatus;
  tags: string[];
  variants: ShopifyVariant[];
}

export interface ShopifyCatalog {
  /** Map of Product ID -> Product (containing nested variants) */
  productsById: Record<string, ShopifyProduct>;
  /** Map of Handle -> Product */
  productsByHandle: Record<string, ShopifyProduct>;
  /** 1:1 Map of SKU -> Active Variant */
  activeVariantsBySku: Record<string, ShopifyVariant>;
  /** Fallback map of SKU -> Archived Variants (for reactivation evaluation) */
  archivedVariantsBySku: Record<string, ShopifyVariant[]>;
}
