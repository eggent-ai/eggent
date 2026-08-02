import fs from "fs/promises";
import { NextRequest, NextResponse } from "next/server";
import {
  getProject,
  getProjectMcpServersPath,
  isOrchestratorScope,
  loadProjectMcpServers,
  saveProjectMcpServersContent,
} from "@/lib/storage/project-store";

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return "code" in error && (error as { code?: string }).code === "ENOENT";
}

/** The orchestrator owns a .mcp.json too, and it has no project.json to look up. */
async function scopeExists(id: string): Promise<boolean> {
  if (isOrchestratorScope(id)) return true;
  return Boolean(await getProject(id));
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!(await scopeExists(id))) {
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

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!(await scopeExists(id))) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const content =
    body && typeof body === "object" && "content" in body
      ? (body as { content?: unknown }).content
      : undefined;
  if (typeof content !== "string") {
    return NextResponse.json(
      { error: 'Field "content" must be a string.' },
      { status: 400 }
    );
  }

  const result = await saveProjectMcpServersContent(id, content);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({
    content: result.content,
    servers: result.servers,
  });
}
