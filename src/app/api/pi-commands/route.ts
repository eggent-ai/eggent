import path from "path";
import { NextRequest } from "next/server";
import { createEggentPiSession } from "@/lib/pi/session";
import { loadProjectSkillsMetadata } from "@/lib/storage/project-store";

export const runtime = "nodejs";
export const maxDuration = 60;

function sourceLabel(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["label", "source", "location", "kind"]) {
    const item = record[key];
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return undefined;
}

export async function GET(req: NextRequest) {
  let session: Awaited<ReturnType<typeof createEggentPiSession>> | undefined;
  try {
    const projectParam = req.nextUrl.searchParams.get("projectId");
    const projectId = projectParam && projectParam !== "none" ? projectParam : undefined;
    const currentPath = req.nextUrl.searchParams.get("currentPath") || undefined;

    session = await createEggentPiSession({
      projectId,
      cwd: currentPath,
      enableEggentTools: false,
    });

    // Eggent slash menu should expose only skills installed into the selected
    // Eggent project. The Pi runtime may also load user/global package skills
    // (for example pi-web-access's librarian) for model auto-invocation, but
    // those are implementation details and should not appear as explicit UI
    // commands in Eggent.
    const projectSkillFilePaths = new Set(
      projectId
        ? (await loadProjectSkillsMetadata(projectId)).map((skill) =>
            path.resolve(skill.skillDir, "SKILL.md")
          )
        : []
    );

    const skills = session.resourceLoader.getSkills().skills
      .filter((skill) => projectSkillFilePaths.has(path.resolve(skill.filePath)))
      .map((skill) => ({
        name: `skill:${skill.name}`,
        title: skill.name,
        description: skill.description,
        source: "skill" as const,
        location: sourceLabel(skill.sourceInfo),
        path: skill.filePath,
      }));

    const prompts = session.promptTemplates.map((prompt) => ({
      name: prompt.name,
      title: prompt.name,
      description: prompt.description,
      argumentHint: prompt.argumentHint,
      source: "prompt" as const,
      location: sourceLabel(prompt.sourceInfo),
      path: prompt.filePath,
    }));

    return Response.json({ commands: [...skills, ...prompts] });
  } catch (error) {
    console.error("Slash commands API error:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to load commands" },
      { status: 500 }
    );
  } finally {
    session?.dispose();
  }
}
