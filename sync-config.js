/**
 * Configuration for sync-catalog.js
 *
 * Everything tunable lives here. The sync script itself contains no
 * catalog-specific knowledge.
 */

// ---------------------------------------------------------------------------
// AccountMate attribute access
// ---------------------------------------------------------------------------
// The AccountMate export is WooCommerce-shaped: 19 generic "Attribute N name" /
// "Attribute N value(s)" column pairs. The positions are stable today, but we
// resolve by NAME so a reordered export doesn't silently shift every value.
export const ATTRIBUTE_SLOTS = 19;

// ---------------------------------------------------------------------------
// Field mapping: AccountMate -> Shopify
// ---------------------------------------------------------------------------
// `source` is either { col: "<AccountMate column>" } or { attr: "<attribute name>" }.
// `compare` selects the equality test (number | integer | string).
// `transform` converts the AccountMate value to its Shopify representation.
// `tolerance` overrides the numeric equality threshold (default 0.01).
// `scope`:
//   "variant" - the value lives on the variant row (default)
//   "product" - a product.metafields.* value, shared by every variant of the
//               product. Shopify only populates these on a product's FIRST row,
//               so they must be compared and written once per product, never
//               per variant.
// `blankPolicy`:
//   "skip"      - a blank/zero AccountMate value never overwrites Shopify (default)
//   "overwrite" - blank AccountMate values are written through
//
// NOTE: "Variant Price" is deliberately absent. Shopify's price is base price
// PLUS surcharge, so it is computed in one place (see SURCHARGE) rather than
// mapped directly from "Regular price" -- mapping both double-counts and makes
// every row look changed.
export const FIELD_MAP = [
  {
    source: { col: "Stock" },
    shopifyCol: "Variant Inventory Qty",
    compare: "integer",
    // Stock legitimately goes to 0; that is a real value, not a blank.
    blankPolicy: "overwrite",
    treatZeroAsBlank: false,
  },
  {
    source: { col: "Weight (lbs)" },
    shopifyCol: "Variant Grams",
    compare: "number",
    // Shopify stores unrounded grams (23 lb -> 10432.62451), so use the exact
    // conversion factor and a 1-gram tolerance. Rounding here made all 144
    // matched variants look changed.
    transform: (lbs) => {
      const n = parseFloat(lbs);
      return Number.isFinite(n) ? +(n * 453.59237).toFixed(5) : "";
    },
    tolerance: 1,
    // AccountMate frequently exports 0.00 weights that are simply missing data.
    treatZeroAsBlank: true,
  },
  {
    source: { attr: "Cost" },
    shopifyCol: "Cost per item",
    compare: "number",
    treatZeroAsBlank: true,
  },
  {
    source: { attr: "Hazardous" },
    shopifyCol: "Is Hazmat? (product.metafields.custom.is_hazmat)",
    compare: "string",
    scope: "product",
    transform: (v) => (String(v).trim().toLowerCase() === "yes" ? "TRUE" : "FALSE"),
    // Safety ratchet. Shopify flags 168/172 variants as hazmat; AccountMate
    // would downgrade 13 solvent-based coatings to FALSE. A wrong hazmat flag
    // is a shipping-compliance problem, so TRUE -> FALSE is reported for manual
    // review and never written. FALSE -> TRUE still flows through normally.
    // Delete this line to let AccountMate win in both directions.
    ratchet: { protect: "TRUE" },
  },
  {
    source: { attr: "Lead time" },
    shopifyCol: "Lead time (product.metafields.custom.lead_time)",
    compare: "string",
    scope: "product",
    // AccountMate says "15 business days"; Shopify's metafield holds "15".
    transform: (v) => {
      const m = String(v).match(/(\d+)/);
      return m ? m[1] : "";
    },
  },
  {
    source: { attr: "Vendor SKU" },
    // Variant-level MPN metafield created by the Google channel app. This is the
    // right home for Vendor SKU: AccountMate carries one per SKU, and unlike the
    // product-level custom.manufacturer_part_number metafield it can hold a
    // different value for each variant of a product.
    shopifyCol: "Google Shopping / MPN",
    compare: "string",
    scope: "variant",
    // AccountMate values carry stray internal whitespace
    // ("K32236WPX-T2  CAT 06480CMU"). Collapse it, but leave the content alone --
    // some values are legitimately compound ("... + CAT 06480CMU") or
    // multi-valued ("PG-6-G1, PG6G1") and trimming those is a content decision.
    transform: (v) => String(v).trim().replace(/\s+/g, " "),
  },
];

// The product-level custom.manufacturer_part_number metafield is deliberately
// NOT mapped. It holds a single value per product, so on multi-variant products
// the per-SKU Vendor SKUs conflict and nothing can be written safely. It is left
// untouched in Shopify; "Google Shopping / MPN" above carries the sync instead.

// Columns the sync is permitted to change on EXISTING products. Anything not
// listed here is Shopify's to own (titles, body copy, SEO, images, tags...).
// A mapped field that is not in this list is computed and reported but never written.
export const UPDATABLE_COLUMNS = [
  "Variant Price",
  "Variant Compare At Price",
  "Variant Inventory Qty",
  "Variant Grams",
  "Cost per item",
  "Google Shopping / MPN",
  "Is Hazmat? (product.metafields.custom.is_hazmat)",
  "Lead time (product.metafields.custom.lead_time)",
  // Set as a side effect of a surcharge being present:
  "Compare at indicates surcharge (product.metafields.custom.compare_at_indicates_surcharge)",
];

// When a surcharge amount is present, Shopify's "Variant Price" is the base
// price PLUS the surcharge, "Variant Compare At Price" holds the surcharge
// itself, and a metafield flags the convention. This is the ONLY place
// Variant Price is computed.
export const SURCHARGE = {
  amountAttr: "Surcharge amount",
  basePriceCol: "Regular price",
  priceCol: "Variant Price",
  compareAtCol: "Variant Compare At Price",
  indicatorCol:
    "Compare at indicates surcharge (product.metafields.custom.compare_at_indicates_surcharge)",
  // The indicator is a product-level metafield.
  indicatorScope: "product",

  // AccountMate leaves Surcharge percent/amount at 0.00 on newly-added items --
  // 56 of the 59 new SKUs in the 2026-08-27 export. The catalog convention is
  // otherwise uniform: "Surcharge percent" is 8.00 on every one of the 85 rows
  // where it is set, and Shopify carries the surcharge indicator on 168/172
  // variants. So NEW products fall back to this rate when AccountMate has none.
  //
  // Verified to reproduce existing values exactly: 569.00 x 8% = 45.52,
  // 244.36 x 8% = 19.55 -- matching the live compare-at prices.
  //
  // Set to null to disable the fallback and leave new products with no
  // surcharge. Existing products are NEVER affected by this: they always use the
  // surcharge AccountMate reports.
  defaultPercentForNewProducts: 8.0,
};

// Every column matching this pattern is a product-level metafield: Shopify
// populates it only on a product's first row. Used when carrying values
// forward across variant rows.
export const PRODUCT_METAFIELD_PATTERN = /\(product\.metafields\./;

// ---------------------------------------------------------------------------
// New-product grouping: SKU prefix -> existing Shopify product handle
// ---------------------------------------------------------------------------
// Mined from the 12 `consolidated`-tagged products in the live catalog.
// Longest prefix wins, so add more specific entries to override.
//
// NOTE: "HZK221" was mined as ambiguous (it matched both the 22169WEP and the
// K22167WEP products). The two explicit longer prefixes below disambiguate it.
export const PREFIX_TO_HANDLE = {
  "AXTS-1": "hentzen-axts-1-teflon-topcoat-bms-10-86",
  "AXSP-11": "hentzen-axsp-11g-conventional-urethane-surfacer-primer-bms-10-103",
  "AXPG-6": "hentzen-axpg-6-high-solids-polyurethane-topcoat-mil-prf-85285-type-i",
  HZK355: "hentzen-advanced-aerospace-polyurethane-topcoat-mil-prf-85285-type-i-iv",
  HZK356: "hentzen-advanced-aerospace-polyurethane-topcoat-mil-prf-85285-type-i-iv",
  HZK322: "hentzen-ground-support-polyurethane-topcoat-mil-prf-85285-type-ii",
  HZK311: "hentzen-aerospace-polyurethane-topcoat-mil-prf-85285-type-i",
  HZK313: "hentzen-aerospace-polyurethane-topcoat-mil-prf-85285-type-i",
  HZ313: "hentzen-aerospace-polyurethane-topcoat-mil-prf-85285-type-i",
  HZK315: "hentzen-aerospace-polyurethane-topcoat-mil-prf-85285-type-i",
  HZK316: "hentzen-aerospace-polyurethane-topcoat-mil-prf-85285-type-i",
  HZK22169: "hentzen-22169wep-epoxy-primer-mil-dtl-53022",
  HZK22167: "hentzen-k22167wep-mil-dtl-53022",
  HZK167: "hentzen-16708tep-chrome-free-epoxy-primer-mil-prf-23377",
  HZ172: "hentzen-17292ydf-yellow-epoxy-primer-mil-prf-22750",
  HZ170: "hentzen-17084gep-lvoc-chrome-free-low-ir-epoxy-primer-mil-prf-23377",
  HZ086: "hentzen-polyurethane-carc-topcoat-mil-dtl-53039",
};

// ---------------------------------------------------------------------------
// Size (Option2) resolution
// ---------------------------------------------------------------------------
// AccountMate's "Unit of Measure" attribute resolves 55/59 new SKUs, which beats
// parsing SKU suffixes (33/59). SKU-suffix tokens are the fallback.
export const UOM_TO_SIZE = {
  GALKIT: "Gallon",
  GAL: "Gallon",
  QRTKT: "Quart",
  QRT: "Quart",
  "1-GL KIT": "1 Gallon Kit",
  "2-GL KIT": "2 Gallon Kit",
  "4-GL KIT": "4 Gallon Kit",
  "5-GL KIT": "5 Gallon Kit",
  // Deliberately unmapped -- too ambiguous to guess. Falls through to SKU suffix:
  //   EA, KIT
};

// Fallback: trailing token on the SKU -> Size. Mined from existing variants.
export const SKU_SUFFIX_TO_SIZE = {
  G1: "Gallon",
  G2: "Gallon",
  _G: "Gallon",
  "GL/KT": "Gallon",
  Q2: "Quart",
  "QT/KT": "Quart",
  QT: "Quart",
  G4: "4 Gallon Kit",
  "2GLKT": "2 Gallon Kit",
  "GK-1": "1 Gallon Kit",
  "GK-2": "2 Gallon Kit",
  "K-1/4 GL": "1 1/4 Gallon Kit",
  "K-5GL": "5 Gallon Kit",
  "2-OZ/KIT": "2oz Kit",
  "2-OZ/KT": "2oz Kit",
  "4OZ/K": "4oz Kit",
  // NOTE: the live catalog maps 6OZ/K to BOTH "4oz Kit" and "6oz Touch-up Kit".
  // Picking the more literal reading; correct here if the catalog is wrong.
  "6OZ/K": "6oz Touch-up Kit",
};

// Order matters: longest / most specific first, since these are matched as
// trailing tokens against the normalized SKU.
export const SKU_SUFFIX_ORDER = [
  "K-1/4 GL",
  "2-OZ/KIT",
  "2-OZ/KT",
  "K-5GL",
  "2GLKT",
  "4OZ/K",
  "6OZ/K",
  "GL/KT",
  "QT/KT",
  "GK-1",
  "GK-2",
  "_G",
  "G1",
  "G2",
  "G4",
  "Q2",
  "QT",
];

// ---------------------------------------------------------------------------
// Colour extraction (Option1)
// ---------------------------------------------------------------------------
// Shopify's Option1 Value holds a specific colour code (17925, bac-707,
// pantone-281c) or a human-authored slug (clear-flat). AccountMate's "Color"
// attribute only carries broad names (WHITE, GRAY), so the code has to come out
// of the Short description. Measured: 78% coverage, 92% precision.
//
// Extraction NEVER writes straight into an import file -- results land in
// color-map.csv for human confirmation first.
export const COLOR_PATTERNS = [
  { name: "pantone", re: /PANTONE\s*#?\s*([0-9]+\s*[A-Z]?)\b/i, format: (m) => "pantone-" + m[1].replace(/\s+/g, "").toLowerCase() },
  { name: "bac", re: /\bBAC\s*#?\s*([0-9]{3,6})\b/i, format: (m) => "bac-" + m[1] },
  { name: "fedstd", re: /\bF(?:STD|SD|ED)\.?\s*(?:STD)?\.?\s*#?\s*([0-9]{5})\b/i, format: (m) => m[1] },
  { name: "bare5", re: /(?<![0-9-])([0-9]{5})(?![0-9-])/, format: (m) => m[1] },
];

// Confidence ranking by where the match was found. Only "colorSpecs" comes from
// the structured `Color specs:` block; the rest are looser.
export const COLOR_SCOPE_CONFIDENCE = {
  colorSpecs: "high",
  firstLine: "medium",
  fullText: "low",
};

export const COLOR_MAP_FILE = "color-map.csv";

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
export const NEEDS_COLOR_PLACEHOLDER = "NEEDS-COLOR";

// Tag marking a product as a consolidated (multi-variant) product.
export const CONSOLIDATED_TAG = "consolidated";

// Defaults applied to brand-new standalone products.
export const NEW_PRODUCT_DEFAULTS = {
  Status: "draft",
  Published: "false",
  "Variant Inventory Tracker": "shopify",
  "Variant Inventory Policy": "deny",
  "Variant Fulfillment Service": "manual",
  "Variant Requires Shipping": "true",
  "Variant Taxable": "true",
  "Variant Weight Unit": "lb",
  "Gift Card": "false",
  Vendor: "Hentzen",
};

// ===========================================================================
// Matrixify output profile
// ===========================================================================
// Shopify's native CSV import cannot set VARIANT metafields at all, which is
// where dimensions, lead time, MPN and hazmat now live. Matrixify can, and its
// `Command: MERGE` semantics mean only the columns present in a row are
// touched -- so rows no longer need complete product blocks.

export const MATRIXIFY = {
  // Identity columns, always emitted.
  handleCol: "Handle",
  skuCol: "Variant SKU",
  commandCol: "Command",
  variantCommandCol: "Variant Command",
  command: "MERGE",

  // Pricing follows the same base+surcharge convention as before.
  priceCol: "Variant Price",
  compareAtCol: "Variant Compare At Price",
  // The surcharge indicator stays PRODUCT-level; it is a property of the
  // pricing convention, not of an individual pack size.
  indicatorCol: "Metafield: custom.compare_at_indicates_surcharge [boolean]",
};

/**
 * AccountMate -> Matrixify column mapping.
 *
 * `dimension` transforms emit Shopify's dimension metafield JSON shape,
 * {"value":9.0,"unit":"INCHES"}, which is the format already live in the store.
 * The parallel `custom.*_in [number_decimal]` metafields are unpopulated
 * (0/14 rows) and are treated as abandoned.
 */
const dimension = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0
    ? JSON.stringify({ value: n, unit: "INCHES" })
    : "";
};

export const MATRIXIFY_FIELD_MAP = [
  {
    source: { col: "Stock" },
    col: "Variant Inventory Qty",
    compare: "integer",
    blankPolicy: "overwrite",
  },
  {
    // Matrixify takes weight in its native unit -- no gram conversion, which
    // also retires the fractional-gram comparison problem.
    source: { col: "Weight (lbs)" },
    col: "Variant Weight",
    compare: "number",
    tolerance: 0.01,
    treatZeroAsBlank: true,
    companions: { "Variant Weight Unit": "lb" },
  },
  { source: { attr: "Cost" }, col: "Variant Cost", compare: "number", treatZeroAsBlank: true },
  {
    source: { attr: "Vendor SKU" },
    // The Google channel's variant-level MPN metafield.
    //
    // NOT custom.manufacturer_part_number: that key is defined at PRODUCT scope
    // (92/172 rows) as well as variant (74/172), and writing the variant one
    // collided with the product-scoped definition -- the value landed on the
    // product instead. mm-google-shopping.mpn is variant-scoped only, so there
    // is no ambiguity. Both custom.* copies are left untouched.
    col: "Variant Metafield: mm-google-shopping.mpn [single_line_text_field]",
    compare: "string",
    transform: (v) => String(v).trim().replace(/\s+/g, " "),
  },
  {
    source: { attr: "Hazardous" },
    col: "Variant Metafield: custom.is_hazmat [boolean]",
    compare: "string",
    // Metafield type was changed to boolean, so emit true/false, not Yes/No.
    transform: (v) => (String(v).trim().toLowerCase() === "yes" ? "true" : "false"),
    ratchet: { protect: "true" },
    // The metafield type was changed to boolean, which left the new column empty
    // (0/172) while the old values still sit in the text metafield and the
    // product-level boolean. Without these fallbacks the ratchet has no "true"
    // to protect and would happily downgrade genuinely hazardous coatings.
    // Consulted ONLY to establish current state for the ratchet -- never written.
    currentFrom: [
      "Variant Metafield: custom.is_hazmat [single_line_text_field]",
      "Metafield: custom.is_hazmat [boolean]",
    ],
    // Maps whatever those columns hold onto the ratchet's vocabulary.
    normalizeCurrent: (v) => {
      const t = String(v).trim().toLowerCase();
      if (["yes", "true", "1"].includes(t)) return "true";
      if (["no", "false", "0"].includes(t)) return "false";
      return "";
    },
  },
  {
    source: { attr: "Lead time" },
    col: "Variant Metafield: custom.lead_time [number_integer]",
    compare: "integer",
    transform: (v) => {
      const m = String(v).match(/(\d+)/);
      return m ? m[1] : "";
    },
  },
  {
    source: { col: "Length (in)" },
    col: "Variant Metafield: custom.length [dimension]",
    compare: "dimension",
    transform: dimension,
    treatZeroAsBlank: true,
  },
  {
    source: { col: "Width (in)" },
    col: "Variant Metafield: custom.width [dimension]",
    compare: "dimension",
    transform: dimension,
    treatZeroAsBlank: true,
  },
  {
    source: { col: "Height (in)" },
    col: "Variant Metafield: custom.height [dimension]",
    compare: "dimension",
    transform: dimension,
    treatZeroAsBlank: true,
  },
  {
    // AccountMate's tiered price string, e.g. "1:93.00,13:78.00".
    source: { col: "Fixed Tiered Prices" },
    col: "Variant Metafield: custom.accountmate_tiered_prices [single_line_text_field]",
    compare: "string",
    transform: (v) => String(v).trim(),
  },
];

// Extra columns needed when CREATING a variant or product (not for updates).
export const MATRIXIFY_NEW_COLUMNS = [
  "Title",
  "Body HTML",
  "Vendor",
  "Type",
  "Status",
  "Published",
  "Option1 Name",
  "Option1 Value",
  "Option2 Name",
  "Option2 Value",
  "Variant Weight Unit",
  "Variant Taxable",
  "Variant Inventory Tracker",
  "Variant Inventory Policy",
  "Variant Fulfillment Service",
  "Variant Requires Shipping",
];
