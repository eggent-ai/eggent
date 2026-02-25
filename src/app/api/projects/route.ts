import { NextRequest } from "next/server";
import { getAllProjects, createProject } from "@/lib/storage/project-store";

export async function GET() {
  const projects = await getAllProjects();
  return Response.json(projects);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, description, instructions, memoryMode } = body;

    if (!name || typeof name !== "string") {
      return Response.json(
        { error: "Project name is required" },
        { status: 400 }
      );
    }

    // Generate URL-safe ID from name
    const id = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      || crypto.randomUUID().slice(0, 8);

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
          error instanceof Error ? error.message : "Failed to create project",
      },
      { status: 500 }
    );
  }
}
