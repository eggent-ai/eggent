import { NextRequest } from "next/server";
import path from "path";
import { importKnowledge } from "@/lib/memory/knowledge";
import { getSettings } from "@/lib/storage/settings-store";

const DATA_DIR = path.join(process.cwd(), "data");

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { directory, subdir } = body;

    if (!directory) {
      return Response.json(
        { error: "Directory path is required" },
        { status: 400 }
      );
    }

    const settings = await getSettings();
    const memorySubdir = subdir || "main";

    // Resolve directory path
    const knowledgeDir = path.isAbsolute(directory)
      ? directory
      : path.join(DATA_DIR, "knowledge", directory);

    const result = await importKnowledge(knowledgeDir, memorySubdir, settings);

    return Response.json(result);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to import knowledge",
      },
      { status: 500 }
    );
  }
}
