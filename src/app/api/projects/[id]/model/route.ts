import { NextRequest, NextResponse } from "next/server";
import { getProject, readProjectModelSettingsFile, saveProjectModelSettingsFile } from "@/lib/storage/project-store";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  const content = await readProjectModelSettingsFile(id);
  return NextResponse.json({ content, path: "model.json" });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  const body = await req.json().catch(() => null) as { content?: unknown } | null;
  if (typeof body?.content !== "string") {
    return NextResponse.json({ error: 'Field "content" must be a string.' }, { status: 400 });
  }
  try {
    const content = await saveProjectModelSettingsFile(id, body.content);
    return NextResponse.json({ content, path: "model.json" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid model settings" }, { status: 400 });
  }
}
