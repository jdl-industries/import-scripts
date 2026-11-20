import * as fs from "node:fs";
import { parse } from "csv-parse/sync";
import type {
  MatrixifyProductExportRow,
  ShopifyCatalog,
  ShopifyProduct,
  ShopifyProductStatus,
  ShopifyVariant,
} from "./shopifyTypes";

function parseStatus(raw: string | undefined): ShopifyProductStatus {
  const normalized = (raw || "").trim().toLowerCase();
  if (normalized === "active") return "Active";
  if (normalized === "archived") return "Archived";
  return "Draft";
}

function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/**
 * Parses Matrixify export CSV and maps it into hierarchical products and SKU lookup dictionaries.
 */
export function readShopifyCatalog(filePath: string): ShopifyCatalog {
  const content = fs.readFileSync(filePath, "utf-8");

  const rows: MatrixifyProductExportRow[] = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
  });

  const catalog: ShopifyCatalog = {
    productsById: {},
    productsByHandle: {},
    activeVariantsBySku: {},
    archivedVariantsBySku: {},
  };

  for (const row of rows) {
    const productId = row["ID"]?.trim();
    const handle = row["Handle"]?.trim();
    const variantId = row["Variant ID"]?.trim();
    const sku = row["Variant SKU"]?.trim();

    if (!productId || !variantId) continue;

    const status = parseStatus(row["Status"]);
    const tags = parseTags(row["Tags"]);

    // 1. Get or initialize parent product
    let product = catalog.productsById[productId];
    if (!product) {
      product = {
        id: productId,
        handle,
        status,
        tags,
        variants: [],
      };
      catalog.productsById[productId] = product;
      catalog.productsByHandle[handle] = product;
    }

    // 2. Build variant entity
    const variant: ShopifyVariant = {
      variantId,
      productId,
      handle,
      sku: sku || "",
      status,
    };

    product.variants.push(variant);

    // 3. Map SKU lookups, prioritizing Active representations
    if (sku) {
      if (status === "Active") {
        catalog.activeVariantsBySku[sku] = variant;
      } else {
        if (!catalog.archivedVariantsBySku[sku]) {
          catalog.archivedVariantsBySku[sku] = [];
        }
        catalog.archivedVariantsBySku[sku].push(variant);
      }
    }
  }

  return catalog;
}
