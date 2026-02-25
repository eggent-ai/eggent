import fs from "fs/promises";
import path from "path";
import mammoth from "mammoth";
import type { LoadedDocument } from "./index";

/**
 * Load DOCX (Word) document and extract plain text for vectorization.
 */
export async function loadDocx(filePath: string): Promise<LoadedDocument> {
    const buffer = await fs.readFile(filePath);
    const result = await mammoth.extractRawText({ buffer });

    return {
        text: result.value.trim(),
        metadata: {
            source: filePath,
            type: "docx",
            filename: path.basename(filePath),
        },
    };
}
