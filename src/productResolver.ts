import type { AccountMateItem, AccountMateRecords } from "./accountMateTypes";
import type { ShopifyCatalog, ShopifyProduct } from "./shopifyTypes";

/**
 * Variants sharing a product are grouped by this AccountMate field, keyed by
 * Manufacturer since the grouping field differs by manufacturer's catalog conventions.
 */
const GROUP_KEY_FIELD_BY_MANUFACTURER: Record<string, keyof AccountMateItem> = {
  "Hentzen Coatings, Inc.": "Vendor part number",
  "Henkel Aerospace": "Vendor part number",
  "3M": "Series",
  FlameMaster: "Series",
};

function getGroupKey(item: AccountMateItem): string | null {
  const field = GROUP_KEY_FIELD_BY_MANUFACTURER[item["Manufacturer"]];
  if (!field) return null;

  const value = item[field];
  if (!value) return null;

  return `${item["Manufacturer"]}::${value}`;
}

/**
 * Indexes every manufacturer-specific grouping key to the Shopify product already
 * carrying an active sibling variant, so a new SKU can be matched to that product
 * even though its own SKU has never appeared in Shopify before.
 */
export function buildProductGroupIndex(
  accountMateRecords: AccountMateRecords,
  shopifyRecords: ShopifyCatalog,
): Record<string, ShopifyProduct> {
  const index: Record<string, ShopifyProduct> = {};

  for (const item of Object.values(accountMateRecords)) {
    const groupKey = getGroupKey(item);
    if (!groupKey || index[groupKey]) continue;

    const activeMatch = shopifyRecords.activeVariantsBySku[item["SKU"]];
    if (activeMatch) {
      index[groupKey] = shopifyRecords.productsById[activeMatch.productId];
    }
  }

  return index;
}

/**
 * Top-down resolver to match an AccountMate record to an existing Shopify product.
 * Returns the matched product or null if it represents a brand new product.
 */
export function getShopifyProduct(
  accountMateRecord: AccountMateItem,
  shopifyRecords: ShopifyCatalog,
  groupIndex: Record<string, ShopifyProduct>,
): ShopifyProduct | null {
  // Check if SKU exists on an active variant first
  const activeMatch = shopifyRecords.activeVariantsBySku[accountMateRecord["SKU"]];
  if (activeMatch) {
    return shopifyRecords.productsById[activeMatch.productId] || null;
  }

  // Fall back to matching a sibling variant via the manufacturer's grouping field
  const groupKey = getGroupKey(accountMateRecord);
  if (groupKey && groupIndex[groupKey]) {
    return groupIndex[groupKey];
  }

  return null;
}
