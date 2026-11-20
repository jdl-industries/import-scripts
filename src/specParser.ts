/**
 * Normalize, title-case, and expand AccountMate specification strings into the
 * canonical titles used as Shopify `product_specification` metaobject handles.
 *
 * Ported from old/spec-parser.mjs.
 */

/** Words that introduce a qualifier; everything from here on is title-cased. */
const QUALIFIERS = ["TYPE", "CLASS", "GRADE", "COMP", "REV", "FORM", "PQS"];

/** Abbreviations expanded so "TY I" and "TYPE I" collapse to one spec. */
const ABBREV: Array<[RegExp, string]> = [
  [/\bTY\b/gi, "TYPE"],
  [/\bCLS\b/gi, "CLASS"],
  [/\bCL\b/gi, "CLASS"],
  [/\bGR\b/gi, "GRADE"],
];

/**
 * Prefixes that are normally separated from their number by a space, so
 * "BMS10-83" can be repaired. Deliberately a fixed list: a blanket
 * letters-then-digits rule would split "GP110AEE" into "GP 110AEE".
 */
const SPACED_PREFIXES = [
  "BAMS",
  "CMAMS",
  "CMS",
  "DHMS",
  "DPM",
  "DMS",
  "BMS",
  "MEP",
  "AIMS",
  "AMS",
  "HMS",
  "EPS",
  "SAAB",
  "OSU",
  "FAR",
];

/** Acronyms that stay uppercase even in the qualifier tail. */
const KEEP_UPPER = new Set(["PQS", "EMAP", "OSU", "FAR", "BURN"]);

const ROMAN = /^(I{1,3}|IV|VI{0,3}|IX|XI{0,2})$/;

/**
 * Normalise a raw specification string so variant spellings collapse to one.
 * Applied before matching and before the title is built.
 */
export function normalizeSpec(raw: string): string {
  let s = String(raw || "").trim();
  if (!s) return "";

  s = s
    .replace(/\s+/g, " ")
    // Known typo: MIL-DLT for MIL-DTL.
    .replace(/\bMIL-DLT\b/gi, "MIL-DTL")
    // Dotted acronyms.
    .replace(/\bO\.S\.U\.?/gi, "OSU")
    .replace(/\bF\.A\.R\.?/gi, "FAR")
    // Insert the missing space first ("AMS3095"), so the SAE rule below can see
    // a word boundary. AccountMate writes this both ways.
    .replace(new RegExp(`\\b(${SPACED_PREFIXES.join("|")})(\\d)`, "gi"), "$1 $2")
    // SAE AMS and AMS are the same body/spec series.
    .replace(/\bSAE\s+AMS\b/gi, "AMS")
    // A hyphen standing in for a space before a qualifier: MIL-PRF-85285-TYPE I
    .replace(/-(TYPE|TY|CLASS|CLS|CL|GRADE|GR|COMP|REV|FORM)\b/gi, " $1")
    // Missing space between a known prefix and its number: BMS10-83.
    .replace(new RegExp(`\\b(${SPACED_PREFIXES.join("|")})(\\d)`, "gi"), "$1 $2")
    // Missing space after a qualifier word: TYPEI -> TYPE I
    .replace(/\b(TYPE|TY|CLASS|CLS|CL|GRADE|GR)([IVX0-9])/gi, "$1 $2")
    // "REV.A" -> "REV. A" so REV is recognised as a qualifier.
    .replace(/\bREV\.?\s*([A-Z0-9])/gi, "REV. $1")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s*&\s*/g, " & ")
    .replace(/\s+/g, " ")
    .trim();

  for (const [re, full] of ABBREV) s = s.replace(re, full);
  return s.replace(/\s+/g, " ").trim();
}

/** Title-case one qualifier token, preserving roman numerals and code letters. */
function caseToken(tok: string, prevWasQualifier: boolean): string {
  const bare = tok.replace(/[^A-Z0-9./-]/gi, "");
  if (!bare) return tok;
  if (KEEP_UPPER.has(bare.toUpperCase())) return tok.toUpperCase();
  if (ROMAN.test(bare.toUpperCase())) return tok.toUpperCase();
  // A short code following a qualifier keeps its case: Class A, Grade D, Class C2.
  if (prevWasQualifier && /^[A-Z]\d?$/i.test(bare)) return tok.toUpperCase();
  if (/^\d+$/.test(bare)) return tok;
  if (/^(AND|OR)$/i.test(bare)) return tok.toLowerCase();
  return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
}

/**
 * Build the display title: base specification stays ALL CAPS, qualifiers are
 * title-cased. "BAMS 565-009 TYPE I, CLASS A, GRADE B"
 *   -> "BAMS 565-009 Type I, Class A, Grade B"
 */
export function specTitle(raw: string): string {
  const s = normalizeSpec(raw);
  if (!s) return "";
  const words = s.split(" ");
  // Everything before the first qualifier word is the base and stays as-is.
  const firstQualifier = words.findIndex((w) =>
    QUALIFIERS.includes(w.replace(/[^A-Z]/gi, "").toUpperCase()),
  );
  if (firstQualifier === -1) return s;

  const head = words.slice(0, firstQualifier).join(" ");
  const tail = words.slice(firstQualifier);
  let prevWasQualifier = false;
  const cased = tail.map((w) => {
    const isQual = QUALIFIERS.includes(w.replace(/[^A-Z]/gi, "").toUpperCase());
    const out = isQual
      ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
      : caseToken(w, prevWasQualifier);
    prevWasQualifier = isQual;
    return out;
  });
  // Canonical punctuation: no comma between the base and the first qualifier,
  // qualifier groups comma-separated. Without this, "MIL-PRF-85285, Type I,
  // Class H" and "MIL-PRF-85285 Type I Class H" become two metaobjects.
  const groups: string[][] = [];
  for (const w of cased) {
    const isQual = QUALIFIERS.includes(w.replace(/[^A-Z]/gi, "").toUpperCase());
    if (isQual || !groups.length) groups.push([w.replace(/,$/, "")]);
    else groups[groups.length - 1].push(w.replace(/,$/, ""));
  }
  const tailText = groups.map((g) => g.join(" ")).join(", ");
  return `${head.replace(/,$/, "").trim()} ${tailText}`.replace(/\s+/g, " ").trim();
}

/**
 * The specification root: qualifiers removed, and the revision letter stripped
 * so every revision of a spec shares one base ("MIL-PRF-85285E" ->
 * "MIL-PRF-85285"). A trailing single letter only counts as a revision when it
 * directly follows a digit, which leaves codes like GP110AEE intact.
 */
function baseSpecRoot(raw: string): string {
  const s = normalizeSpec(raw);
  if (!s) return "";
  const words = s.split(" ");
  const firstQualifier = words.findIndex((w) =>
    QUALIFIERS.includes(w.replace(/[^A-Z]/gi, "").toUpperCase()),
  );
  let head = (
    firstQualifier === -1 ? s : words.slice(0, firstQualifier).join(" ")
  ).trim();
  head = head.replace(/,$/, "").trim();
  // Trailing prose after the identifier is not part of the base:
  // "FAR 25.853 VERTICAL BURN" -> "FAR 25.853".
  head = head.replace(/\s+(?:VERTICAL\s+)?BURN$/i, "");
  // Drop a trailing revision letter: MIL-DTL-53022F -> MIL-DTL-53022
  head = head.replace(/(\d)[A-Z]$/, "$1");
  return head.trim();
}

/**
 * Base specification, for tagging: blank when the title IS the base --
 * "MEP 10-068" has no separate root worth a second tag.
 */
export function baseSpec(raw: string): string {
  const root = baseSpecRoot(raw);
  return root.toLowerCase() === specTitle(raw).toLowerCase() ? "" : root;
}

/**
 * AccountMate compresses several specifications into one string:
 *
 *   "BMS 10-60, Type I & II, Class B, Grade D"
 *     -> "BMS 10-60, Type I, Class B, Grade D"
 *        "BMS 10-60, Type II, Class B, Grade D"
 *
 * The alternatives appear as "&", "/" or "and", and the qualifier word is
 * sometimes repeated ("Class 20 and Class 33"). Expansion substitutes in place
 * so the rest of the string keeps its original punctuation, and recurses to
 * handle more than two alternatives or more than one multi-valued qualifier.
 */
const MULTI = new RegExp(
  `\\b(${QUALIFIERS.join("|")})\\s+([A-Z0-9]+)\\s*(?:&|/|\\band\\b)\\s*(?:(?:${QUALIFIERS.join("|")})\\s+)?([A-Z0-9]+)`,
  "i",
);

export function expandSpec(raw: string): string[] {
  const title = specTitle(raw);
  if (!title) return [];
  const m = title.match(MULTI);
  if (!m) return [title];
  const [full, kw, a, b] = m;
  const out: string[] = [];
  for (const v of [a, b]) {
    const replaced = title.slice(0, m.index) + `${kw} ${v}` + title.slice(m.index! + full.length);
    out.push(...expandSpec(replaced));
  }
  return [...new Set(out)];
}

/** Metaobject handle for a specification title. */
export const specHandle = (raw: string): string =>
  specTitle(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
