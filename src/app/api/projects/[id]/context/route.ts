import { NextRequest, NextResponse } from "next/server";
import {
  GLOBAL_PROJECT_ID,
  getProject,
  isOrchestratorScope,
  readProjectContext,
  saveOrchestratorContext,
  saveProjectContext,
} from "@/lib/storage/project-store";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isOrchestratorScope(id)) {
    const project = await getProject(id);
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const content = await readProjectContext(id);
  return NextResponse.json({ content, path: "context.md" });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => null) as { content?: unknown } | null;
  if (typeof body?.content !== "string") {
    return NextResponse.json({ error: 'Field "content" must be a string.' }, { status: 400 });
  }
  if (isOrchestratorScope(id)) {
    await saveOrchestratorContext(body.content);
    return NextResponse.json({ content: body.content, path: "context.md", scope: GLOBAL_PROJECT_ID });
  }
  const project = await saveProjectContext(id, body.content);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  return NextResponse.json({ content: project.instructions, path: "context.md", project });
}
