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
// price PLUS the surcharge, "Variant Compare At Price" holds the surcharge
// itself, and a metafield flags the convention. This is the ONLY place
// Variant Price is computed.
export const SURCHARGE = {
  amountField: "surchargeAmount",
  percentField: "surchargePercent",
  basePriceField: "price",
  priceCol: "Variant Price",
  compareAtCol: "Variant Compare At Price",
  indicatorCol:
    "Compare at indicates surcharge (product.metafields.custom.compare_at_indicates_surcharge)",
  // The indicator is a product-level metafield.
  indicatorScope: "product",

  // Disabled (2026-10-12): AccountMate's surcharge amount/percent drive price
  // and compare-at directly, full stop -- zero means zero, for new products
  // same as existing ones. This used to default new products with no
  // surcharge reported to the catalog's 8% convention (see git history), but
  // that silently added a surcharge AccountMate never asked for. Set to a
  // number to re-enable that fallback.
  defaultPercentForNewProducts: null,
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
  "1PT": "Pint", // Flamemaster CS-3204/CS-3213 pint kits
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
    source: { field: "onHand" },
    col: "Variant Inventory Qty",
    compare: "integer",
    blankPolicy: "overwrite",
  },
  {
    // Matrixify takes weight in its native unit -- no gram conversion, which
    // also retires the fractional-gram comparison problem.
    source: { field: "weight" },
    col: "Variant Weight",
    compare: "number",
    tolerance: 0.01,
    treatZeroAsBlank: true,
    companions: { "Variant Weight Unit": "lb" },
  },
  {
    source: { field: "cost" },
    col: "Variant Cost",
    compare: "number",
    treatZeroAsBlank: true,
  },
  {
    source: { field: "vendorPartNumber" },
    // The Google channel's variant-level MPN metafield.
    //
    // NOT custom.manufacturer_part_number: that key is defined at PRODUCT scope
    // (92/172 rows) as well as variant (74/172), and writing the variant one
    // collided with the product-scoped definition -- the value landed on the
    // product instead. mm-google-shopping.mpn is variant-scoped only, so there
    // is no ambiguity. Both custom.* copies are left untouched.
    col: "Variant Metafield: mm-google-shopping.mpn [single_line_text_field]",
    compare: "string",
    // Set once when the product is created, then owned by hand. AccountMate's
    // Vendor SKU is too unreliable to sync on an ongoing basis -- it carries
    // values like "PAINT" and "JDL-12", and lists AXTF-1-BR1 as AXTS-1-BR1.
    // Excluded from updated-products entirely: leaving the column in that file
    // with a blank value would CLEAR a hand-corrected MPN.
    newProductsOnly: true,
    transform: (v) => String(v).trim().replace(/\s+/g, " "),
  },
  {
    source: { field: "hazardous" },
    // Renamed from custom.is_hazmat. The old field still exists and holds the
    // live values, so it is listed in currentFrom below to keep the safety
    // ratchet working while the two coexist. It is never written.
    col: "Variant Metafield: custom.hazardous [boolean]",
    compare: "string",
    // Metafield type was changed to boolean, so emit true/false, not Yes/No.
    transform: (v) =>
      String(v).trim().toLowerCase() === "yes" ? "true" : "false",
    ratchet: { protect: "true" },
    // The metafield type was changed to boolean, which left the new column empty
    // (0/172) while the old values still sit in the text metafield and the
    // product-level boolean. Without these fallbacks the ratchet has no "true"
    // to protect and would happily downgrade genuinely hazardous coatings.
    // Consulted ONLY to establish current state for the ratchet -- never written.
    currentFrom: [
      "Variant Metafield: custom.is_hazmat [boolean]",
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
    source: { field: "leadTime" },
    col: "Variant Metafield: custom.lead_time [number_integer]",
    compare: "integer",
    transform: (v) => {
      const m = String(v).match(/(\d+)/);
      return m ? m[1] : "";
    },
  },
  {
    source: { field: "length" },
    col: "Variant Metafield: custom.length [dimension]",
    compare: "dimension",
    transform: dimension,
    treatZeroAsBlank: true,
  },
  {
    source: { field: "width" },
    col: "Variant Metafield: custom.width [dimension]",
    compare: "dimension",
    transform: dimension,
    treatZeroAsBlank: true,
  },
  {
    source: { field: "height" },
    col: "Variant Metafield: custom.height [dimension]",
    compare: "dimension",
    transform: dimension,
    treatZeroAsBlank: true,
  },
  {
    // Legacy hazmat field, written IN PARALLEL with custom.hazardous until the
    // theme is updated to read the new one. The two always carry the same value.
    source: { field: "hazardous" },
    col: "Variant Metafield: custom.is_hazmat [boolean]",
    compare: "string",
    transform: (v) =>
      String(v).trim().toLowerCase() === "yes" ? "true" : "false",
    ratchet: { protect: "true" },
    currentFrom: [
      "Variant Metafield: custom.hazardous [boolean]",
      "Metafield: custom.is_hazmat [boolean]",
    ],
    normalizeCurrent: (v) => {
      const t = String(v).trim().toLowerCase();
      if (["yes", "true", "1"].includes(t)) return "true";
      if (["no", "false", "0"].includes(t)) return "false";
      return "";
    },
  },
  {
    source: { field: "needsDryIce" },
    col: "Variant Metafield: custom.ships_frozen [boolean]",
    compare: "string",
    transform: (v) =>
      String(v).trim().toLowerCase() === "yes" ? "true" : "false",
  },
  {
    source: { field: "needsSpecialPkg" },
    col: "Variant Metafield: custom.special_packaging [boolean]",
    compare: "string",
    transform: (v) =>
      String(v).trim().toLowerCase() === "yes" ? "true" : "false",
  },
  {
    // AccountMate's own copy, mirrored VERBATIM -- no decoding, no reflowing.
    // Blanks ARE written through, clearing the metafield: the field mirrors
    // AccountMate exactly. The named format populates these on only 33 of 140
    // rows, so most products will have them cleared.
    source: { field: "description" },
    col: "Variant Metafield: custom.accountmate_description [multi_line_text_field]",
    compare: "string",
    blankPolicy: "overwrite",
  },
  {
    source: { field: "shortDescription" },
    col: "Variant Metafield: custom.accountmate_short_description [multi_line_text_field]",
    compare: "string",
    blankPolicy: "overwrite",
  },
  {
    // AccountMate's own category code ("PAINTS > MIL-TOPCOAT", "ADHESIVES >
    // PASTE"), mirrored VERBATIM -- no normalising, no mapping. This is the
    // same raw source typeFromAccountMateCategory() (below) reads to drive
    // the Type field; this metafield is just a pass-through copy of it, same
    // treatment as accountmate_description/accountmate_short_description.
    source: { field: "categories" },
    col: "Variant Metafield: custom.accountmate_category [single_line_text_field]",
    compare: "string",
    blankPolicy: "overwrite",
  },
  {
    // Product family / series, e.g. "PG-6".
    source: { field: "series" },
    col: "Metafield: custom.series [single_line_text_field]",
    compare: "string",
    scope: "product",
  },
  {
    // Newly available in the named export format (8 of 140 rows).
    source: { field: "nsn" },
    col: "Metafield: custom.nsn [single_line_text_field]",
    compare: "string",
    scope: "product",
  },
  {
    // AccountMate's tiered price string, e.g. "1:93.00,13:78.00".
    source: { field: "tierPrice" },
    col: "Variant Metafield: custom.accountmate_tiered_prices [single_line_text_field]",
    compare: "string",
    // The export wraps this field in stray doubled quotes -- see accountmate.mjs.
    transform: (v) =>
      String(v)
        .replace(/^"+|"+$/g, "")
        .trim(),
  },
];

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

export const APPLICATION_FIELDS = [
  ["aviation", "Aviation"],
  ["marine", "Marine"],
  ["industrial", "Industrial"],
];

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
  "PAINTS > MIL-PRIMERS": "Military Primer", // "Miliary" in the source spec -- treated as a typo
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
      return n == null ? null : { value: `${n} Inch`, source: "SKU suffix (3M width)" };
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
