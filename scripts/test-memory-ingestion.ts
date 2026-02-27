
import path from "path";
import fs from "fs/promises";
import { importKnowledge, queryKnowledge } from "../src/lib/memory/knowledge";
import { AppSettings } from "../src/lib/types";

// Mock settings
const mockSettings: AppSettings = {
    chatModel: { provider: "openai", model: "gpt-4o" },
    utilityModel: { provider: "openai", model: "gpt-4o-mini" },
    multimediaModel: { provider: "openai", model: "gpt-4o" },
    embeddingsModel: {
        provider: "mock",
        model: "text-embedding-3-small",
        // Assumes OPENAI_API_KEY is set in env
    },
    codeExecution: { enabled: false, timeout: 30, maxOutputLength: 1000 },
    memory: {
        enabled: true,
        similarityThreshold: 0.1, // Low threshold for testing
        maxResults: 5,
        chunkSize: 400,
    },
    search: { enabled: false, provider: "none" },
    general: { darkMode: true, language: "en" },
    auth: {
        enabled: true,
        username: "admin",
        passwordHash: "",
        mustChangeCredentials: false,
    },
};

async function main() {
    console.log("Starting Memory Ingestion Test...");

    const testDir = path.join(process.cwd(), "data", "test-knowledge");
    const testSubdir = "test-project-memory";

    // 1. Setup Test Environment
    console.log("Setting up test directory:", testDir);
    await fs.mkdir(testDir, { recursive: true });

    // 2. Create Test Files
    // Text file
    await fs.writeFile(path.join(testDir, "test.txt"), "The secret code for the project is ALPHA-BETA-GAMMA. It is very confidential.");
    console.log("Created test.txt");

    // PDF & Image would require real files to test properly, 
    // but we can at least test the text loader and the import logic.
    // We'll skip creating dummy PDFs/Images for this automated run to avoid binary complexity,
    // relying on the text test to prove the pipeline works.

    // 3. Import Knowledge
    console.log("Importing knowledge...");
    const result = await importKnowledge(testDir, testSubdir, mockSettings);
    console.log("Import result:", result);

    if (result.errors.length > 0) {
        console.error("Import errors:", result.errors);
    }

    // 4. Query Knowledge
    console.log("Querying knowledge...");
    const query = "What is the secret code?";
    const answer = await queryKnowledge(query, 3, [testSubdir], mockSettings);
    console.log(`Query: "${query}"`);
    console.log("Result:", answer);

    // 5. Cleanup
    console.log("Cleaning up...");
    await fs.rm(testDir, { recursive: true, force: true });
    // We might want to keep the vector DB for inspection, but strict cleanup removes it too.
    // const memoryDir = path.join(process.cwd(), "data", "memory", testSubdir);
    // await fs.rm(memoryDir, { recursive: true, force: true });

    console.log("Test Complete.");
}

main().catch(console.error);
