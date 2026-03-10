# Shopify Product Catalog Import Specification

## Overview

This document defines how to transform product data exported from WooCommerce into a Shopify-compatible CSV format. The transformation uses an LLM to generate SEO-optimized titles, descriptions, and metadata.

## Source Data Format

The input is a WooCommerce product export CSV with the following relevant columns/attributes:

| Source Location | Data |
|----------------|------|
| Column: SKU | Product SKU |
| Column: Name | Product name |
| Column: Short description | Contains mil spec, QPL info, color specs (HTML formatted) |
| Column: Description | Full product description (HTML formatted) |
| Column: Regular price | Product price |
| Column: Weight (lbs) | Product weight |
| Column: Length (in) | Product length |
| Column: Width (in) | Product width |
| Column: Height (in) | Product height |
| Attribute: Manufacturer | Manufacturer name (e.g., "HENTZEN") |
| Attribute: Vendor SKU | Manufacturer part number |
| Attribute: Barcode1 | Often contains NSN (National Stock Number) |
| Attribute: Hazardous | "Yes" or "No" |
| Attribute: Aviation | "Yes" or "No" |
| Attribute: Marine | "Yes" or "No" |
| Attribute: Industrial | "Yes" or "No" |
| Attribute: Special packaging | "Yes" or "No" |
| Attribute: Lead time | Lead time description (e.g., "30 business days", "Available from stock") |

Note: QPL and Military Specification info is embedded in HTML within Short description and Description fields, typically formatted as:
- `<strong><i>QPL:</i></strong> MIL-PRF-23377K, TYPE II, CLASS N`
- `<strong><i>Meets the requirements of:</i></strong> MIL-PRF-22750G TY II CL H GR A`

---

## Output Fields

### SKU
- **Source:** Column "SKU"
- **Transform:** Copy directly
- **Example:** `HZ08609TUZ-ULVOC-G1`

---

### Title
- **Source:** Synthesized from Manufacturer attribute, Vendor SKU, Short description, and extracted mil spec info
- **Format:** `{Title-Cased Manufacturer} {Part Number(s)}, {Short Product Description}, {MIL-SPEC} {Type} {Class} {(QPL) if applicable}`
- **Example:** `Hentzen 17176KEP/16709CEH, Non-Chrome Epoxy Primer Low IR, MIL-PRF-23377 Type II (QPL)`
- **Notes:**
  - Manufacturer name should be title-cased (e.g., "HENTZEN" → "Hentzen")
  - If multiple part numbers exist, separate with slash
  - Include "(QPL)" suffix only if product has QPL qualification

---

### Description
- **Source:** Description column, Short description column, Hentzen website (if clarification needed)
- **Transform:** Rewrite to be human-readable and SEO-optimized. Remove HTML formatting. Make it professional and concise.
- **Example:** `Hentzen's Dark Green Aerospace High Performance Primer 17176KEP/16709CEH, Chromate-Free. This Epoxy Primer has been formulated to have excellent corrosion resistance and meet all the performance requirements of the specification.`

---

### Regular Price
- **Source:** Column "Regular price"
- **Transform:** Copy directly

---

### Weight
- **Source:** Column "Weight (lbs)"
- **Transform:** Copy directly

---

### Length
- **Source:** Column "Length (in)"
- **Transform:** Copy directly

---

### Width
- **Source:** Column "Width (in)"
- **Transform:** Copy directly

---

### Height
- **Source:** Column "Height (in)"
- **Transform:** Copy directly

---

### Aviation
- **Source:** Attribute "Aviation"
- **Transform:** Copy value ("Yes" or "No")

---

### Marine
- **Source:** Attribute "Marine"
- **Transform:** Copy value ("Yes" or "No")

---

### Industrial
- **Source:** Attribute "Industrial"
- **Transform:** Copy value ("Yes" or "No")

---

### Special Packaging
- **Source:** Attribute "Special packaging"
- **Transform:** Copy value ("Yes" or "No")

---

### Category
- **Value:** `Manufacturing` (within Business and Industrial)
- **Transform:** Static value for all products

---

### Is Hazmat (metafield)
- **Source:** Attribute "Hazardous"
- **Transform:** `true` if "Yes", `false` if "No"

---

### Manufacturer Part Number (metafield)
- **Source:** Attribute "Vendor SKU"
- **Transform:** Copy directly
- **Example:** `17176KEP - 16709CEH`

---

### QPL (metafield)
- **Source:** Extract from Short description or Description fields
- **Transform:** Extract the full specification string following "QPL:" tag. Only populate if an actual specification is defined (the presence of just "QPL:" without a specification is insufficient).
- **Example:** `MIL-PRF-23377K, TYPE II, CLASS N`

---

### NSN (metafield)
- **Source:** Attribute "Barcode1", or extracted from Description if prefixed with "NSN"
- **Transform:** Extract NSN number (format: XXXX-XX-XXX-XXXX)
- **Example:** `8010-01-582-7280`

---

### Military Specification (metafield)
- **Source:** Extract from Short description or Description fields
- **Format:** `MIL-{type}-{number}{version} {Type X} {Class X}`
  - Type is typically: PRF, SPEC, DTL, C, etc.
  - Version is an optional letter suffix (e.g., K, E, F)
  - Type and Class are optional qualifiers
- **Example:** `MIL-PRF-23377K, Type II, Class N`

---

### Compliance and Certifications (metafield)
- **Source:** Extract from Short description or Description fields
- **Transform:** Capture any non-MIL spec certifications, approvals, or compliance standards. This includes:
  - OEM specifications (e.g., "BMS10-11 Type I Class A Grade B", "FMS-1027 Type V")
  - Industry standards (e.g., "MEP 10-059 Type II", "MEP 10-070")
  - Manufacturer qualifications (e.g., "LMCO EMAP", "LMCO FQML-P-23377-7")
  - "Meets the requirements of" specifications
- **Format:** Semicolon-separated list if multiple certifications exist
- **Example:** `BMS10-11 Type I Class A Grade B; MEP 10-059 Type II; LMCO EMAP`

---

### Lead Time (metafield)
- **Source:** Attribute "Lead time"
- **Transform:** Extract integer number of business days. If "Available from stock", use `0`.
- **Example:** `30` (from "30 business days")

---

### Page Title (SEO)
- **Source:** Generated from Title field
- **Transform:** Shortened version of Title, max 70 characters. Abbreviate the product description portion if needed while keeping manufacturer, part number, and mil spec.
- **Examples:**
  - `Hentzen 17176KEP, Low IR Epoxy Primer, MIL-PRF-23377 Type II (QPL)`
  - `Hentzen AD9318-FD, Fast Dry Epoxy Primer, MIL-PRF-23377 Type I (QPL)`

---

### Meta Description (SEO)
- **Source:** Generated from Description field
- **Transform:** Concise version of Description, max 160 characters. Focus on key product attributes and benefits.
- **Example:** `Hentzen's Dark Green Aerospace Primer 17176KEP/16709CEH. Chromate-free epoxy with excellent corrosion resistance. QPL MIL-PRF-23377 Type II Class N.`

---

### URL Handle
- **Source:** Generated from Manufacturer, Part Number, and Mil Spec
- **Format:** `{manufacturer}-{primary-part-number}-{mil-spec-number}-type-{type}`
- **Transform:** Lowercase, dash-separated, no special characters
- **Examples:**
  - `hentzen-17176kep-mil-prf-23377-type-ii`
  - `hentzen-ad9318-fd-mil-prf-23377-type-i`

---

## Output CSV Columns

The output CSV should contain these columns in order:

1. SKU
2. Title
3. Description
4. Regular Price
5. Weight
6. Length
7. Width
8. Height
9. Aviation
10. Marine
11. Industrial
12. Special Packaging
13. Category
14. Is Hazmat
15. Manufacturer Part Number
16. QPL
17. NSN
18. Military Specification
19. Compliance and Certifications
20. Lead Time
21. Page Title
22. Meta Description
23. URL Handle
