# Product Catalog Transformation Prompt

You are transforming a WooCommerce product export into a Shopify-compatible CSV for an aerospace/industrial coatings e-commerce store.

## Instructions

1. Read the attached WooCommerce CSV export
2. Transform each product row according to the field specifications below
3. Output a valid CSV with the exact headers specified
4. Process ALL rows - do not truncate, summarize, or skip any products
5. If processing in batches, maintain consistent formatting across batches

---

## Input Format (WooCommerce Export)

The input CSV contains these relevant columns:

| Column Name | Contains |
|-------------|----------|
| SKU | Product SKU (e.g., "HZK17176KEP_G") |
| Name | Product name |
| Short description | Mil spec, QPL info, color (HTML formatted) |
| Description | Full product description (HTML formatted) |
| Regular price | Price as number |
| Weight (lbs) | Weight as number |
| Length (in) | Length as number |
| Width (in) | Width as number |
| Height (in) | Height as number |

**Attributes** are in paired columns (`Attribute N name` / `Attribute N value(s)`). Extract these values:
- **Manufacturer** - e.g., "HENTZEN"
- **Vendor SKU** - Manufacturer part number
- **Barcode1** - Often contains NSN
- **Hazardous** - "Yes" or "No"
- **Aviation** - "Yes" or "No"
- **Marine** - "Yes" or "No"
- **Industrial** - "Yes" or "No"
- **Special packaging** - "Yes" or "No"
- **Lead time** - e.g., "30 business days" or "Available from stock"

**Embedded in HTML** (Short description / Description fields):
- QPL specs appear as: `<strong><i>QPL:</i></strong> MIL-PRF-23377K, TYPE II, CLASS N`
- Other specs appear as: `<strong><i>Meets the requirements of:</i></strong> ...`
- Color appears as: `<strong><i>Color specs:</i></strong> ...`

---

## Output Format

Generate a CSV with exactly these 23 columns in this order:

```
SKU,Title,Description,Regular Price,Weight,Length,Width,Height,Aviation,Marine,Industrial,Special Packaging,Category,Is Hazmat,Manufacturer Part Number,QPL,NSN,Military Specification,Compliance and Certifications,Lead Time,Page Title,Meta Description,URL Handle
```

---

## Field Specifications

### 1. SKU
Copy directly from input.

### 2. Title
**Format:** `{Manufacturer} {Part Number(s)}, {Short Description}, {MIL-SPEC} {Type} {Class} {(QPL)}`

Rules:
- Title-case the manufacturer name ("HENTZEN" → "Hentzen")
- Use Vendor SKU for part number(s); separate multiples with slash
- Short description should be concise (under 6 words) - extract key product type
- Include "(QPL)" only if QPL specification exists
- Normalize MIL spec format: "MIL-PRF-23377 Type II Class N"

**Example:** `Hentzen 17176KEP/16709CEH, Non-Chrome Epoxy Primer, MIL-PRF-23377 Type II Class N (QPL)`

### 3. Description
Rewrite the product description to be:
- Human-readable (strip all HTML)
- Professional and SEO-optimized
- 2-4 sentences covering key features
- Start with manufacturer name and product type

**Example:** `Hentzen's Dark Green Aerospace High Performance Primer 17176KEP/16709CEH, Chromate-Free. This Epoxy Primer has been formulated to have excellent corrosion resistance and meet all the performance requirements of the specification.`

### 4. Regular Price
Copy directly from input "Regular price" column.

### 5. Weight
Copy directly from input "Weight (lbs)" column.

### 6. Length
Copy directly from input "Length (in)" column.

### 7. Width
Copy directly from input "Width (in)" column.

### 8. Height
Copy directly from input "Height (in)" column.

### 9. Aviation
Copy from Aviation attribute: "Yes" or "No"

### 10. Marine
Copy from Marine attribute: "Yes" or "No"

### 11. Industrial
Copy from Industrial attribute: "Yes" or "No"

### 12. Special Packaging
Copy from "Special packaging" attribute: "Yes" or "No"

### 13. Category
Always use: `Manufacturing`

### 14. Is Hazmat
Convert Hazardous attribute: "Yes" → `true`, "No" → `false`

### 15. Manufacturer Part Number
Copy from "Vendor SKU" attribute.

### 16. QPL
Extract the specification string after "QPL:" in the HTML.
- Only populate if an actual spec follows the tag
- Leave empty if just "QPL:" with no specification

**Example:** `MIL-PRF-23377K, TYPE II, CLASS N`

### 17. NSN
Extract National Stock Number from Barcode1 attribute or Description.
- Format: `XXXX-XX-XXX-XXXX`
- Look for patterns like "NSN 8010-01-582-7280" or "NSN: 8010-01-582-7280"
- Leave empty if not found

**Example:** `8010-01-582-7280`

### 18. Military Specification
Extract MIL spec from Short description or Description.
- Format: `MIL-{TYPE}-{NUMBER}{VERSION}, Type {X}, Class {X}`
- Types: PRF, DTL, SPEC, C
- Normalize format consistently

**Example:** `MIL-PRF-23377K, Type II, Class N`

### 19. Compliance and Certifications
Extract NON-MIL-SPEC certifications, semicolon-separated:
- OEM specs: BMS10-11, FMS-1027, etc.
- Industry standards: MEP 10-059, MEP 10-070
- Manufacturer qualifications: LMCO EMAP, LMCO FQML-P-23377-7
- "Meets the requirements of" specs (if not a MIL spec)

**Example:** `BMS10-11 Type I Class A Grade B; MEP 10-059 Type II; LMCO EMAP`

### 20. Lead Time
Convert "Lead time" attribute to integer days:
- "30 business days" → `30`
- "Available from stock" → `0`
- Extract just the number

### 21. Page Title
Shortened version of Title for SEO.
- Maximum 70 characters
- Keep: manufacturer, part number, mil spec
- Abbreviate product description if needed

**Example:** `Hentzen 17176KEP, Epoxy Primer, MIL-PRF-23377 Type II (QPL)`

### 22. Meta Description
Concise product summary for SEO.
- Maximum 160 characters
- Focus on key attributes and benefits

**Example:** `Hentzen Dark Green Aerospace Primer 17176KEP/16709CEH. Chromate-free epoxy with excellent corrosion resistance. QPL MIL-PRF-23377 Type II.`

### 23. URL Handle
Lowercase, dash-separated URL slug.
- Format: `{manufacturer}-{part-number}-{mil-spec}-type-{type}`
- Only lowercase letters, numbers, and dashes
- Use primary part number only (before any slash)

**Example:** `hentzen-17176kep-mil-prf-23377-type-ii`

---

## Example Transformation

### Input Row (simplified):
```
SKU: HZK17176KEP_G
Name: HZK17176KEP_G
Short description: MIL-PRF-23377, TY II,CL N DARK GREEN PRIMER 3/1 GLKIT<strong><i>QPL:</i></strong> MIL-PRF-23377K, TYPE II, CLASS N<strong><i>Color specs:</i></strong> LOW IR DARK GREEN
Description: Dark Green Hentzen's Aerospace High Performance Primer 17176KEP/16709CEH, Chromate-Free...
Regular price: 519.17
Weight: 23.00
Manufacturer attribute: HENTZEN
Vendor SKU attribute: 17176KEP - 16709CEH
Hazardous attribute: Yes
Aviation attribute: Yes
Marine attribute: No
Industrial attribute: No
Special packaging attribute: Yes
Lead time attribute: 90 business days
```

### Output Row:
```csv
HZK17176KEP_G,"Hentzen 17176KEP/16709CEH, Dark Green Epoxy Primer, MIL-PRF-23377 Type II Class N (QPL)","Hentzen's Dark Green Aerospace High Performance Primer 17176KEP/16709CEH, Chromate-Free. This Epoxy Primer has been formulated to have excellent corrosion resistance and meet all the performance requirements of the specification.",519.17,23.00,9.00,15.00,9.00,Yes,No,No,Yes,Manufacturing,true,17176KEP - 16709CEH,"MIL-PRF-23377K, TYPE II, CLASS N",,MIL-PRF-23377K Type II Class N,,90,"Hentzen 17176KEP, Dark Green Primer, MIL-PRF-23377 Type II (QPL)","Hentzen Dark Green Aerospace Primer 17176KEP/16709CEH. Chromate-free epoxy with excellent corrosion resistance. QPL MIL-PRF-23377.",hentzen-17176kep-mil-prf-23377-type-ii
```

---

## Output Requirements

1. Valid CSV format with proper quoting (quote fields containing commas)
2. UTF-8 encoding
3. Include header row
4. One product per line
5. No trailing commas
6. Empty fields should be empty (not "null" or "N/A")
