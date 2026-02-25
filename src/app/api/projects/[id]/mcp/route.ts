import fs from "fs/promises";
import { NextRequest, NextResponse } from "next/server";
import {
  getProject,
  getProjectMcpServersPath,
  loadProjectMcpServers,
} from "@/lib/storage/project-store";

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return "code" in error && (error as { code?: string }).code === "ENOENT";
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  try {
    const filePath = getProjectMcpServersPath(id);
    const [content, normalized] = await Promise.all([
      fs.readFile(filePath, "utf-8"),
      loadProjectMcpServers(id),
    ]);
    return NextResponse.json({
      content,
      servers: normalized?.servers ?? [],
    });
  } catch (error) {
    if (isNotFoundError(error)) {
      return NextResponse.json({ content: null, servers: [] });
    }
    return NextResponse.json(
      { error: "Failed to load MCP servers configuration" },
      { status: 500 }
    );
  }
}
