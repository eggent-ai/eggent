import { NextRequest } from "next/server";
import {
  getProject,
  updateProject,
  deleteProject,
} from "@/lib/storage/project-store";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  return Response.json(project);
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const updated = await updateProject(id, body);
  if (!updated) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  return Response.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const deleted = await deleteProject(id);
  if (!deleted) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  return Response.json({ success: true });
}
