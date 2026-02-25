import { NextRequest } from "next/server";
import {
  searchMemory,
  insertMemory,
  deleteMemoryById,
  getAllMemories,
} from "@/lib/memory/memory";
import { getSettings } from "@/lib/storage/settings-store";

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("query");
  const subdir = req.nextUrl.searchParams.get("subdir") || "main";
  const limit = parseInt(req.nextUrl.searchParams.get("limit") || "20");

  if (query) {
    const settings = await getSettings();
    const results = await searchMemory(
      query,
      limit,
      settings.memory.similarityThreshold,
      subdir,
      settings
    );
    return Response.json(results);
  }

  // Return all memories for dashboard
  const memories = await getAllMemories(subdir);
  return Response.json(memories);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { text, area, subdir } = body;

    if (!text) {
      return Response.json({ error: "Text is required" }, { status: 400 });
    }

    const settings = await getSettings();
    const id = await insertMemory(
      text,
      area || "main",
      subdir || "main",
      settings
    );

    return Response.json({ id, success: true }, { status: 201 });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to save memory",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  const subdir = req.nextUrl.searchParams.get("subdir") || "main";

  if (!id) {
    return Response.json({ error: "Memory ID required" }, { status: 400 });
  }

  const deleted = await deleteMemoryById(id, subdir);
  if (!deleted) {
    return Response.json({ error: "Memory not found" }, { status: 404 });
  }

  return Response.json({ success: true });
}
