// this file contains any mappings requiring more complex logic (ie beyond just type transforms, trimming, etc)

import { AccountMateItem } from "./accountMateTypes";
import { baseSpec, expandSpec, specHandle, specTitle } from "./specParser";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

const MANUFACTURER_DISPLAY_NAME: Record<string, string> = {
  "3M": "3M",
  "Hentzen Coatings, Inc.": "Hentzen",
  FlameMaster: "FlameMaster",
  "Henkel Aerospace": "Henkel",
  Penreco: "Penreco",
};

export function getManufacturerDisplayName(accountMateItem: AccountMateItem) {
  const manufacturer = accountMateItem["Manufacturer"].trim();
  return MANUFACTURER_DISPLAY_NAME[manufacturer] || manufacturer;
}

/** SKU prefixes AccountMate adds on top of the manufacturer's own part number. */
const SKU_MANUFACTURER_PREFIX: Record<string, string> = {
  "Hentzen Coatings, Inc.": "HZ",
  "Henkel Aerospace": "HS-",
};

/** Packaging/kit-size tokens AccountMate appends to the part number in the SKU. */
const TRAILING_PACK_SIZE_PATTERN =
  /\s+(?:\d+(?:[./]\d+)?\s*-?\s*)?(QRT|QT-KIT|GL|GK-?\d+(?:\.\d+)?|KIT|KT-?\d+(?:\.\d+)?(?:\s*GL)?|KT|CAN|LB|OZ|PT|QT)\b.*$/i;

/**
 * Best-effort manufacturer part number, derived from the SKU rather than the
 * "Vendor part number" column -- that column is an internal vendor code for
 * some manufacturers (eg Henkel) and unrelated to the customer-facing part
 * number. Not guaranteed to exactly match the manufacturer's own formatting;
 * drafts using this are reviewed by hand before publishing.
 */
export function getManufacturerPartNumber(accountMateItem: AccountMateItem) {
  let mpn = accountMateItem["SKU"].trim();

  const prefix = SKU_MANUFACTURER_PREFIX[accountMateItem["Manufacturer"].trim()];
  if (prefix && mpn.toUpperCase().startsWith(prefix)) {
    mpn = mpn.slice(prefix.length);
  }

  return mpn.replace(TRAILING_PACK_SIZE_PATTERN, "").trim();
}

/**
 * Terse product descriptor pulled out of the free-text "Short description".
 * That field's layout varies a lot by manufacturer and is sometimes blank
 * entirely, so this strips the pieces we can already identify confidently
 * (manufacturer, series, part number, color, parenthetical specs) and bails
 * out to "" -- rather than guessing -- whenever what's left still looks
 * unreliable. Titles/handles built from an empty result are expected to be
 * reviewed and filled in by hand.
 */
export function getTerseDescription(accountMateItem: AccountMateItem) {
  let s = accountMateItem["Short description"].trim();
  if (!s) return "";

  const manufacturer = getManufacturerDisplayName(accountMateItem);
  if (manufacturer) {
    s = s.replace(new RegExp(`^${escapeRegex(manufacturer)}\\b`, "i"), "");
  }

  const series = accountMateItem["Series"].trim();
  if (series) {
    s = s.replace(new RegExp(`${escapeRegex(series)}\\s+Series\\b`, "i"), "");
  }

  const mpn = getManufacturerPartNumber(accountMateItem);
  if (mpn) {
    s = s.replace(new RegExp(`\\b${escapeRegex(mpn)}\\b`, "i"), "");
  }

  s = s.replace(/\([^)]*\)/g, "");

  // A trailing " - <...>" clause is reliably a color/finish code in this dialect
  // (eg "- PANTONE PROCESS BLACK C", "- RAL 5005 BLUE"), not description text --
  // drop the whole clause rather than just the one word matching Color.
  const lastDashClause = s.lastIndexOf(" - ");
  if (lastDashClause !== -1) {
    s = s.slice(0, lastDashClause);
  }

  const color = accountMateItem["Color"].trim();
  if (color) {
    s = s.replace(new RegExp(`\\b${escapeRegex(color)}\\b`, "i"), "");
  }

  s = s
    .replace(/\s+-\s+/g, " ")
    .replace(/^[\s\-,.]+|[\s\-,.]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  const wordCount = s.split(/\s+/).filter(Boolean).length;
  if (!s || wordCount > 6 || /[0-9,;]/.test(s)) return "";

  return s;
}

function splitSpecs(raw: string): string[] {
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Excludes bare numeric/punctuation codes (eg "51-33-00") that aren't real spec designations. */
function isRecognizableSpec(raw: string): boolean {
  return /[A-Za-z]/.test(raw);
}

/**
 * Handle-safe spec slug: a MIL spec is what people actually search for, so this
 * checks every QPL ("Approved specs") and "Meets specs" entry for one, in that
 * order. Falls back to the first recognizable QPL entry (eg an AMS spec) when
 * there's no MIL spec anywhere.
 */
function getSpecSuffixHandle(accountMateItem: AccountMateItem) {
  const qplEntries = splitSpecs(accountMateItem["QPL"]);
  const meetsSpecEntries = splitSpecs(accountMateItem["Meets specs"]);

  for (const entry of [...qplEntries, ...meetsSpecEntries]) {
    if (/^MIL[-\s]/i.test(specTitle(entry))) return specHandle(entry);
  }

  const firstValidQpl = qplEntries.find(isRecognizableSpec);
  return firstValidQpl ? specHandle(firstValidQpl) : "";
}

export function getColorDisplay(accountMateItem: AccountMateItem) {
  return accountMateItem["Color"].trim().toUpperCase();
}

/** Whatever AccountMate wrote inside the (single) parenthetical in "Short description", verbatim. */
export function getSpecFromShortDescription(accountMateItem: AccountMateItem) {
  const match = accountMateItem["Short description"].match(/\(([^)]*)\)/);
  if (!match) return "";
  const content = match[1].trim();
  // A bare acronym like "(QPL)" is a qualifier *about* a spec listed
  // elsewhere in the sentence, not the spec text itself.
  if (/^[A-Za-z]{2,5}$/.test(content)) return "";
  return content;
}

/**
 * The full color phrase from "Short description" (eg "RAL 5005 Blue" rather
 * than just "Blue"), when it's findable there. Prefers the trailing
 * " - <...>" clause this description dialect uses for color/finish codes;
 * otherwise looks for a comma-delimited segment containing the color word.
 * Falls back to the plain Color column when neither turns up anything.
 */
export function getColorPhraseFromShortDescription(
  accountMateItem: AccountMateItem,
) {
  const raw = accountMateItem["Short description"];
  const color = accountMateItem["Color"].trim();
  if (!raw || !color) return getColorDisplay(accountMateItem);

  const colorPattern = new RegExp(`\\b${escapeRegex(color)}\\b`, "i");

  const lastDashClause = raw.lastIndexOf(" - ");
  if (lastDashClause !== -1) {
    const tail = raw
      .slice(lastDashClause + 3)
      .replace(/\([^)]*\)/g, "")
      .trim();
    if (colorPattern.test(tail)) return tail.toUpperCase();
  }

  for (const segment of raw.split(",")) {
    const trimmed = segment.trim();
    if (!colorPattern.test(trimmed)) continue;
    // Only treat the segment as a pure color phrase if little else is in it --
    // eg "Hentzen 31101WPX, White Gloss Topcoat, ..." has "Gloss Topcoat" (the
    // product description, not the color) sharing a comma cell with "White".
    const leftover = trimmed
      .replace(colorPattern, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (leftover.length <= 1) return trimmed.toUpperCase();
  }

  return getColorDisplay(accountMateItem);
}

/**
 * Hentzen's "Vendor part number" column is the manufacturer's real catalog
 * number (eg "PG-6-B878") and is more reliable than anything derivable from
 * the SKU, aside from an occasional " + CAT ..." catalyst/hardener suffix or
 * a second ", <alternate spelling>" AccountMate sometimes appends. Other
 * manufacturers' "Vendor part number" is an internal vendor code unrelated
 * to the customer-facing part number, so they keep using the SKU-derived
 * value.
 */
function getPartNumber(accountMateItem: AccountMateItem) {
  if (accountMateItem["Manufacturer"].trim() === "Hentzen Coatings, Inc.") {
    return accountMateItem["Vendor part number"].split(/[+,]/)[0].trim();
  }
  return getManufacturerPartNumber(accountMateItem);
}

/**
 * Handle for a brand new product: [manufacturer]-[manufacturer part number]-
 * [terse description]-[spec, if any]. Only used for new product drafts;
 * existing products keep whatever handle they already have in Shopify.
 */
export function getHandle(accountMateItem: AccountMateItem) {
  const segments = [
    getManufacturerDisplayName(accountMateItem),
    getPartNumber(accountMateItem),
    getTerseDescription(accountMateItem),
    getSpecSuffixHandle(accountMateItem),
  ];

  return segments
    .filter(Boolean)
    .map(slugify)
    .filter(Boolean)
    .join("-");
}

/**
 * Title for a brand new product: [manufacturer] [manufacturer part number]
 * [terse description] ([spec from Short description's parens]) - [full color
 * phrase from Short description]. AccountMate's own "Short description"
 * isn't SEO-appropriate yet, so this composes a title from structured fields
 * instead of just copying it through -- but the spec and color text itself
 * is still sourced from Short description, since it's richer there than the
 * QPL/Color columns alone.
 */
export function getTitle(accountMateItem: AccountMateItem) {
  const manufacturer = getManufacturerDisplayName(accountMateItem);
  const mpn = getPartNumber(accountMateItem);
  const description = getTerseDescription(accountMateItem);
  const spec = getSpecFromShortDescription(accountMateItem);
  const color = getColorPhraseFromShortDescription(accountMateItem);

  let title = [manufacturer, mpn, description].filter(Boolean).join(" ");
  if (spec) title += ` (${spec})`;
  if (color) title += ` - ${color}`;

  return title.trim();
}

/**
 * Shopify price is the AccountMate base price plus whatever surcharge AccountMate
 * reports. Amount wins over percent when both are present.
 */
export function getPrice(accountMateItem: AccountMateItem) {
  const base = parseFloat(accountMateItem["Price"]);
  const amount = parseFloat(accountMateItem["Surcharge amount"]) || 0;
  const percent = parseFloat(accountMateItem["Surcharge percent"]) || 0;

  let surcharge = 0;
  if (amount > 0) {
    surcharge = amount;
  } else if (percent > 0 && Number.isFinite(base)) {
    surcharge = +(base * (percent / 100)).toFixed(2);
  }

  return Number.isFinite(base) ? (base + surcharge).toFixed(2) : "";
}

export function getDescription(accountMateItem: AccountMateItem) {
  return accountMateItem["Description"];
}

/**
 * AccountMate packs several specifications into one semicolon-delimited string.
 * Each is normalized, title-cased, and expanded (eg "Type I & II" -> two specs).
 */
function expandedSpecs(raw: string): string[] {
  const rawSpecs = raw
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x.length > 2);

  const expanded = rawSpecs
    .flatMap((x) => expandSpec(x))
    .filter((x) => x && x.length > 2);

  return [...new Set(expanded)];
}

/** Resolves each spec to its `product_specification` metaobject reference. */
function getSpecs(raw: string): string {
  return expandedSpecs(raw)
    .map((t) => `product_specification.${specHandle(t)}`)
    .join(", ");
}

export function getQPL(accountMateItem: AccountMateItem) {
  return getSpecs(accountMateItem["QPL"]);
}

export function getMeetsSpecs(accountMateItem: AccountMateItem) {
  return getSpecs(accountMateItem["Meets specs"]);
}

/**
 * Searchable tags: one per spec the product meets or is approved for (its
 * BASE, eg "mil-prf-85285" rather than the qualified "mil-prf-85285-type-i",
 * since that's what buyers actually search), plus the color, series, and NSN.
 * Metafields aren't indexed by Shopify search, but tags are.
 */
export function getTags(accountMateItem: AccountMateItem) {
  const specTags = [
    ...expandedSpecs(accountMateItem["QPL"]),
    ...expandedSpecs(accountMateItem["Meets specs"]),
  ].map((t) => slugify(baseSpec(t) || t));

  const color = accountMateItem["Color"].trim();
  const series = accountMateItem["Series"].trim();
  const nsn = accountMateItem["NSN number"].trim();

  const tags = [
    color && slugify(color),
    series && slugify(series),
    nsn && slugify(nsn),
    ...specTags,
  ];

  return [...new Set(tags.filter(Boolean))].join(", ");
}

export function getType(accountMateItem: AccountMateItem) {
  const ACCOUNTMATE_CATEGORY_TO_TYPE: Record<string, string> = {
    "ABRASIVES > PADS": "Abrasive Pad",
    "ADHESIVES > PASTE": "Adhesive Paste",
    CHEMICALS: "Other Chemical",
    LUBRICANTS: "Lubricant",
    "SEALANT > SEAL-POLY": "Sealant",
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
  const c = accountMateItem["Categories"]
    .trim()
    .toUpperCase()
    .replace(/^SEALANT\b/, "SEALANTS");
  if (Object.hasOwn(ACCOUNTMATE_CATEGORY_TO_TYPE, c))
    return ACCOUNTMATE_CATEGORY_TO_TYPE[c];
  throw new Error(`Could not map category ${c} to known Type`);
}

interface ProductCategory {
  "Category: ID": string;
  "Category: Name": string;
  Category: string;
}

/**
 * Shopify's built-in Standard Product Taxonomy, by classification "kind".
 * Certain metafields (eg custom.size) are constrained to the product's
 * category -- a product created without one rejects those metafields
 * entirely ("Owner subtype does not match the metafield definition's
 * constraints"), so every new product needs one set. Ported from
 * old/sync-config.js's PRODUCT_CATEGORY, verified against Shopify's live
 * taxonomy as of that file's last update.
 */
const PRODUCT_CATEGORY: Record<string, ProductCategory> = {
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
  // Coatings & Sealants leaves are all construction-grade), so this
  // deliberately sits one level up at the parent.
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

/**
 * Hentzen is entirely coatings, so its category comes down to which kind:
 * CARC is checked first since a CARC coating is also technically a topcoat;
 * primer next; everything else (including accelerators, reducers, and
 * non-skid walkway coatings, which have no better home) is Paint.
 */
function classifyHentzenCategory(accountMateItem: AccountMateItem): string {
  const text = [
    accountMateItem["Short description"],
    accountMateItem["QPL"],
    accountMateItem["Meets specs"],
    accountMateItem["Series"],
  ]
    .join(" ")
    .toLowerCase();
  if (/\bcarc\b|53039/.test(text)) return "carc";
  if (/primer/.test(text)) return "primer";
  return "topcoat";
}

/** Scotch-Brite hand pads and foil/glass-cloth tape aren't masking tape; only flag the ones that actually say so. */
function classify3MCategory(accountMateItem: AccountMateItem): string {
  const text = accountMateItem["Short description"].toLowerCase();
  if (/scotch-?brite|hand pad/.test(text)) return "abrasive";
  if (/masking tape/.test(text)) return "tapeMasking";
  return "tape";
}

/** Product-category classification "kind", keyed by raw AccountMate Manufacturer. */
const MANUFACTURER_CATEGORY_KIND: Record<
  string,
  string | ((item: AccountMateItem) => string)
> = {
  "Hentzen Coatings, Inc.": classifyHentzenCategory,
  "3M": classify3MCategory,
  FlameMaster: "sealant",
  "Henkel Aerospace": "adhesive",
  Penreco: "grease",
};

function getCategoryKind(accountMateItem: AccountMateItem): string {
  const manufacturer = accountMateItem["Manufacturer"].trim();
  const resolver = MANUFACTURER_CATEGORY_KIND[manufacturer];
  if (typeof resolver === "function") return resolver(accountMateItem);
  if (typeof resolver === "string") return resolver;
  throw new Error(
    `Could not classify product category for manufacturer ${manufacturer}`,
  );
}

export function getCategoryId(accountMateItem: AccountMateItem) {
  return PRODUCT_CATEGORY[getCategoryKind(accountMateItem)]["Category: ID"];
}

export function getCategoryName(accountMateItem: AccountMateItem) {
  return PRODUCT_CATEGORY[getCategoryKind(accountMateItem)]["Category: Name"];
}

export function getCategory(accountMateItem: AccountMateItem) {
  return PRODUCT_CATEGORY[getCategoryKind(accountMateItem)]["Category"];
}

/**
 * Collection handle for the aviation-coatings collections (the only ones
 * curated so far). Ported from old/sync-config.js's PARENT_COLLECTION --
 * unlike Category, there's no Shopify-side requirement forcing every kind to
 * have one, so a kind with no entry (tape, adhesive, sealant, grease,
 * abrasive) just gets "".
 */
const PARENT_COLLECTION: Record<string, string> = {
  primer: "aviation-primers",
  topcoat: "aviation-topcoats",
  carc: "chemical-agent-resistive-coatings-carc",
};

export function getParentCollection(accountMateItem: AccountMateItem) {
  return PARENT_COLLECTION[getCategoryKind(accountMateItem)] || "";
}

export function getImage(accountMateItem: AccountMateItem) {
  const ACCOUNTMATE_IMAGE_TO_SHOPIFY_FILE: Record<string, string> = {
    "noimage.jpg":
      "https://cdn.shopify.com/s/files/1/0750/8767/5550/files/hentzen-mil-gallon-1024.jpg",
    "hentzen-mil-gallon-1024.jpg":
      "https://cdn.shopify.com/s/files/1/0750/8767/5550/files/hentzen-mil-gallon-1024.jpg",
    "3m-tapes.jpg":
      "https://cdn.shopify.com/s/files/1/0750/8767/5550/files/3m-tapes.jpg",
    "loctite_qt_1024.jpg":
      "https://cdn.shopify.com/s/files/1/0750/8767/5550/files/loctite_qt_1024.jpg",
    "3M-425-Tape-Rightside_R1.jpg":
      "https://cdn.shopify.com/s/files/1/0750/8767/5550/files/3M-425-Tape-Rightside_R1.jpg",
    "3M-2693-Tan-Tape-Rightside.jpg":
      "https://cdn.shopify.com/s/files/1/0750/8767/5550/files/3M-2693-Tan-Tape-Rightside.jpg",
    "3M-398FRP-Tape.jpg":
      "https://cdn.shopify.com/s/files/1/0750/8767/5550/files/3M-398FRP-Tape.jpg",
    "3M-8991-Tape-Leftside_R1.jpg":
      "https://cdn.shopify.com/s/files/1/0750/8767/5550/files/3M-8991-Tape-Leftside_R1.jpg",
    "3M-401+-Green-Tape-Rightside.jpg":
      "https://cdn.shopify.com/s/files/1/0750/8767/5550/files/3M-401_-Green-Tape-Rightside.jpg",
    "3M-ScotchBrite-7447-Pad-Mixed_Center.jpg":
      "https://cdn.shopify.com/s/files/1/0750/8767/5550/files/3M-ScotchBrite-7447-Pad-Mixed_Center.jpg",
    "sealant-tube-1024.jpg":
      "https://cdn.shopify.com/s/files/1/0750/8767/5550/files/sealant-tube-1024.jpg",
    "sealant-can-1024.jpg":
      "https://cdn.shopify.com/s/files/1/0750/8767/5550/files/sealant-can-1024.jpg",
    // TBD: NEED IMAGE
    "hentzen-qrt-1024.jpg":
      "https://cdn.shopify.com/s/files/1/0750/8767/5550/files/hentzen-mil-gallon-1024.jpg",
    "hentzen-eg-gal-1024.jpg":
      "https://cdn.shopify.com/s/files/1/0750/8767/5550/files/hentzen-mil-gallon-1024.jpg",
    "hentzen-ep-gal-1024.jpg":
      "https://cdn.shopify.com/s/files/1/0750/8767/5550/files/hentzen-mil-gallon-1024.jpg",
    "hentzen-2oz-1024.jpg":
      "https://cdn.shopify.com/s/files/1/0750/8767/5550/files/hentzen-mil-gallon-1024.jpg",
    "hentzen-pg-gal-1024.jpg":
      "https://cdn.shopify.com/s/files/1/0750/8767/5550/files/hentzen-mil-gallon-1024.jpg",
    "hentzen_paints.jpg":
      "https://cdn.shopify.com/s/files/1/0750/8767/5550/files/hentzen-mil-gallon-1024.jpg",
    "hentzen-ws-gal-1024.jpg":
      "https://cdn.shopify.com/s/files/1/0750/8767/5550/files/hentzen-mil-gallon-1024.jpg",
  };
  const image = accountMateItem["Image"];
  if (Object.hasOwn(ACCOUNTMATE_IMAGE_TO_SHOPIFY_FILE, image))
    return ACCOUNTMATE_IMAGE_TO_SHOPIFY_FILE[image];
  throw new Error(`Could not map ${image} to known Shopify image`);
}

/** Roll goods report their cut size in the description rather than a fixed UOM code. */
const ROLL_SIZE_PATTERN =
  /\d+(?:\.\d+)?\s*mm\s*x\s*\d+(?:\.\d+)?\s*m\s*\(\d+(?:\.\d+)?\s*in\.?\)|\d+(?:\.\d+)?\s*in\s*x\s*\d+(?:\.\d+)?\s*yd/i;

export function getSize(accountMateItem: AccountMateItem) {
  const SKU_SIZE_OVERRIDE: Record<string, string> = {
    "VV-P-236  CAN 1-LB": "1-lb Can",
    "SCOTCH-BR7447": "20-count Box",
  };
  const sku = accountMateItem["SKU"];
  if (Object.hasOwn(SKU_SIZE_OVERRIDE, sku)) return SKU_SIZE_OVERRIDE[sku];

  const uom = accountMateItem["Unit of measure"];

  if (uom === "RL") {
    const match = accountMateItem["Short description"].match(ROLL_SIZE_PATTERN);
    if (match) return match[0];
    throw new Error(
      `Could not extract roll size from description: ${accountMateItem["Short description"]}`,
    );
  }

  const UOM_TO_SIZE: Record<string, string> = {
    "1-GL KIT": "1 Gallon Kit",
    "1-QT KIT": "1 Quart Kit",
    "1.25-GL KT": "1.25 Gallon Kit",
    "1.5-GL KT": "1.5 Gallon Kit",
    "1.5 -GL KT": "1.5 Gallon Kit",
    "2-GL KIT": "2 Gallon Kit",
    "2-QT KIT": "2 Quart Kit",
    "2-OZ KIT": "2oz Touch-up Kit",
    "3-QT KIT": "3 Quart Kit",
    "4-GL KIT": "4 Gallon Kit",
    "5-GL KIT": "5 Gallon Kit",
    "6-OZ KIT": "6oz Kit",
    "PINT KIT": "Pint Kit",
    QRT: "Quart",
    "QUART KIT": "Quart Kit",
    GALLON: "Gallon",
    LB: "Pound",
  };
  if (Object.hasOwn(UOM_TO_SIZE, uom)) return UOM_TO_SIZE[uom];

  throw new Error(`Could not map unit of measure "${uom}" to known Size`);
}

/**
 * Resolves each code in "Color specs" to its Shopify color-pattern metaobject
 * handle. Only coatings/paints carry a real color code -- other categories
 * (tapes, adhesives, etc.) are excluded even when the field happens to hold text.
 */
const COLOR_SPEC_PREFIXES: Array<[RegExp, (code: string) => string]> = [
  [/^BAC-([A-Z0-9]+)/i, (code) => `bac-${code.toLowerCase()}`],
  [/^DN-([A-Z0-9]+)/i, (code) => `dn-${code.toLowerCase()}`],
  [/^FS-([A-Z0-9]+)/i, (code) => code.toLowerCase()],
  [/^PMS-([A-Z0-9]+)/i, (code) => `pms-${code.toLowerCase()}`],
  [/^RAL-([A-Z0-9]+)/i, (code) => `ral-${code.toLowerCase()}`],
];

export function getColor(accountMateItem: AccountMateItem) {
  if (!accountMateItem["Categories"].toUpperCase().includes("PAINT")) return "";

  const parts = accountMateItem["Color specs"]
    .split(/[;/]/)
    .map((p) => p.trim());

  const handles = new Set<string>();
  for (const part of parts) {
    for (const [pattern, toHandle] of COLOR_SPEC_PREFIXES) {
      const match = part.match(pattern);
      if (match) {
        handles.add(toHandle(match[1]));
        break;
      }
    }
  }

  return [...handles].map((h) => `shopify--color-pattern.${h}`).join(", ");
}

export function getVendor(accountMateItem: AccountMateItem) {
  const ACCOUNTMATE_MANUFACTURER_TO_VENDOR: Record<string, string> = {
    "Hentzen Coatings, Inc.": "Hentzen",
    "3M": "3M",
    FlameMaster: "",
    "Henkel Aerospace": "Henkel",
    Penreco: "Penreco",
  };
  const manufacturer = accountMateItem["Manufacturer"];
  if (Object.hasOwn(ACCOUNTMATE_MANUFACTURER_TO_VENDOR, manufacturer))
    return ACCOUNTMATE_MANUFACTURER_TO_VENDOR[manufacturer];
  throw new Error(`Could not map ${manufacturer} to known manufacturer`);
}
