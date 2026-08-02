import { NextRequest } from "next/server";
import {
  createProject,
  getAllProjects,
  isReservedProjectId,
} from "@/lib/storage/project-store";
import { getServerTranslator } from "@/i18n/server";

export async function GET() {
  const projects = await getAllProjects();
  return Response.json(projects);
}

export async function POST(req: NextRequest) {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  try {
    const body = await req.json();
    const { name, description, instructions, memoryMode } = body;

    if (!name || typeof name !== "string") {
      return Response.json(
        { error: t("api.error.projectNameRequired") },
        { status: 400 }
      );
    }

    // Generate URL-safe ID from name
    const id = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      || crypto.randomUUID().slice(0, 8);

    // The orchestrator's own files live in data/projects itself, so a project
    // may not claim "none" or any name those files already occupy.
    if (isReservedProjectId(id)) {
      return Response.json(
        { error: t("projects.errors.reservedName", { name }) },
        { status: 400 }
      );
    }

    const project = await createProject({
      id,
      name,
      description: description || "",
      instructions: instructions || "",
      memoryMode: memoryMode || "global",
    });

    return Response.json(project, { status: 201 });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : t("projects.errors.create"),
      },
      { status: 500 }
    );
  }
}
