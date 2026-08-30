import fs from "fs/promises";
import path from "path";
import type {
  PipelineDefinition,
  PipelineDefinitionFile,
  PipelineRun,
  RawPipelineDefinition,
  RawPipelineStepDefinition,
} from "@/lib/pipelines/types";
import { publishUiSyncEvent } from "@/lib/realtime/event-bus";
import { SLUG_EXTRA_CHARACTERS } from "@/i18n/vocabulary";

const DATA_DIR = path.join(process.cwd(), "data");
const PIPELINES_FILE = path.join(DATA_DIR, "pipelines", "main", "defs.json");
const RUNS_DIR = path.join(DATA_DIR, "pipeline-runs");

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(new RegExp(`[^a-z0-9${SLUG_EXTRA_CHARACTERS}]+`, "gi"), "-")
    .replace(/^-+|-+$/g, "");
  return slug || crypto.randomUUID();
}

function normalizeStep(step: RawPipelineStepDefinition): PipelineDefinition["steps"][number] {
  return {
    id: step.id || slugify(step.name),
    name: step.name,
    projectId: step.projectId,
    instructions: step.instructions || "Run this Eggent project as the next pi agent in the pipeline. Use previous artifacts as input and save your handoff output in the artifacts directory.",
    cwd: step.cwd,
    tools: step.tools,
    skills: step.skills,
    output: step.output,
    approvalRequired: step.approvalRequired,
  };
}

function normalizePipeline(pipeline: RawPipelineDefinition): PipelineDefinition {
  const now = new Date().toISOString();
  return {
    id: pipeline.id || slugify(pipeline.name),
    name: pipeline.name,
    description: pipeline.description,
    steps: pipeline.steps.map(normalizeStep),
    createdAt: pipeline.createdAt || now,
    updatedAt: pipeline.updatedAt || pipeline.createdAt || now,
  };
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function getPipelineDefinitions(): Promise<PipelineDefinition[]> {
  try {
    const raw = await fs.readFile(PIPELINES_FILE, "utf-8");
    const parsed = JSON.parse(raw) as PipelineDefinitionFile;
    return Array.isArray(parsed.pipelines) ? parsed.pipelines.map(normalizePipeline) : [];
  } catch {
    return [];
  }
}

export async function savePipelineDefinitions(pipelines: PipelineDefinition[]): Promise<void> {
  await ensureDir(path.dirname(PIPELINES_FILE));
  const payload: PipelineDefinitionFile = {
    version: 1,
    pipelines,
  };
  await fs.writeFile(PIPELINES_FILE, JSON.stringify(payload, null, 2), "utf-8");
  publishUiSyncEvent({ topic: "pipelines", reason: "pipeline_definitions_saved" });
}

export async function upsertPipelineDefinition(input: RawPipelineDefinition): Promise<PipelineDefinition> {
  const pipelines = await getPipelineDefinitions();
  const normalized = normalizePipeline({
    ...input,
    id: input.id || slugify(input.name),
    createdAt: input.createdAt,
    updatedAt: new Date().toISOString(),
  });
  const index = pipelines.findIndex(
    (pipeline) => pipeline.id === normalized.id || pipeline.name === normalized.name
  );
  if (index >= 0) {
    normalized.createdAt = pipelines[index].createdAt;
    pipelines[index] = normalized;
  } else {
    pipelines.push(normalized);
  }
  await savePipelineDefinitions(pipelines);
  return normalized;
}

export async function deletePipelineDefinition(idOrName: string): Promise<boolean> {
  const pipelines = await getPipelineDefinitions();
  const next = pipelines.filter(
    (pipeline) => pipeline.id !== idOrName && pipeline.name !== idOrName
  );
  if (next.length === pipelines.length) return false;
  await savePipelineDefinitions(next);
  return true;
}

export async function getPipelineDefinition(idOrName: string): Promise<PipelineDefinition | null> {
  const wanted = idOrName.trim();
  const pipelines = await getPipelineDefinitions();
  return (
    pipelines.find((pipeline) => pipeline.id === wanted || pipeline.name === wanted) ?? null
  );
}

export function getPipelineRunDir(runId: string): string {
  return path.join(RUNS_DIR, runId);
}

export function getPipelineRunArtifactsDir(runId: string): string {
  return path.join(getPipelineRunDir(runId), "artifacts");
}

export async function savePipelineRun(run: PipelineRun): Promise<void> {
  const runDir = getPipelineRunDir(run.id);
  await ensureDir(runDir);
  await fs.writeFile(path.join(runDir, "run.json"), JSON.stringify(run, null, 2), "utf-8");
  publishUiSyncEvent({
    topic: "pipelines",
    projectId: run.projectId ?? null,
    chatId: run.chatId,
    reason: `pipeline_run_${run.status}`,
  });
}

export async function getPipelineRun(runId: string): Promise<PipelineRun | null> {
  try {
    const raw = await fs.readFile(path.join(getPipelineRunDir(runId), "run.json"), "utf-8");
    return JSON.parse(raw) as PipelineRun;
  } catch {
    return null;
  }
}

export async function getPipelineRuns(): Promise<PipelineRun[]> {
  await ensureDir(RUNS_DIR);
  const entries = await fs.readdir(RUNS_DIR, { withFileTypes: true });
  const runs: PipelineRun[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const run = await getPipelineRun(entry.name);
    if (run) runs.push(run);
  }
  return runs.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}
