import fs from "node:fs/promises";
import path from "node:path";
import { openPlainFile } from "@/lib/files/safe-open";
import { keyOfFile, projectsRootReal } from "@/lib/files/project-keys";
import { pathIsSensitive } from "@/lib/files/zip-walk";
import type { SheetCell } from "@/lib/google/types";

/**
 * Rows for a spreadsheet: given in the call, or read from a CSV file of the
 * workspace, so a table a script wrote goes into the sheet without passing
 * through the model a cell at a time.
 */

/** What one request to the service may carry, which is also what the service accepts. */
export const MAX_ROWS_BYTES = 900 * 1024;

export class RowsError extends Error {}

/** A cell as the spreadsheet takes it: text, a number, true or false, or empty. */
export function normalizeCell(value: unknown): SheetCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return JSON.stringify(value);
}

export function normalizeRows(value: unknown): SheetCell[][] {
  if (!Array.isArray(value)) throw new RowsError("rows is a list of rows, each a list of cells: [[\"Name\", \"Qty\"], [\"Desk\", 2]].");
  return value.map((row) => (Array.isArray(row) ? row.map(normalizeCell) : [normalizeCell(row)]));
}

/** RFC 4180, with the separator taken from the first line: a semicolon where it outnumbers commas, a tab in a .tsv. */
export function parseCsv(text: string, fileName = ""): string[][] {
  const body = text.replace(/^﻿/, "");
  const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
  const separator = /\.tsv$/i.test(fileName)
    ? "\t"
    : (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0)
      ? ";"
      : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quoted) {
      if (char === "\"") {
        if (body[index + 1] === "\"") {
          cell += "\"";
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === "\"" && cell === "") {
      quoted = true;
    } else if (char === separator) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && body[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const READ_FAILURES: Record<string, string> = {
  outside: "is not a file of this workspace's projects folder.",
  missing: "is not there.",
  sensitive: "holds credentials and is never sent.",
  tooLarge: `is larger than ${Math.floor(MAX_ROWS_BYTES / 1024)} KB; send it in parts.`,
  notFile: "is not a plain file.",
};

/** The rows of a CSV file of this workspace, read through a handle that follows no link. */
export async function rowsFromCsvFile(cwd: string, rawPath: string): Promise<string[][]> {
  const value = rawPath.trim();
  const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
  const fail = (reason: keyof typeof READ_FAILURES) => new RowsError(`${value} ${READ_FAILURES[reason]}`);
  const key = await keyOfFile(absolute);
  if (!key) throw fail("outside");
  if (pathIsSensitive(key)) throw fail("sensitive");
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat) throw fail("missing");
  if (!stat.isFile()) throw fail("notFile");
  if (stat.size > MAX_ROWS_BYTES) throw fail("tooLarge");
  const handle = await openPlainFile(absolute, { root: await projectsRootReal() });
  if (!handle) throw fail("notFile");
  try {
    const data = await handle.readFile();
    if (data.length > MAX_ROWS_BYTES) throw fail("tooLarge");
    return parseCsv(data.toString("utf-8"), absolute);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Throws when rows would not fit in one request. */
export function assertRowsFit(rows: SheetCell[][]): void {
  if (Buffer.byteLength(JSON.stringify(rows), "utf-8") > MAX_ROWS_BYTES) {
    throw new RowsError(`These rows are more than ${Math.floor(MAX_ROWS_BYTES / 1024)} KB; append them in parts.`);
  }
}
