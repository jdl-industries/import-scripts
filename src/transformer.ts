import Anthropic from '@anthropic-ai/sdk';
import type {
  WooCommerceProduct,
  ShopifyProduct,
  ExtractedSpecs,
  GeneratedContent,
} from './types.js';
import { getAttribute } from './parser.js';

const anthropic = new Anthropic();

/**
 * Transform a WooCommerce product into a Shopify product
 */
export async function transformProduct(
  product: WooCommerceProduct
): Promise<ShopifyProduct> {
  // Extract specifications from description fields
  const specs = extractSpecifications(product);

  // Get attribute values
  const manufacturer = getAttribute(product, 'Manufacturer', '');
  const vendorSku = getAttribute(product, 'Vendor SKU', '');
  const hazardous = getAttribute(product, 'Hazardous', 'No');
  const aviation = getAttribute(product, 'Aviation', 'No');
  const marine = getAttribute(product, 'Marine', 'No');
  const industrial = getAttribute(product, 'Industrial', 'No');
  const specialPackaging = getAttribute(product, 'Special packaging', 'No');
  const leadTimeRaw = getAttribute(product, 'Lead time', '');

  // Extract NSN from Barcode1 or description
  const nsn = extractNSN(product);

  // Parse lead time to integer days
  const leadTime = parseLeadTime(leadTimeRaw);

  // Generate LLM content (title, description, SEO fields)
  const generated = await generateContent(product, specs, manufacturer, vendorSku);

  return {
    sku: product.sku,
    title: generated.title,
    description: generated.description,
    regularPrice: product.regularPrice,
    weight: product.weight,
    length: product.length,
    width: product.width,
    height: product.height,
    aviation,
    marine,
    industrial,
    specialPackaging,
    category: 'Manufacturing',
    isHazmat: hazardous.toLowerCase() === 'yes' ? 'true' : 'false',
    manufacturerPartNumber: vendorSku,
    qpl: specs.qpl || '',
    nsn,
    militarySpecification: specs.milSpec || '',
    complianceAndCertifications: specs.certifications.join('; '),
    leadTime: leadTime.toString(),
    pageTitle: generated.pageTitle,
    metaDescription: generated.metaDescription,
    urlHandle: generated.urlHandle,
  };
}

/**
 * Extract military specifications, QPL, and certifications from product descriptions
 */
function extractSpecifications(product: WooCommerceProduct): ExtractedSpecs {
  const combinedText = `${product.shortDescription} ${product.description}`;

  // Extract MIL spec (MIL-PRF-XXXXX, MIL-DTL-XXXXX, MIL-SPEC-XXXXX, MIL-C-XXXXX, etc.)
  const milSpecMatch = combinedText.match(
    /MIL-(?:PRF|DTL|SPEC|C)-\d+[A-Z]?(?:\s*,?\s*(?:TYPE|TY)\s*[IVX\d]+)?(?:\s*,?\s*(?:CLASS|CL)\s*[A-Z\d]+)?/gi
  );
  const milSpec = milSpecMatch ? normalizeMillSpec(milSpecMatch[0]) : null;

  // Extract QPL specification (after "QPL:" tag)
  const qplMatch = combinedText.match(
    /<strong><i>QPL:<\/i><\/strong>\s*([^<\n]+)/i
  );
  let qpl: string | null = null;
  if (qplMatch && qplMatch[1]) {
    const qplValue = qplMatch[1].trim();
    // Only set QPL if there's actual content after the tag
    if (qplValue.length > 0 && !qplValue.match(/^\s*$/)) {
      qpl = qplValue;
    }
  }

  // Extract certifications (non-MIL specs)
  const certifications: string[] = [];

  // BMS specs (Boeing)
  const bmsMatches = combinedText.match(/BMS\d+-\d+[^,;\s<]*/gi);
  if (bmsMatches) certifications.push(...bmsMatches);

  // MEP specs
  const mepMatches = combinedText.match(/MEP\s*\d+-\d+[^,;\s<]*/gi);
  if (mepMatches) certifications.push(...mepMatches);

  // FMS specs (Lockheed Martin)
  const fmsMatches = combinedText.match(/FMS-?\d+[^,;\s<]*/gi);
  if (fmsMatches) certifications.push(...fmsMatches);

  // LMCO specs (Lockheed Martin)
  const lmcoMatches = combinedText.match(/LMCO\s+[A-Z0-9-]+[^,;\s<]*/gi);
  if (lmcoMatches) certifications.push(...lmcoMatches);

  // DOD specs
  const dodMatches = combinedText.match(/DOD-[A-Z]-\d+[A-Z]?/gi);
  if (dodMatches) certifications.push(...dodMatches);

  // "Meets the requirements of" specs
  const meetsMatch = combinedText.match(
    /<strong><i>Meets the requirements of:<\/i><\/strong>\s*([^<\n]+)/i
  );
  if (meetsMatch && meetsMatch[1]) {
    const meetsSpec = meetsMatch[1].trim();
    if (!meetsSpec.startsWith('MIL-')) {
      certifications.push(meetsSpec);
    }
  }

  // Dedupe certifications
  const uniqueCerts = [...new Set(certifications.map((c) => c.trim()))];

  // Extract color from "Color specs:" tag or Color attribute
  const colorMatch = combinedText.match(
    /<strong><i>Color specs:<\/i><\/strong>\s*([^<\n]+)/i
  );
  const color = colorMatch ? colorMatch[1].trim() : null;

  return {
    milSpec,
    qpl,
    nsn: null, // NSN extracted separately
    certifications: uniqueCerts,
    productType: null,
    color,
  };
}

/**
 * Normalize a MIL spec string to consistent format
 */
function normalizeMillSpec(spec: string): string {
  return spec
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/TY\s*/i, 'Type ')
    .replace(/CL\s*/i, 'Class ')
    .replace(/,\s*/g, ', ')
    .trim();
}

/**
 * Extract NSN from Barcode1 attribute or description
 */
function extractNSN(product: WooCommerceProduct): string {
  const barcode1 = getAttribute(product, 'Barcode1', '');
  const combinedText = `${barcode1} ${product.shortDescription} ${product.description}`;

  // NSN format: XXXX-XX-XXX-XXXX (with optional spaces/dashes)
  const nsnMatch = combinedText.match(
    /NSN\s*:?\s*(\d{4}[-\s]?\d{2}[-\s]?\d{3}[-\s]?\d{4})/i
  );
  if (nsnMatch) {
    // Normalize to standard format with dashes
    return nsnMatch[1].replace(/\s+/g, '-').replace(/--+/g, '-');
  }

  // Also check if barcode1 contains just the NSN number
  const directNsnMatch = barcode1.match(
    /(\d{4}[-\s]?\d{2}[-\s]?\d{3}[-\s]?\d{4})/
  );
  if (directNsnMatch) {
    return directNsnMatch[1].replace(/\s+/g, '-').replace(/--+/g, '-');
  }

  return '';
}

/**
 * Parse lead time string to integer days
 */
function parseLeadTime(leadTimeRaw: string): number {
  if (!leadTimeRaw || leadTimeRaw.toLowerCase().includes('available from stock')) {
    return 0;
  }

  const match = leadTimeRaw.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Generate title, description, and SEO content using Claude
 */
async function generateContent(
  product: WooCommerceProduct,
  specs: ExtractedSpecs,
  manufacturer: string,
  vendorSku: string
): Promise<GeneratedContent> {
  const prompt = buildPrompt(product, specs, manufacturer, vendorSku);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }

  return parseGeneratedContent(content.text, manufacturer, vendorSku, specs);
}

/**
 * Build the prompt for Claude
 */
function buildPrompt(
  product: WooCommerceProduct,
  specs: ExtractedSpecs,
  manufacturer: string,
  vendorSku: string
): string {
  // Strip HTML from descriptions for the prompt
  const cleanShortDesc = stripHtml(product.shortDescription);
  const cleanDesc = stripHtml(product.description);

  return `You are helping create product catalog entries for an aerospace/industrial coatings e-commerce store.

Given this product data, generate the following fields:

PRODUCT DATA:
- SKU: ${product.sku}
- Name: ${product.name}
- Manufacturer: ${manufacturer || 'Unknown'}
- Manufacturer Part Number: ${vendorSku}
- Short Description: ${cleanShortDesc}
- Full Description: ${cleanDesc}
- Military Specification: ${specs.milSpec || 'None'}
- QPL: ${specs.qpl || 'None'}
- Color: ${specs.color || 'Not specified'}

GENERATE:
1. TITLE: Format as "{Title-Cased Manufacturer} {Part Number(s)}, {Short Product Description}, {MIL-SPEC} {Type} {Class} {(QPL) if applicable}"
   - Keep product description portion concise (under 30 words)
   - Include (QPL) suffix only if product has QPL qualification

2. DESCRIPTION: Rewrite the product description to be:
   - Human-readable (no HTML, clean formatting)
   - Professional and SEO-optimized
   - 2-4 sentences covering key features and specifications
   - Start with manufacturer name and product type

3. PAGE_TITLE: Shortened version of TITLE for SEO (max 70 characters)
   - Keep manufacturer, part number, and mil spec
   - Abbreviate product description if needed

4. META_DESCRIPTION: Concise product summary (max 160 characters)
   - Focus on key product attributes
   - Include mil spec if applicable

5. URL_HANDLE: Lowercase, dash-separated URL slug
   - Format: {manufacturer}-{primary-part-number}-{mil-spec-number}-type-{type}
   - Example: hentzen-17176kep-mil-prf-23377-type-ii
   - No special characters, only lowercase letters, numbers, and dashes

Respond in this exact format:
TITLE: [your title]
DESCRIPTION: [your description]
PAGE_TITLE: [your page title]
META_DESCRIPTION: [your meta description]
URL_HANDLE: [your url handle]`;
}

/**
 * Strip HTML tags from text
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse the generated content from Claude's response
 */
function parseGeneratedContent(
  text: string,
  manufacturer: string,
  vendorSku: string,
  specs: ExtractedSpecs
): GeneratedContent {
  const lines = text.split('\n');

  let title = '';
  let description = '';
  let pageTitle = '';
  let metaDescription = '';
  let urlHandle = '';

  for (const line of lines) {
    if (line.startsWith('TITLE:')) {
      title = line.replace('TITLE:', '').trim();
    } else if (line.startsWith('DESCRIPTION:')) {
      description = line.replace('DESCRIPTION:', '').trim();
    } else if (line.startsWith('PAGE_TITLE:')) {
      pageTitle = line.replace('PAGE_TITLE:', '').trim();
    } else if (line.startsWith('META_DESCRIPTION:')) {
      metaDescription = line.replace('META_DESCRIPTION:', '').trim();
    } else if (line.startsWith('URL_HANDLE:')) {
      urlHandle = line.replace('URL_HANDLE:', '').trim();
    }
  }

  // Fallback values if parsing fails
  if (!title) {
    title = `${titleCase(manufacturer)} ${vendorSku}`;
  }
  if (!urlHandle) {
    urlHandle = generateUrlHandle(manufacturer, vendorSku, specs.milSpec);
  }
  if (!pageTitle) {
    pageTitle = title.substring(0, 70);
  }
  if (!metaDescription) {
    metaDescription = description.substring(0, 160);
  }

  return {
    title,
    description,
    pageTitle,
    metaDescription,
    urlHandle,
  };
}

/**
 * Generate a URL handle from product data
 */
function generateUrlHandle(
  manufacturer: string,
  vendorSku: string,
  milSpec: string | null
): string {
  const parts: string[] = [];

  if (manufacturer) {
    parts.push(manufacturer.toLowerCase());
  }

  if (vendorSku) {
    // Get primary part number (before any slash or space)
    const primaryPart = vendorSku.split(/[\/\s]/)[0];
    parts.push(primaryPart.toLowerCase());
  }

  if (milSpec) {
    // Extract just the spec number portion
    const specMatch = milSpec.match(/MIL-(?:PRF|DTL|SPEC|C)-(\d+)/i);
    if (specMatch) {
      parts.push(`mil-prf-${specMatch[1]}`);
    }

    // Extract type if present
    const typeMatch = milSpec.match(/Type\s*([IVX\d]+)/i);
    if (typeMatch) {
      parts.push(`type-${typeMatch[1].toLowerCase()}`);
    }
  }

  return parts
    .join('-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Convert string to title case
 */
function titleCase(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
