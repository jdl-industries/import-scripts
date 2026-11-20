import * as fs from "node:fs";
import { parse } from "csv-parse/sync";
import type { AccountMateItem, AccountMateRecords } from "./accountMateTypes";

/**
 * Reads an AccountMate CSV export and indexes all items by SKU into a dictionary.
 */
export function readAccountMateExport(filePath: string): AccountMateRecords {
  // Read using latin1/windows-1252 to preserve symbols without UTF-8 decode faults
  const fileContent = fs.readFileSync(filePath, "latin1");

  const rows: AccountMateItem[] = parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
  });

  const records: AccountMateRecords = {};

  for (const row of rows) {
    if (!row["SKU"]) continue;
    records[row["SKU"]] = row;
  }

  return records;
}
