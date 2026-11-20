import type { AccountMateItem, AccountMateRecords } from "./accountMateTypes";
import type { ShopifyCatalog, ShopifyProduct } from "./shopifyTypes";
import { FIELD_DEFINITIONS, type FieldDefinition } from "./fieldDefinitions";
import { getHandle } from "./fieldMappings";

export interface SyncResults {
  deprecations: Array<{
    variantId: string;
    productId: string;
    sku: string;
    handle: string;
    archiveProduct: boolean;
  }>;
  trustedUpdates: Array<{
    handle: string;
    variantId?: string; // Present for existing, omitted for new variant
    sku: string;
    isNewVariant: boolean;
    fields: Record<string, string>;
  }>;
  driftReviews: Array<{
    sku: string;
    handle: string;
    field: string;
    previousErpValue: unknown;
    latestErpValue: unknown;
  }>;
  newProductDrafts: Array<{
    suggestedHandle: string;
    sku: string;
    fields: Record<string, string>;
  }>;
  unchanged: Array<{
    sku: string;
    handle: string;
    variantId: string;
    reason: "NO_ERP_CHANGES" | "IDENTICAL_HASH";
    lastObservedPrice: number;
    lastObservedOnHand: number;
  }>;
}

export function generateSyncPlan(
  prevAm: AccountMateRecords,
  latestAm: AccountMateRecords,
  shopify: ShopifyCatalog,
  resolveProduct: (
    item: AccountMateItem,
    cat: ShopifyCatalog,
  ) => ShopifyProduct | null,
): SyncResults {
  const results: SyncResults = {
    deprecations: [],
    trustedUpdates: [],
    driftReviews: [],
    newProductDrafts: [],
    unchanged: [],
  };

  // =========================================================================
  // 1. Deprecations (In Previous ERP, but missing from Latest ERP)
  // =========================================================================
  for (const sku of Object.keys(prevAm)) {
    if (!latestAm[sku]) {
      const activeVariant = shopify.activeVariantsBySku[sku];
      if (activeVariant) {
        const parentProduct = shopify.productsById[activeVariant.productId];

        // Check if all other sibling variants on this product are also gone
        const remainingActiveVariants = parentProduct.variants.filter(
          (v) => v.sku !== sku && Boolean(latestAm[v.sku]),
        );

        results.deprecations.push({
          variantId: activeVariant.variantId,
          productId: activeVariant.productId,
          sku,
          handle: activeVariant.handle,
          archiveProduct: remainingActiveVariants.length === 0,
        });
      }
    }
  }

  // =========================================================================
  // 2. Additions & Updates (Items in Latest ERP)
  // =========================================================================
  for (const [sku, latestItem] of Object.entries(latestAm)) {
    const prevItem = prevAm[sku];
    const matchedProduct = resolveProduct(latestItem, shopify);
    const existingActiveVariant = shopify.activeVariantsBySku[sku];

    if (!matchedProduct) {
      // ---------------------------------------------------------------------
      // WORKSTREAM 4: Brand New Product (Draft Staging)
      // ---------------------------------------------------------------------
      const fields: Record<string, string> = {};
      for (const rule of FIELD_DEFINITIONS) {
        fields[rule.shopifyField] = String(rule.transform(latestItem));
      }

      fields["Status"] = "Draft";
      fields["Variant SKU"] = latestItem["SKU"];

      results.newProductDrafts.push({
        suggestedHandle: getHandle(latestItem),
        sku: latestItem["SKU"],
        fields,
      });
      continue;
    }

    // -----------------------------------------------------------------------
    // WORKSTREAM 1 & 2: Existing Product Match
    // -----------------------------------------------------------------------
    const trustedFields: Record<string, string> = {};
    const trustedRules = FIELD_DEFINITIONS.filter(
      (r) => r.trustLevel === "blind_update",
    );

    const isNewVariant = !existingActiveVariant;

    // Check if any trusted values changed or if it's a new variant needing creation
    let hasTrustedChanges = isNewVariant;

    for (const rule of trustedRules) {
      const currentVal = String(rule.transform(latestItem));
      trustedFields[rule.shopifyField] = currentVal;

      if (prevItem) {
        const prevVal = String(rule.transform(prevItem));
        if (currentVal !== prevVal) {
          hasTrustedChanges = true;
        }
      } else {
        hasTrustedChanges = true;
      }
    }

    if (hasTrustedChanges) {
      if (isNewVariant) {
        trustedFields["Variant Inventory Tracker"] = "shopify";
        trustedFields["Variant Inventory Policy"] = "deny";
      }

      results.trustedUpdates.push({
        handle: matchedProduct.handle,
        variantId: existingActiveVariant?.variantId,
        sku: latestItem["SKU"],
        isNewVariant,
        fields: trustedFields,
      });
    } else if (existingActiveVariant) {
      // Record has an existing active variant and had no changes between exports
      results.unchanged.push({
        sku: latestItem["SKU"],
        handle: matchedProduct.handle,
        variantId: existingActiveVariant.variantId,
        reason: "NO_ERP_CHANGES",
        lastObservedPrice: Number(latestItem["Price"] || 0),
        lastObservedOnHand: Number(latestItem["On hand"] || 0),
      });
    }

    // -----------------------------------------------------------------------
    // WORKSTREAM 3: Non-Trusted Drift Detection (ERP changed title/desc/specs)
    // -----------------------------------------------------------------------
    if (prevItem) {
      const reviewRules = FIELD_DEFINITIONS.filter(
        (r) => r.trustLevel === "requires_review",
      );
      for (const rule of reviewRules) {
        const prevTransformed = rule.transform(prevItem);
        const latestTransformed = rule.transform(latestItem);

        if (
          JSON.stringify(prevTransformed) !== JSON.stringify(latestTransformed)
        ) {
          results.driftReviews.push({
            sku,
            handle: matchedProduct.handle,
            field: rule.shopifyField,
            previousErpValue: prevTransformed,
            latestErpValue: latestTransformed,
          });
        }
      }
    }
  }

  return results;
}
