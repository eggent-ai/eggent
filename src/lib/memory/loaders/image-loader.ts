import path from "path";
import fs from "fs/promises";
import { createWorker } from "tesseract.js";
import type { LoadedDocument } from "./index";

/**
 * Absolute path to Tesseract Node worker script.
 * We use process.cwd() because require.resolve() is aliased by Next.js to "(rsc)/...", which is invalid for Worker.
 */
function getTesseractWorkerPath(): string {
    return path.join(
        process.cwd(),
        "node_modules",
        "tesseract.js",
        "src",
        "worker-script",
        "node",
        "index.js"
    );
}

export async function loadImage(filePath: string): Promise<LoadedDocument> {
    const buffer = await fs.readFile(filePath);
    const worker = await createWorker("eng", 1, {
        workerPath: getTesseractWorkerPath(),
        logger: () => {},
    });

    try {
        const {
            data: { text },
        } = await worker.recognize(buffer);
        return {
            text: text.trim(),
            metadata: {
                source: filePath,
                type: "image",
            },
        };
    } finally {
        await worker.terminate();
    }
}
