import type { AccountMateItem } from "./accountMateTypes";
import {
  getTitle,
  getDescription,
  getMeetsSpecs,
  getQPL,
  getImage,
  getType,
  getTags,
  getVendor,
  getPrice,
  getSize,
  getColor,
  getCategoryId,
  getCategoryName,
  getCategory,
  getParentCollection,
} from "./fieldMappings";

export type TrustLevel = "blind_update" | "requires_review";
export type TargetScope = "product" | "variant";

export interface FieldDefinition<T = unknown> {
  shopifyField: string;
  scope: TargetScope;
  trustLevel: TrustLevel;
  transform: (item: AccountMateItem) => T;
}

function isTruthy(val: string | undefined): boolean {
  return /^(yes|true|1)$/i.test((val || "").trim());
}

const parseInches = (length: string) => {
  const n = parseFloat(length);
  return Number.isFinite(n) && n > 0
    ? JSON.stringify({ value: n, unit: "INCHES" })
    : "";
};

const parseMoney = (amount: string) => {
  const n = parseFloat(amount);
  return Number.isFinite(n) ? `${n.toFixed(2)} USD` : "";
};

export const FIELD_DEFINITIONS: FieldDefinition[] = [
  // --- Trusted Variant Fields (Blind Import) ---
  {
    shopifyField: "Variant Price",
    scope: "variant",
    trustLevel: "blind_update",
    transform: getPrice,
  },
  {
    shopifyField: "Variant Cost",
    scope: "variant",
    trustLevel: "blind_update",
    transform: (item) => Number(item["Cost"] || 0).toFixed(2),
  },
  {
    shopifyField: "Variant Inventory Qty",
    scope: "variant",
    trustLevel: "blind_update",
    transform: (item) => item["On hand"],
  },
  {
    shopifyField: "Variant Weight",
    scope: "variant",
    trustLevel: "blind_update",
    transform: (item) => item["Weight (lbs)"],
  },
  {
    shopifyField: "Variant Weight Unit",
    scope: "variant",
    trustLevel: "blind_update",
    transform: () => "lb",
  },
  {
    shopifyField: "Option1 Name",
    scope: "variant",
    trustLevel: "blind_update",
    transform: () => "Size",
  },
  {
    shopifyField: "Option1 Value",
    scope: "variant",
    trustLevel: "blind_update",
    transform: getSize,
  },
  {
    shopifyField: "Variant Metafield: custom.hazardous [boolean]",
    scope: "variant",
    trustLevel: "blind_update",
    transform: (item) => (isTruthy(item["Hazardous"]) ? "true" : "false"),
  },
  {
    shopifyField: "Variant Metafield: custom.ships_frozen [boolean]",
    scope: "variant",
    trustLevel: "blind_update",
    transform: (item) => (isTruthy(item["Needs dry ice"]) ? "true" : "false"),
  },
  {
    shopifyField: "Variant Metafield: custom.special_packaging [boolean]",
    scope: "variant",
    trustLevel: "blind_update",
    transform: (item) =>
      isTruthy(item["Needs special pkg"]) ? "true" : "false",
  },
  {
    shopifyField: "Variant Metafield: custom.lead_time [number_integer]",
    scope: "variant",
    trustLevel: "blind_update",
    transform: (item) => Number(item["Lead time"] || 0),
  },
  {
    shopifyField: "Variant Metafield: custom.length [dimension]",
    scope: "variant",
    trustLevel: "blind_update",
    transform: (item) => parseInches(item["Length (in)"]),
  },
  {
    shopifyField: "Variant Metafield: custom.width [dimension]",
    scope: "variant",
    trustLevel: "blind_update",
    transform: (item) => parseInches(item["Width (in)"]),
  },
  {
    shopifyField: "Variant Metafield: custom.height [dimension]",
    scope: "variant",
    trustLevel: "blind_update",
    transform: (item) => parseInches(item["Height (in)"]),
  },
  {
    shopifyField:
      "Variant Metafield: custom.accountmate_description [multi_line_text_field]",
    scope: "variant",
    trustLevel: "blind_update",
    transform: (item) => item["Description"].trim(),
  },
  {
    shopifyField:
      "Variant Metafield: custom.accountmate_short_description [multi_line_text_field]",
    scope: "variant",
    trustLevel: "blind_update",
    transform: (item) => item["Short description"].trim(),
  },
  {
    shopifyField:
      "Variant Metafield: custom.accountmate_category [single_line_text_field]",
    scope: "variant",
    trustLevel: "blind_update",
    transform: (item) => item["Categories"].trim(),
  },
  {
    shopifyField:
      "Variant Metafield: custom.accountmate_vendor_part_number [single_line_text_field]",
    scope: "variant",
    trustLevel: "blind_update",
    transform: (item) => item["Vendor part number"].trim(),
  },
  {
    shopifyField:
      "Variant Metafield: custom.accountmate_tiered_prices [single_line_text_field]",
    scope: "variant",
    trustLevel: "blind_update",
    transform: (item) => item["Tier price"].trim(),
  },
  {
    shopifyField: "Variant Metafield: custom.accountmate_price [money]",
    scope: "variant",
    trustLevel: "blind_update",
    transform: (item) => parseMoney(item["Price"].trim()),
  },
  {
    shopifyField:
      "Variant Metafield: custom.accountmate_surcharge_amount [money]",
    scope: "variant",
    trustLevel: "blind_update",
    transform: (item) => parseMoney(item["Surcharge amount"].trim()),
  },
  {
    shopifyField:
      "Variant Metafield: custom.accountmate_surcharge_percent [number_decimal]",
    scope: "variant",
    trustLevel: "blind_update",
    transform: (item) => Number(item["Surcharge percent"] || 0),
  },
  // --- Trusted Product Fields (Blind Import) ---
  {
    shopifyField:
      "Metafield: custom.accountmate_color_specs [single_line_text_field]",
    scope: "product",
    trustLevel: "blind_update",
    transform: (item) => item["Color specs"],
  },
  {
    shopifyField:
      "Metafield: custom.accountmate_manufacturer [single_line_text_field]",
    scope: "product",
    trustLevel: "blind_update",
    transform: (item) => item["Manufacturer"].trim(),
  },
  {
    shopifyField: "Metafield: shopify.color-pattern [list.metaobject_reference]",
    scope: "product",
    trustLevel: "blind_update",
    transform: getColor,
  },
  {
    shopifyField: "Type",
    scope: "product",
    trustLevel: "blind_update",
    transform: getType,
  },
  {
    shopifyField: "Category: ID",
    scope: "product",
    trustLevel: "blind_update",
    transform: getCategoryId,
  },
  {
    shopifyField: "Category: Name",
    scope: "product",
    trustLevel: "blind_update",
    transform: getCategoryName,
  },
  {
    shopifyField: "Category",
    scope: "product",
    trustLevel: "blind_update",
    transform: getCategory,
  },
  {
    shopifyField: "Metafield: custom.parent_collection [collection_reference]",
    scope: "product",
    trustLevel: "blind_update",
    transform: getParentCollection,
  },
  {
    shopifyField: "Metafield: custom.accountmate_aviation [boolean]",
    scope: "product",
    trustLevel: "blind_update",
    transform: (item) => isTruthy(item["Aviation"].trim()),
  },
  {
    shopifyField: "Metafield: custom.accountmate_marine [boolean]",
    scope: "product",
    trustLevel: "blind_update",
    transform: (item) => isTruthy(item["Marine"].trim()),
  },
  {
    shopifyField: "Metafield: custom.accountmate_industrial [boolean]",
    scope: "product",
    trustLevel: "blind_update",
    transform: (item) => isTruthy(item["Industrial"].trim()),
  },
  {
    shopifyField: "Metafield: custom.series [single_line_text_field]",
    scope: "product",
    trustLevel: "blind_update",
    transform: (item) => item["Series"].trim(),
  },
  {
    shopifyField: "Metafield: custom.nsn [single_line_text_field]",
    scope: "product",
    trustLevel: "blind_update",
    transform: (item) => item["NSN number"].trim(),
  },
  // --- Non-Trusted fields (Trigger Review if ERP Changed) ---
  {
    shopifyField: "Title",
    scope: "product",
    trustLevel: "requires_review",
    transform: getTitle,
  },
  {
    shopifyField: "Body HTML",
    scope: "product",
    trustLevel: "requires_review",
    transform: getDescription,
  },
  {
    shopifyField: "Variant Image",
    scope: "variant",
    trustLevel: "requires_review",
    transform: getImage,
  },
  {
    shopifyField: "Vendor",
    scope: "product",
    trustLevel: "requires_review",
    transform: getVendor,
  },
  {
    shopifyField:
      "Metafield: custom.approved_specifications [list.metaobject_reference]",
    scope: "product",
    trustLevel: "requires_review",
    transform: getQPL,
  },
  {
    shopifyField:
      "Metafield: custom.meets_specifications [list.metaobject_reference]",
    scope: "product",
    trustLevel: "requires_review",
    transform: getMeetsSpecs,
  },
  {
    shopifyField: "Tags",
    scope: "product",
    trustLevel: "requires_review",
    transform: getTags,
  },
];
