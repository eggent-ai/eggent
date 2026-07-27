import { NextRequest } from "next/server";
import {
  getProject,
  updateProject,
  deleteProject,
} from "@/lib/storage/project-store";
import { getServerTranslator } from "@/i18n/server";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const t = await getServerTranslator(_req.headers.get("accept-language"));
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return Response.json({ error: t("api.error.projectNotFound") }, { status: 404 });
  }
  return Response.json(project);
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  const { id } = await params;
  const body = await req.json();
  const updated = await updateProject(id, body);
  if (!updated) {
    return Response.json({ error: t("api.error.projectNotFound") }, { status: 404 });
  }
  return Response.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const t = await getServerTranslator(_req.headers.get("accept-language"));
  const { id } = await params;
  const deleted = await deleteProject(id);
  if (!deleted) {
    return Response.json({ error: t("api.error.projectNotFound") }, { status: 404 });
  }
  return Response.json({ success: true });
}
