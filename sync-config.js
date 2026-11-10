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
// When a surcharge amount is present, Shopify's "Variant Price" is the base
// price PLUS the surcharge
export const SURCHARGE = {
  amountField: "surchargeAmount",
  percentField: "surchargePercent",
  basePriceField: "price",
  priceCol: "Variant Price",
};

// Every column matching this pattern is a product-level metafield: Shopify
// populates it only on a product's first row. Used when carrying values
// ---------------------------------------------------------------------------
// Size (Option2) resolution
// ---------------------------------------------------------------------------
// AccountMate's "Unit of Measure" attribute resolves 55/59 new SKUs, which beats
// parsing SKU suffixes (33/59). SKU-suffix tokens are the fallback.
export const UOM_TO_SIZE = {
  // AccountMate Unit of Measure is the primary size source, mapped onto the
  // liquid_product_size enumeration. Derived from a UoM x SKU-suffix census of
  // all 141 SKUs, not from the older catalog curation.
  //
  // The distinction the enumeration draws is can vs kit:
  //   GAL / GGL.80        a plain gallon can            -> Gallon
  //   1-GL KIT / GALKIT   base + catalyst kit, ~1 gal   -> 1 Gallon Kit
  GAL: "Gallon",
  "GGL.80": "Gallon",
  "1-GL KIT": "1 Gallon Kit",
  GALKIT: "1 Gallon Kit",
  "2-QT KIT": "2 Quart Kit",
  "2-GL KIT": "2 Gallon Kit",
  "4-GL KIT": "4 Gallon Kit",
  QRTKT: "Quart",
  QRT: "Quart",
  "2-OZ KIT": "2oz Kit",
  RL: "Roll",
  LB: "Pound",

  // "4-GL KIT" is deliberately absent: there is no "4 Gallon Kit" in the
  // enumeration. 1 SKU (AXPG-6-B487 G4) hits this and is reported, not guessed.
  //
  // "EA" and "KIT" are too coarse to map; both are resolved from the SKU suffix.

  // Non-Hentzen manufacturers (2026-09-28 multi-vendor catalog). Fallbacks only --
  // the matching SKU-suffix override below resolves these SKUs first.
  "6-OZ KIT": "6oz Kit",
  PTKT: "Pint",
  // Matches the "Box (20 Count)" metaobject's actual display name, not just
  // the count -- the resolved value here is also the SIZE_METAOBJECT lookup
  // key, so the two must agree verbatim.
  "20-COUNT": "Box (20 Count)",
};

// SKU-suffix overrides, applied BEFORE the UoM map. Only tokens that
// unambiguously name a size belong here. G1/G2/G4/_G/GL/KT/GK-1/GK-2 are
// deliberately excluded -- the census shows each appearing under more than one
// UoM, so they carry no reliable size of their own.
export const SKU_SUFFIX_SIZE_OVERRIDE = {
  "K-1/4 GL": "1.25 Gallon Kit",
  "K-5GL": "5 Gallon Kit",
  "KIT-2GL": "2 Gallon Kit",
  "K-2GL": "2 Gallon Kit",
  "2GLKT": "2 Gallon Kit",
  "KIT-1GL": "1 Gallon Kit",
  "2-OZ/KIT": "2oz Kit",
  "2-OZ/KT": "2oz Kit",
  "4OZ/K": "4oz Kit",
  "6OZ/K": "6oz Kit",
  "QT/KT": "Quart",
  Q2: "Quart",
  QT: "Quart",

  // Non-Hentzen manufacturers (2026-09-28 multi-vendor catalog).
  "CAN 1-LB": "1 LB Can", // Penreco VV-P-236
  "1PT": "Pint", // Flamemaster CS-3204/CS-3213 pint kits (SKU form)
  " PINT": "Pint", // same, spelled out -- Vendor part number form
  "6OZ": "6oz Kit", // Flamemaster CS-3204/CS-3213 6oz kits
};

// Longest-first, so "K-1/4 GL" wins over "GL".
export const SKU_SUFFIX_OVERRIDE_ORDER = Object.keys(
  SKU_SUFFIX_SIZE_OVERRIDE,
).sort((a, b) => b.length - a.length);

// The complete Size vocabulary in use. Anything outside this set is a new
// option value and needs a deliberate decision, so the migration flags it.
export const SIZE_VOCABULARY = [
  // Authoritative list from the liquid_product_size metaobject enumeration.
  "Quart",
  "Gallon",
  "1 Gallon Kit",
  "1.25 Gallon Kit",
  "2 Gallon Kit",
  "5 Gallon Kit",
  "2oz Kit",
  "4oz Kit",
  "6oz Kit",

  // Non-Hentzen manufacturers (2026-09-28 multi-vendor catalog).
  "Roll",
  "Pint",
  "1 LB Can",
  "Box (20 Count)",
  "1 Inch",
  "1.5 Inch",
  "2 Inch",
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
  {
    name: "pantone",
    re: /PANTONE\s*#?\s*([0-9]+\s*[A-Z]?)\b/i,
    format: (m) => "pantone-" + m[1].replace(/\s+/g, "").toLowerCase(),
  },
  {
    name: "bac",
    re: /\bBAC\s*#?\s*([0-9]{3,6})\b/i,
    format: (m) => "bac-" + m[1],
  },
  {
    name: "fedstd",
    re: /\bF(?:STD|SD|ED)\.?\s*(?:STD)?\.?\s*#?\s*([0-9]{5})\b/i,
    format: (m) => m[1],
  },
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
  "Variant Image":
    "https://cdn.shopify.com/s/files/1/0750/8767/5550/files/hentzen-mil-gallon-1024.jpg?v=1771607608",
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

  // Price folds the surcharge straight in -- see SURCHARGE and computePricing()
  // in sync-matrixify.js.
  priceCol: "Variant Price",
};

/**
 * AccountMate -> Shopify field mapping.
 *
 * Organised by Shopify-facing OUTPUT, not by AccountMate source column --
 * several outputs (colour, the two specification lists) genuinely depend on
 * more than one AccountMate field, so keying by a single source field would
 * force an arbitrary attribution. One shape covers everything:
 *
 *   output             semantic name; resolved to an actual Matrixify column
 *                      by MATRIXIFY_COLUMNS below. Entries with no `fn`
 *                      write nothing -- they exist purely as a review
 *                      trigger (see requireManualReview).
 *   sources            AccountMate canonical field name(s) (AM.get() keys)
 *                      this output is built from.
 *   fn(amRow, AM, identityRow)
 *                      computes the value. `identityRow` is only used by
 *                      entries that need to echo an existing Shopify value
 *                      rather than clear it (Tags, Type).
 *   requireManualReview
 *                      false: AccountMate is 100% trusted -- written every
 *                      run, unconditionally, never diffed against anything.
 *                      true: the derivation involves judgment (a heuristic,
 *                      or a frozen/hand-corrected field) -- never
 *                      auto-written. A change in `sources`' raw text between
 *                      the previous and current AccountMate export flags the
 *                      SKU for review-updates.csv instead.
 *   newProductsOnly    set once at creation, excluded from ongoing sync
 *                      (same reasoning as today: AccountMate's vendor part
 *                      number is too unreliable to re-sync blind).
 *
 * `dimension` transforms emit Shopify's dimension metafield JSON shape,
 * {"value":9.0,"unit":"INCHES"}, which is the format already live in the store.
 */

const dimension = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0
    ? JSON.stringify({ value: n, unit: "INCHES" })
    : "";
};

const yesNoBool = (v) =>
  String(v).trim().toLowerCase() === "yes" ? "true" : "false";

const moneyUSD = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? `${n.toFixed(2)} USD` : "";
};

const trimCollapse = (v) => String(v).trim().replace(/\s+/g, " ");

export const SHOPIFY_FIELD_MAP = [
  // -- Trusted: written unconditionally, every run, never diffed ----------
  {
    output: "inventoryQty",
    sources: ["onHand"],
    fn: (amRow, AM) => AM.get(amRow, "onHand"),
    requireManualReview: false,
  },
  {
    output: "variantWeight",
    sources: ["weight"],
    fn: (amRow, AM) => AM.get(amRow, "weight"),
    requireManualReview: false,
  },
  {
    output: "variantWeightUnit",
    sources: ["weight"],
    fn: () => "lb",
    requireManualReview: false,
  },
  {
    output: "variantCost",
    sources: ["cost"],
    fn: (amRow, AM) => AM.get(amRow, "cost"),
    requireManualReview: false,
  },
  {
    output: "hazardous",
    sources: ["hazardous"],
    fn: (amRow, AM) => yesNoBool(AM.get(amRow, "hazardous")),
    requireManualReview: false,
  },
  {
    output: "leadTime",
    sources: ["leadTime"],
    fn: (amRow, AM) => {
      const m = String(AM.get(amRow, "leadTime")).match(/(\d+)/);
      return m ? m[1] : "";
    },
    requireManualReview: false,
  },
  {
    output: "length",
    sources: ["length"],
    fn: (amRow, AM) => dimension(AM.get(amRow, "length")),
    requireManualReview: false,
  },
  {
    output: "width",
    sources: ["width"],
    fn: (amRow, AM) => dimension(AM.get(amRow, "width")),
    requireManualReview: false,
  },
  {
    output: "height",
    sources: ["height"],
    fn: (amRow, AM) => dimension(AM.get(amRow, "height")),
    requireManualReview: false,
  },
  {
    output: "shipsFrozen",
    sources: ["needsDryIce"],
    fn: (amRow, AM) => yesNoBool(AM.get(amRow, "needsDryIce")),
    requireManualReview: false,
  },
  {
    output: "specialPackaging",
    sources: ["needsSpecialPkg"],
    fn: (amRow, AM) => yesNoBool(AM.get(amRow, "needsSpecialPkg")),
    requireManualReview: false,
  },
  {
    output: "accountmateDescription",
    sources: ["description"],
    fn: (amRow, AM) => AM.get(amRow, "description"),
    requireManualReview: false,
  },
  {
    output: "accountmateShortDescription",
    sources: ["shortDescription"],
    fn: (amRow, AM) => AM.get(amRow, "shortDescription"),
    requireManualReview: false,
  },
  {
    output: "accountmateCategory",
    sources: ["categories"],
    fn: (amRow, AM) => AM.get(amRow, "categories"),
    requireManualReview: false,
  },
  {
    // Product family / series, e.g. "PG-6".
    output: "series",
    sources: ["series"],
    fn: (amRow, AM) => AM.get(amRow, "series"),
    requireManualReview: false,
  },
  {
    output: "nsn",
    sources: ["nsn"],
    fn: (amRow, AM) => AM.get(amRow, "nsn"),
    requireManualReview: false,
  },
  {
    output: "accountmateTieredPrices",
    sources: ["tierPrice"],
    fn: (amRow, AM) =>
      String(AM.get(amRow, "tierPrice"))
        .replace(/^"+|"+$/g, "")
        .trim(),
    requireManualReview: false,
  },
  {
    output: "variantPrice",
    sources: ["price", "surchargeAmount", "surchargePercent"],
    fn: (amRow, AM, identityRow, computePricing) => computePricing(amRow).price,
    requireManualReview: false,
  },
  {
    output: "accountmatePrice",
    sources: ["price"],
    fn: (amRow, AM) => moneyUSD(AM.get(amRow, "price")),
    requireManualReview: false,
  },
  {
    output: "accountmateSurchargeAmount",
    sources: ["surchargeAmount"],
    fn: (amRow, AM) => moneyUSD(AM.get(amRow, "surchargeAmount")),
    requireManualReview: false,
  },
  {
    output: "accountmateSurchargePercent",
    sources: ["surchargePercent"],
    fn: (amRow, AM) => {
      const n = parseFloat(AM.get(amRow, "surchargePercent"));
      return Number.isFinite(n) ? String(n) : "";
    },
    requireManualReview: false,
  },
  {
    // Never hand-corrected (unlike the frozen mpnMetafield below) -- exists
    // only so a correction becomes visible.
    output: "accountmateVendorPartNumber",
    sources: ["vendorPartNumber"],
    fn: (amRow, AM) => trimCollapse(AM.get(amRow, "vendorPartNumber")),
    requireManualReview: false,
  },
  {
    output: "accountmateManufacturer",
    sources: ["manufacturer"],
    fn: (amRow, AM) => AM.get(amRow, "manufacturer"),
    requireManualReview: false,
  },
  {
    output: "accountmateColorSpecs",
    sources: ["colorSpecs"],
    fn: (amRow, AM) => AM.get(amRow, "colorSpecs"),
    requireManualReview: false,
  },
  {
    output: "accountmateQpl",
    sources: ["qpl"],
    fn: (amRow, AM) => AM.get(amRow, "qpl"),
    requireManualReview: false,
  },
  {
    output: "accountmateMeetsSpecs",
    sources: ["meetsSpecs"],
    fn: (amRow, AM) => AM.get(amRow, "meetsSpecs"),
    requireManualReview: false,
  },
  {
    output: "accountmateAviation",
    sources: ["aviation"],
    fn: (amRow, AM) => yesNoBool(AM.get(amRow, "aviation")),
    requireManualReview: false,
  },
  {
    output: "accountmateMarine",
    sources: ["marine"],
    fn: (amRow, AM) => yesNoBool(AM.get(amRow, "marine")),
    requireManualReview: false,
  },
  {
    output: "accountmateIndustrial",
    sources: ["industrial"],
    fn: (amRow, AM) => yesNoBool(AM.get(amRow, "industrial")),
    requireManualReview: false,
  },
  {
    // Deterministic from AccountMate's own category code, same trust level
    // as every other field here -- written blank, same as weight or a
    // dimension, when AccountMate's Categories value has no mapping (rare:
    // 6 of 274 current rows, and one of those -- "AXONPAINT" -- looks like
    // bad AccountMate data worth fixing at the source, not masking).
    output: "type",
    sources: ["categories"],
    fn: (
      amRow,
      AM,
      identityRow,
      _computePricing,
      typeFromAccountMateCategory,
    ) => typeFromAccountMateCategory(AM.get(amRow, "categories")) || "",
    requireManualReview: false,
  },
  {
    // The Google channel's variant-level MPN metafield. Set once at creation,
    // then owned by hand -- AccountMate's Vendor part number is too
    // unreliable to re-sync on an ongoing basis (it has carried values like
    // "PAINT" and "JDL-12"). Excluded from ongoing sync entirely: a blank
    // cell here would clear a hand-corrected MPN.
    output: "mpnMetafield",
    sources: ["vendorPartNumber"],
    fn: (amRow, AM) => trimCollapse(AM.get(amRow, "vendorPartNumber")),
    requireManualReview: false,
    newProductsOnly: true,
  },

  // -- Judgment calls: never auto-written, flagged for review -------------
  {
    output: "colour",
    sources: ["colorSpecs", "shortDescription"],
    fn: null, // caller re-runs extractColor(); color-map.csv is the existing
    // Drafted/Confirmed review surface for this one.
    requireManualReview: true,
  },
  {
    output: "approvedSpecifications",
    sources: ["qpl"],
    fn: null, // caller re-runs productSpecs(amRow).approved for the suggestion
    requireManualReview: true,
  },
  {
    output: "meetsSpecifications",
    sources: ["meetsSpecs"],
    fn: null, // caller re-runs productSpecs(amRow).meets for the suggestion
    requireManualReview: true,
  },
  {
    // The frozen mm-google-shopping.mpn (mpnMetafield above) may now be
    // stale -- flag only, nothing safe to auto-suggest.
    output: "mpnReview",
    sources: ["vendorPartNumber"],
    fn: null,
    requireManualReview: true,
  },
  {
    // Widest blast radius of any reviewed field: a manufacturer reassignment
    // affects Vendor, handle prefix, category classification and
    // part-number extraction all at once. No single safe auto-suggestion.
    output: "vendorHandlePrefixCategory",
    sources: ["manufacturer"],
    fn: null,
    requireManualReview: true,
  },
  {
    // Feeds buildHandle()'s descriptor and new-product Body HTML fallback.
    // Nothing re-derives an existing product's Title/handle today -- this is
    // informational only, surfacing that the inputs changed.
    output: "titleHandleInputs",
    sources: ["description", "shortDescription"],
    fn: null,
    requireManualReview: true,
  },
];

// Shopify Matrixify column header for each SHOPIFY_FIELD_MAP `output` that
// actually writes a value (every `requireManualReview: true` entry with no
// `fn` has no column -- it only ever appears in review-updates.csv). This is
// the ONLY place that knows Matrixify's column-naming convention; a future
// move to the Shopify Admin API only needs a new adapter here, not a new
// SHOPIFY_FIELD_MAP.
export const MATRIXIFY_COLUMNS = {
  inventoryQty: "Variant Inventory Qty",
  variantWeight: "Variant Weight",
  variantWeightUnit: "Variant Weight Unit",
  variantCost: "Variant Cost",
  hazardous: "Variant Metafield: custom.hazardous [boolean]",
  leadTime: "Variant Metafield: custom.lead_time [number_integer]",
  length: "Variant Metafield: custom.length [dimension]",
  width: "Variant Metafield: custom.width [dimension]",
  height: "Variant Metafield: custom.height [dimension]",
  shipsFrozen: "Variant Metafield: custom.ships_frozen [boolean]",
  specialPackaging: "Variant Metafield: custom.special_packaging [boolean]",
  accountmateDescription:
    "Variant Metafield: custom.accountmate_description [multi_line_text_field]",
  accountmateShortDescription:
    "Variant Metafield: custom.accountmate_short_description [multi_line_text_field]",
  accountmateCategory:
    "Variant Metafield: custom.accountmate_category [single_line_text_field]",
  series: "Metafield: custom.series [single_line_text_field]",
  nsn: "Metafield: custom.nsn [single_line_text_field]",
  accountmateTieredPrices:
    "Variant Metafield: custom.accountmate_tiered_prices [single_line_text_field]",
  variantPrice: "Variant Price",
  accountmatePrice: "Variant Metafield: custom.accountmate_price [money]",
  accountmateSurchargeAmount:
    "Variant Metafield: custom.accountmate_surcharge_amount [money]",
  accountmateSurchargePercent:
    "Variant Metafield: custom.accountmate_surcharge_percent [number_decimal]",
  accountmateVendorPartNumber:
    "Variant Metafield: custom.accountmate_vendor_part_number [single_line_text_field]",
  accountmateManufacturer:
    "Metafield: custom.accountmate_manufacturer [single_line_text_field]",
  accountmateColorSpecs:
    "Metafield: custom.accountmate_color_specs [single_line_text_field]",
  accountmateQpl: "Metafield: custom.accountmate_qpl [single_line_text_field]",
  accountmateMeetsSpecs:
    "Metafield: custom.accountmate_meets_specs [single_line_text_field]",
  accountmateAviation: "Metafield: custom.accountmate_aviation [boolean]",
  accountmateMarine: "Metafield: custom.accountmate_marine [boolean]",
  accountmateIndustrial: "Metafield: custom.accountmate_industrial [boolean]",
  type: "Type",
  mpnMetafield:
    "Variant Metafield: mm-google-shopping.mpn [single_line_text_field]",
};

// Extra columns needed when CREATING a variant or product (not for updates).
export const MATRIXIFY_NEW_COLUMNS = [
  "Option1 Name",
  "Option1 Value",
  "Title",
  "Body HTML",
  "Vendor",
  "Type",
  "Status",
  "Published",
  "Variant Weight Unit",
  "Variant Taxable",
  "Variant Inventory Tracker",
  "Variant Inventory Policy",
  "Variant Fulfillment Service",
  "Variant Requires Shipping",
];

// ===========================================================================
// One-time migration (migrate-catalog.js)
// ===========================================================================
export const MIGRATION = {
  // Products the migration must not touch.
  excludeHandles: ["test"],

  colourPatternCol:
    "Metafield: shopify.color-pattern [list.metaobject_reference]",
  saeColourCol: "Metafield: custom.sae_color [single_line_text_field]",
  colourNamespace: "shopify--color-pattern",

  // Consolidated products store colour as a display name ("17875 (White Gloss)").
  // The leading code slugifies to the metaobject handle for 36 of 39 values;
  // these three have no leading code and are named explicitly. All three handles
  // already exist in the catalog.
  colourHandleOverrides: {
    "Clear Flat": "clear-flat",
    "Clear Semi-Gloss": "clear-semigloss",
    "Dark Green (Colombia Police)": "dark-green-colombia-police",
  },
};

// ---------------------------------------------------------------------------
// Size -> size metaobject handle
// ---------------------------------------------------------------------------
// `custom.size [list.metaobject_reference]` is the product-level category
// metafield the Size variant option is linked to. It holds the product's
// DISTINCT sizes (the `test` product has 12 variants but only 4 sizes -> 4
// handles), comma-space separated.
//
// Only the first four handles are confirmed against the export. The rest follow
// the observed slug convention (lowercase, non-alphanumeric -> dash, a dash
// inserted between a leading digit and "oz") but have NOT been seen in the
// store. Using one that does not exist creates a dangling reference, so the
// migration refuses to emit them and reports instead.
export const SIZE_METAOBJECT = {
  // Authoritative handles supplied from the Shopify metaobject list. All
  // confirmed -- no guessed slugs remain.
  Quart: "liquid_product_size.quart",
  Gallon: "liquid_product_size.gallon",
  "1 Gallon Kit": "liquid_product_size.1-gallon-kit",
  "1.25 Gallon Kit": "liquid_product_size.1-25-gallon-kit",
  "2 Gallon Kit": "liquid_product_size.2-gallon-kit",
  "5 Gallon Kit": "liquid_product_size.5-gallon-kit",
  "2oz Kit": "liquid_product_size.2-oz-kit",
  "4oz Kit": "liquid_product_size.4-oz-kit",
  "6oz Kit": "liquid_product_size.6-oz-kit",

  // Non-Hentzen manufacturers (2026-09-28 multi-vendor catalog). All
  // confirmed live, 2026-10-01.
  Roll: "liquid_product_size.roll",
  Pint: "liquid_product_size.pint",
  "Box (20 Count)": "liquid_product_size.20-count",
  "1 Inch": "liquid_product_size.1-inch",
  "1.5 Inch": "liquid_product_size.1-5-inch",
  "2 Inch": "liquid_product_size.2-inch",
  // "Pound" exists in Shopify but nothing resolves to a "Pound" size value --
  // the live Penreco product uses "1 LB Can" instead, whose metaobject
  // doesn't exist yet. Until it's added, Penreco's custom.size is left unset
  // rather than emit a dangling reference (Option1 Value still resolves, so
  // it is not blocked).
};

// Display values in the catalog that are NOT in the enumeration and must be
// renamed to match it. Applied wherever a size is resolved.
export const SIZE_RENAMES = {
  "1 1/4 Gallon Kit": "1.25 Gallon Kit",
  "6oz Touch-up Kit": "6oz Kit",
};

export const SIZE_METAFIELD_COL =
  "Metafield: custom.size [list.metaobject_reference]";

// ---------------------------------------------------------------------------
// New-product handles
// ---------------------------------------------------------------------------
// Scheme: hentzen-{mpn}-{spec}, matching the dominant existing pattern
// (hentzen-31104kpx-t1-mil-prf-85285f-type-i). Applied to NEW products only --
// existing handles are never renamed, because that would drop their SEO ranking.
export const NEW_PRODUCT_HANDLE = {
  prefix: "hentzen",

  // The AX prefix means two different things:
  //   AX + DIGIT  ("AX10", "AX17", "AX1440-SW")  a real Hentzen product name,
  //                                               normalised to "AX-10" etc.
  //   AX + LETTER ("AXEP-3", "AXPG-6", "AXTS-1")  a client data-entry error,
  //                                               stripped.
  normalizeMpn(v) {
    let raw = String(v || "")
      .replace(/\s*\+.*$/, "")
      .trim();

    // "HZ" / "HZK" is the client's internal SKU prefix, never part of the
    // manufacturer part number. Existing titles read "Hentzen 22167WEP", not
    // "Hentzen HZK22167WEP".
    raw = raw.replace(/^HZK?/i, "");

    // A trailing bare G or Q directly after a digit is a size marker glued to
    // the code ("WF-3-BK1G" = BK1 + Gallon, "TS-1-G1Q" = G1 + Quart). A colour
    // code like "PG-6-G1" ends in letter+digit and is left alone.
    raw = raw.replace(/(\d)[GQ]$/i, "$1");

    if (/^AX\d/i.test(raw)) return raw.replace(/^AX-?/i, "AX-");
    return raw.replace(/^AX/i, "");
  },

  // Only well-formed specs are used. Matching loosely against the short
  // description produced garbage like "BMS 1011VTY"; when nothing matches the
  // handle is just hentzen-{mpn}, which is still a valid, searchable URL.
  specPattern:
    /\b(MIL-(?:PRF|DTL|C|P|A)-\d{4,5}[A-Z]?|BMS\s*10-\d{2}|AMS\s*\d{4}|BAMS\s*\d{3}-\d{3}|DOD-P-\d{4,5}|DMS\s*\d{4})/i,

  specFrom(amRow) {
    const txt = String(amRow["Short description"] || "").replace(/\\n/g, " ");
    const m = txt.match(this.specPattern);
    // Normalise spacing before slugging: the source writes both "BMS 10-83" and
    // "BMS10-83".
    return m
      ? m[1].replace(/^([A-Z]+)(\d)/i, "$1 $2").replace(/\s+/g, "-")
      : "";
  },
};

// Spec suffix for NON-Hentzen handles. Deliberately separate from
// NEW_PRODUCT_HANDLE.specPattern/specFrom above, which are tuned to Hentzen's
// Short description text and already protect 133 live handles -- left
// untouched rather than risk a regression there.
//
// Adds MIL-S- and AMS-S- (common on Flamemaster/Henkel sealants and
// adhesives, absent from Hentzen's own spec vocabulary) to the same
// well-formed-only philosophy: loose matching produces garbage, so an
// unmatched spec just means no spec suffix, not a guess.
//
// Scans QPL first, then Short description -- QPL is where a real
// qualification claim lives for these manufacturers (see Flamemaster's
// "AMS-S-8802, TYPE II, REV E"), Short description is the fallback.
// Returns the match VERBATIM: this deliberately does NOT translate between
// AMS and MIL designations for the same underlying spec family (e.g.
// AMS-S-8802 vs. the older MIL-S-8802) -- that is a domain judgment call
// this script has no business making on a military-spec-sensitive catalog.
const GENERIC_SPEC_PATTERN =
  /\b(MIL-(?:PRF|DTL|C|P|A|S)-\d{3,5}[A-Z]?|AMS-S-\d{3,5}|MMM-A-\d{2,4}|BMS\s*10-\d{2}|AMS\s*\d{4}|BAMS\s*\d{3}-\d{3}|DOD-P-\d{4,5}|DMS\s*\d{4})/i;

export function genericSpecFrom(qplText, shortDescriptionText) {
  const txt = `${qplText || ""} ${shortDescriptionText || ""}`.replace(
    /\\n/g,
    " ",
  );
  const m = txt.match(GENERIC_SPEC_PATTERN);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

// ---------------------------------------------------------------------------
// Product category
// ---------------------------------------------------------------------------
// Shopify's category metafields (custom.size among them) are constrained to the
// product's category. A product created without one rejects the metafield with
// "Owner subtype does not match the metafield definition's constraints", so the
// category MUST be set on every new product.
export const PRODUCT_CATEGORY = {
  primer: {
    "Category: ID": "ha-1-6-3",
    "Category: Name": "Primers",
    Category:
      "Hardware > Building Consumables > Painting Consumables > Primers",
  },
  topcoat: {
    "Category: ID": "ha-1-6-1",
    "Category: Name": "Paint",
    Category: "Hardware > Building Consumables > Painting Consumables > Paint",
  },
  carc: {
    "Category: ID": "ha-1-8-2",
    "Category: Name": "Protective Coatings",
    Category:
      "Hardware > Building Consumables > Protective Coatings & Sealants > Protective Coatings",
  },

  // Non-Hentzen manufacturers (2026-09-28 multi-vendor catalog). Verified
  // against Shopify's live Standard Product Taxonomy on 2026-09-28.
  adhesive: {
    "Category: ID": "ha-1-2",
    "Category: Name": "Hardware Glue & Adhesives",
    Category: "Hardware > Building Consumables > Hardware Glue & Adhesives",
  },
  tape: {
    "Category: ID": "ha-1-3",
    "Category: Name": "Hardware Tape",
    Category: "Hardware > Building Consumables > Hardware Tape",
  },
  tapeMasking: {
    "Category: ID": "ha-1-3-3",
    "Category: Name": "Masking Tape",
    Category: "Hardware > Building Consumables > Hardware Tape > Masking Tape",
  },
  // No aerospace-sealant leaf exists in Shopify's taxonomy (the Protective
  // Coatings & Sealants leaves are all construction-grade: roofing, concrete,
  // waterproofing), so this deliberately sits one level up at the parent.
  sealant: {
    "Category: ID": "ha-1-8",
    "Category: Name": "Protective Coatings & Sealants",
    Category:
      "Hardware > Building Consumables > Protective Coatings & Sealants",
  },
  grease: {
    "Category: ID": "ha-1-4-2",
    "Category: Name": "Grease",
    Category: "Hardware > Building Consumables > Lubricants > Grease",
  },
  abrasive: {
    "Category: ID": "ha-14-19-1-6",
    "Category: Name": "Sanding Pads",
    Category:
      "Hardware > Tool Accessories > Sanding Accessories > Sandpaper & Sanding Sponges > Sanding Pads",
  },
};

export const CATEGORY_COLUMNS = ["Category: ID", "Category: Name", "Category"];

/**
 * Classify a product from its description and spec. CARC is checked first
 * because a CARC coating is also a topcoat; primer next; everything else is
 * Paint -- including accelerators, reducers and non-skid walkway coatings,
 * which have no better home in the three categories in use.
 */
export function classifyCategory(description, spec) {
  const t = `${description || ""} ${spec || ""}`.toLowerCase();
  if (/\bcarc\b|53039/.test(t)) return "carc";
  if (/primer/.test(t)) return "primer";
  return "topcoat";
}
// AccountMate spec strings -> metaobject handle.
//
// Deliberately CONSERVATIVE. A mil-spec reference on an aerospace coating is a
// compliance claim, so a string is mapped only where the spec, type and class
// are all unambiguous. Anything else is reported for a human decision rather
// than guessed -- see UNMAPPABLE below for the cases this currently refuses.
export const MIL_SPEC_PATTERNS = [
  [
    /MIL-PRF-85285.*\bTY(?:PE)?\s*(?:I\b|1\b)(?!I|V).*CL(?:ASS)?\s*H/i,
    "mil-prf-85285-type-i-class-h",
  ],
  [
    /MIL-PRF-85285.*\bTY(?:PE)?\s*(?:II|2)\b(?!I).*CL(?:ASS)?\s*H/i,
    "mil-prf-85285-type-ii-class-h",
  ],
  [/MIL-PRF-85285.*\bTY(?:PE)?\s*(?:IV|4)\b/i, "mil-prf-85285-type-iv-class-h"],
  [/MIL-PRF-85285,?\s*TYPE\s*I,\s*CLASS\s*H/i, "mil-prf-85285-type-i-class-h"],
  [
    /MIL-DTL-53022.*\bTY(?:PE)?\s*IV.*\bCL(?:S|ASS)?\s*U/i,
    "mil-dtl-53022-type-iv-class-u",
  ],
  [
    /MIL-DTL-53022.*\bTY(?:PE)?\s*IV.*\bCL(?:S|ASS)?\s*L/i,
    "mil-dtl-53022-type-iv-class-l",
  ],
  [/MIL-DTL-53030.*\bTY(?:PE)?\s*II\b/i, "mil-dtl-53030-type-ii"],
  [/MIL-DTL-53039.*\bTY(?:PE)?\s*IX\b/i, "mil-dtl-53039-type-ix"],
  [/MIL-DTL-53039.*\bTY(?:PE)?\s*IV\b/i, "mil-dtl-53039-type-iv"],
  [/MIL-C-8514\b/i, "mil-c-8514"],
  [/MIL-PRF-81352.*\bTY(?:PE)?\s*I\b(?!I|V)/i, "mil-prf-81352-type-i"],
  [
    /MIL-PRF-23377.*\bTY(?:PE)?\s*II\b(?!I).*\bCL(?:ASS)?\s*C2/i,
    "mil-prf-23377-type-ii-class-c2",
  ],
  [
    /MIL-PRF-23377.*\bTY(?:PE)?\s*I\b(?!I|V).*\bCL(?:ASS)?\s*C2/i,
    "mil-prf-23377-type-i-class-c2",
  ],
  [
    /MIL-PRF-23377.*\bTY(?:PE)?\s*I\b(?!I|V).*\bCL(?:ASS)?\s*C1/i,
    "mil-prf-23377-type-i-class-c1",
  ],
  [
    /MIL-PRF-23377.*\bTY(?:PE)?\s*II\b(?!I).*\bCL(?:ASS)?\s*N/i,
    "mil-prf-23377-type-ii-class-n",
  ],
  [
    /MIL-PRF-85582.*\bTY(?:PE)?\s*II\b(?!I).*\bCL(?:ASS)?\s*C-?2/i,
    "mil-prf-85582-type-ii-class-c2",
  ],
  [
    /MIL-PRF-85582.*\bTY(?:PE)?\s*I\b(?!I|V).*\bCL(?:ASS)?\s*C-?2/i,
    "mil-prf-85582-type-i-class-c2",
  ],
  [
    /MIL-PRF-22750.*\bTY(?:PE)?\s*II\b(?!I).*\bCL(?:ASS)?\s*H/i,
    "mil-prf-22750-type-ii-class-h-grade-a",
  ],
];

// Strings that name a MIL spec but cannot be resolved to one of the 17 handles.
// Listed explicitly so they are reported rather than silently dropped:
//   MIL-C-85285          superseded designation, no type/class given
//   MIL-C-83286          no metaobject exists
//   MIL-PRF-22750        no type/class given; "TYPE I" has no metaobject
export const MIL_SPEC_UNMAPPABLE = [
  /MIL-C-85285/i,
  /MIL-C-83286/i,
  /MIL-PRF-22750(?!.*TY)/i,
];

export const PARENT_COLLECTION = {
  primer: "aviation-primers",
  topcoat: "aviation-topcoats",
  carc: "chemical-agent-resistive-coatings-carc",
};

// Shopify "Type", per category. Title-case, matching the 3 values in use.
export const PRODUCT_TYPE = {
  primer: "Primer",
  topcoat: "Topcoat",
  carc: "CARC",
  adhesive: "Adhesive",
  tape: "Tape",
  tapeMasking: "Masking Tape",
  sealant: "Sealant",
  grease: "Grease",
  abrasive: "Abrasive Pad",
};

// ---------------------------------------------------------------------------
// AccountMate "Categories" -> Shopify Type
// ---------------------------------------------------------------------------
// AccountMate's own "Categories" column ("ADHESIVES > PASTE", "PAINTS >
// MIL-TOPCOAT", ...) is a more specific, manufacturer-agnostic Type source
// than classify()/classifyCategory() above, which only guess from free-text
// description keywords. Used for NEW products only, same as PRODUCT_TYPE --
// existing products' Type is left alone (carried through PRODUCT_LEVEL_CARRY)
// rather than silently overwritten on every sync.
//
// Case-insensitive; "SEALANT > SEAL-POLY" (singular, as AccountMate actually
// emits it) is tolerated alongside the plural "SEALANTS > SEAL-POLY" below.
// A Categories value with no entry here (e.g. "PAINTS > COM-TOUCH UP KITS",
// which AccountMate is expected to stop emitting) falls back to
// PRODUCT_TYPE[kind] via typeFromAccountMateCategory() returning null.
const ACCOUNTMATE_CATEGORY_TO_TYPE = {
  "ABRASIVES > PADS": "Abrasive Pad",
  "ADHESIVES > PASTE": "Adhesive Paste",
  CHEMICALS: "Other Chemical",
  LUBRICANTS: "Lubricant",
  "SEALANTS > SEAL-POLY": "Sealant",
  "SEALANTS > FUEL TANK": "Sealant",
  "TAPES > ACRYLIC": "Acrylic Tape",
  "TAPES > ALUMINUM": "Aluminum Tape",
  "TAPES > MASKING": "Masking Tape",
  "TAPES > POLYESTER": "Polyester Tape",
  "TAPES > VINYL": "Vinyl Tape",
  "PAINTS > EXTERIOR": "Exterior Paint",
  "PAINTS > INTERIOR": "Interior Paint",
  "PAINTS > PRIMER": "Primer",
  "PAINTS > REFLECTIVE": "Reflective Paint",
  "PAINTS > THINNER": "Thinner",
  "PAINTS > MIL-CARC": "CARC",
  "PAINTS > MIL-PRIMERS": "Military Primer",
  "PAINTS > MIL-TOPCOAT": "Military Topcoat",
};

export function typeFromAccountMateCategory(raw) {
  const v = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/^SEALANT\b/, "SEALANTS");
  return ACCOUNTMATE_CATEGORY_TO_TYPE[v] || null;
}

// ---------------------------------------------------------------------------
// Non-Hentzen manufacturers
// ---------------------------------------------------------------------------
// The catalog's first multi-vendor import (2026-09-28): AccountMate's
// "Manufacturer" field now carries 3M, Flamemaster, Henkel and Penreco
// alongside Hentzen. Each needs its own Vendor display name, its own handle
// prefix (the old buildHandle() hardcoded "hentzen" for every new product --
// wrong once other brands showed up), and its own category, since none of
// them are coatings and classifyCategory() only knows primer/topcoat/carc.
//
// Keyed by the raw AccountMate "Manufacturer" value, upper-cased. A
// manufacturer with no entry here falls back to a slugified version of its
// own name for both vendor and handle prefix, and to classifyCategory() (the
// Hentzen coatings classifier) for category -- which is very likely wrong for
// a genuinely new manufacturer, so treat that fallback as a signal to add a
// real entry here, not as a feature.
export const MANUFACTURERS = {
  HENTZEN: {
    vendor: "Hentzen",
    handlePrefix: "hentzen",
  },
  "3M": {
    vendor: "3M",
    handlePrefix: "3m",
    // Scotch-Brite hand pads and foil/glass-cloth tape aren't masking tape;
    // only flag the ones that actually say so.
    classify(description) {
      const t = (description || "").toLowerCase();
      if (/scotch-?brite|hand pad/.test(t)) return "abrasive";
      if (/masking tape/.test(t)) return "tapeMasking";
      return "tape";
    },
    // 3M SKUs encode width as a trailing "-N" or "-N M/M" mixed fraction with
    // no space ("232-11/2" = 1 1/2 in). Confirmed live in Shopify: "3M 232" is
    // one product with 1/1.5/2 Inch variants, not three separate products or
    // Hentzen-style Quart/Gallon pack sizes.
    widthInches(sku) {
      const m = String(sku || "")
        .trim()
        .match(/-(\d+)(?:(\d)\/(\d))?\s*$/);
      if (!m) return null;
      const n = Number(m[1]) + (m[2] && m[3] ? Number(m[2]) / Number(m[3]) : 0);
      return Number.isFinite(n) ? n : null;
    },
    groupKey(sku) {
      const n = this.widthInches(sku);
      if (n == null) return null;
      return String(sku || "")
        .trim()
        .toUpperCase()
        .replace(/-(\d+)(?:(\d)\/(\d))?\s*$/, "");
    },
    resolveSize(sku) {
      const n = this.widthInches(sku);
      return n == null
        ? null
        : { value: `${n} Inch`, source: "SKU suffix (3M width)" };
    },
  },
  FLAMEMASTER: {
    vendor: "Flamemaster",
    handlePrefix: "flamemaster",
    classify: () => "sealant",
  },
  // AccountMate has reported this manufacturer as both "HENKEL" and
  // "HENKEL-AER" across exports -- both map to the same brand.
  HENKEL: {
    vendor: "Henkel",
    handlePrefix: "henkel-loctite",
    classify: () => "adhesive",
    // AccountMate's SKU ("HS-EA934") drops the real Loctite part number's
    // suffix ("EA 934NA"). The description always carries the true one.
    partNumberFrom(description) {
      const m = String(description || "").match(/\bEA\s*(\d+[A-Z]*)\b/i);
      return m ? `EA ${m[1]}` : "";
    },
  },
  PENRECO: {
    vendor: "Penreco",
    handlePrefix: "penreco",
    classify: () => "grease",
  },
};
MANUFACTURERS["HENKEL-AER"] = MANUFACTURERS.HENKEL;

/** Manufacturer config for a raw AccountMate "Manufacturer" value, or null. */
export function manufacturerInfo(raw) {
  return (
    MANUFACTURERS[
      String(raw || "")
        .trim()
        .toUpperCase()
    ] || null
  );
}

/**
 * Manufacturer config for an existing Shopify "Vendor" display value (e.g.
 * from a baseline Matrixify row, which has no AccountMate manufacturer code
 * of its own). Used so already-live products group/size the same way a
 * freshly-read AccountMate row for the same manufacturer would.
 */
export function manufacturerInfoByVendor(vendor) {
  const v = String(vendor || "")
    .trim()
    .toLowerCase();
  if (!v) return null;
  for (const info of Object.values(MANUFACTURERS)) {
    if (info.vendor.toLowerCase() === v) return info;
  }
  return null;
}

/**
 * Tag form of a mil-spec handle: the base spec without type/class, which is how
 * the catalog tags them ("mil-prf-85285", not the full handle).
 */
export const milSpecTag = (handle) =>
  String(handle)
    .replace(/^military_specification\./, "")
    .replace(/-type-.*$/, "");
