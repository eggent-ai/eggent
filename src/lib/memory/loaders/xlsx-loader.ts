import path from "path";
import fs from "fs/promises";
import * as XLSX from "xlsx";
import type { LoadedDocument } from "./index";

/**
 * Load Excel (.xlsx, .xls) file and convert sheets to text (CSV-style) for vectorization.
 * Reads file via fs to avoid path encoding issues (e.g. Cyrillic filenames).
 */
export async function loadXlsx(filePath: string): Promise<LoadedDocument> {
    const buffer = await fs.readFile(filePath);
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const parts: string[] = [];

    for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const text = XLSX.utils.sheet_to_txt(sheet, { FS: "\t", RS: "\n" });
        if (text.trim()) {
            parts.push(`[Sheet: ${sheetName}]\n${text}`);
        }
    }

    const fullText = parts.join("\n\n");

    return {
        text: fullText.trim(),
        metadata: {
            source: filePath,
            type: "xlsx",
            filename: path.basename(filePath),
            sheetCount: workbook.SheetNames.length,
        },
    };
}
