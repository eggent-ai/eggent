import { NextRequest, NextResponse } from "next/server";
import { getEggentAiModelLockState, getManagedProviderId } from "@/lib/pi/config-store";
import { readManagedTextCatalog } from "@/lib/pi/managed-models";
import { managedProjectSaveRefusal, maskProjectModelUnderLock } from "@/lib/pi/project-model-choice";
import { getProject, readProjectModelSettingsFile, saveProjectModelSettingsFile } from "@/lib/storage/project-store";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  const lock = await getEggentAiModelLockState();
  const content = lock.locked
    ? maskProjectModelUnderLock(await readProjectModelSettingsFile(id), (await getManagedProviderId()) || "eggent-ai")
    : await readProjectModelSettingsFile(id);
  return NextResponse.json({ content, path: "model.json", modelLock: lock });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  const lock = await getEggentAiModelLockState();
  const body = await req.json().catch(() => null) as { content?: unknown } | null;
  if (typeof body?.content !== "string") {
    return NextResponse.json({ error: 'Field "content" must be a string.' }, { status: 400 });
  }
  if (lock.locked) {
    const catalog = await readManagedTextCatalog();
    const refusal = managedProjectSaveRefusal(
      body.content,
      (await getManagedProviderId()) || "eggent-ai",
      catalog.map((model) => model.id)
    );
    if (refusal === "not_json") {
      return NextResponse.json({ error: "Project model settings must be valid JSON." }, { status: 400 });
    }
    if (refusal === "foreign_provider") {
      return NextResponse.json(
        { error: `This workspace runs on ${lock.label}, so a project can only choose among its models.` },
        { status: 403 }
      );
    }
    if (refusal === "unknown_model") {
      return NextResponse.json({ error: `${lock.label} does not offer that model.` }, { status: 403 });
    }
  }
  try {
    const content = await saveProjectModelSettingsFile(id, body.content);
    return NextResponse.json({ content, path: "model.json" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid model settings" }, { status: 400 });
  }
}
