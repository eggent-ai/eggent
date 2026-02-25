
import fs from "fs/promises";
import { LoadedDocument } from "./index";

// Define strict types for the local variables to avoid "any"
/* eslint-disable @typescript-eslint/no-explicit-any */

export async function loadPdf(filePath: string): Promise<LoadedDocument> {
    const dataBuffer = await fs.readFile(filePath);

    // Convert Buffer to Uint8Array which pdfjs expects
    const uint8Array = new Uint8Array(dataBuffer);

    // Dynamic import to avoid build issues with canvas
    // Use legacy build for better Node.js support without canvas
    // @ts-ignore
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.js");

    // Set up a fake worker to avoid worker file loading issues in Node
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        pdfjs.GlobalWorkerOptions.workerSrc = ""; // Disable worker loading
    }

    const loadingTask = pdfjs.getDocument({
        data: uint8Array,
        useSystemFonts: true, // Attempt to use system fonts to avoid some font errors
        disableFontFace: true, // Disable font face loading to avoid some parsing errors
    });

    const doc = await loadingTask.promise;
    const numPages = doc.numPages;
    let fullText = "";

    const info = (await doc.getMetadata()).info;

    for (let i = 1; i <= numPages; i++) {
        const page = await doc.getPage(i);
        const textContent = await page.getTextContent();

        const pageText = textContent.items
            .map((item: any) => item.str)
            .join(" ");

        fullText += pageText + "\n\n";
    }

    return {
        text: fullText.trim(),
        metadata: {
            source: filePath,
            type: "pdf",
            pages: numPages,
            info: info,
        },
    };
}
