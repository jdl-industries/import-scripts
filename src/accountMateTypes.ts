/**
 * Raw string record representing the exact column names exported from AccountMate.
 */
export interface AccountMateItem {
  SKU: string;
  Series: string;
  Manufacturer: string;
  "Vendor part number": string;
  "NSN number": string;
  "Short description": string;
  Description: string;
  Color: string;
  QPL: string;
  "Meets specs": string;
  "Color specs": string;
  "Lead time": string;
  Taxable: string;
  "Backorders allowed": string;
  "On hand": string;
  "Weight (lbs)": string;
  "Length (in)": string;
  "Width (in)": string;
  "Height (in)": string;
  Price: string;
  Categories: string;
  "Tier price": string;
  Image: string;
  "Unit of measure": string;
  "Vendor UPC": string;
  "Barcode 1": string;
  "Barcode 2": string;
  Aviation: string;
  Marine: string;
  Industrial: string;
  Hazardous: string;
  "Hazardous charge": string;
  "Needs special pkg": string;
  "Spedial pkg price": string; // AccountMate export typo preserved
  "Needs dry ice": string;
  "Dry ice charge": string;
  Family: string;
  "Surcharge percent": string;
  "Surcharge amount": string;
  Cost: string;
  "On order qty": string;
  "Booked qty": string;
  "Expected rcv date": string;
  "Min order qty": string;
}

/** Primary SKU-keyed dictionary for O(1) comparison and lookup */
export type AccountMateRecords = Record<string, AccountMateItem>;
