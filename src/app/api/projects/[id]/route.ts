import { NextRequest } from "next/server";
import {
  getProject,
  updateProject,
  deleteProject,
} from "@/lib/storage/project-store";
import { getCurrentUser } from "@/lib/auth/get-current-user";

/** Non-admin users can only access projects they own or shared projects. */
async function checkProjectAccess(projectOwnerId?: string, projectIsShared?: boolean) {
  const user = await getCurrentUser();
  if (!user || user.role === "admin") return null; // admins have full access
  if (!projectOwnerId) return null; // legacy projects without ownerId are accessible
  if (projectIsShared) return null;
  if (projectOwnerId === user.id) return null;
  return Response.json({ error: "Forbidden" }, { status: 403 });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  const forbidden = await checkProjectAccess(project.ownerId, project.isShared);
  if (forbidden) return forbidden;
  return Response.json(project);
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  const forbidden = await checkProjectAccess(project.ownerId, project.isShared);
  if (forbidden) return forbidden;
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
  const project = await getProject(id);
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  const forbidden = await checkProjectAccess(project.ownerId, project.isShared);
  if (forbidden) return forbidden;
  const deleted = await deleteProject(id);
  if (!deleted) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  return Response.json({ success: true });
}
