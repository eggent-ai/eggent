import type {
  PipelineDefinition,
  PipelineStepDefinition,
  PipelineStepRun,
} from "@/lib/pipelines/types";

function formatPreviousSteps(steps: PipelineStepRun[]): string {
  if (steps.length === 0) return "No previous steps.";
  return steps
    .map((step) => {
      const artifacts = step.artifacts?.length
        ? `\nArtifacts:\n${step.artifacts.map((artifact) => `- ${artifact}`).join("\n")}`
        : "";
      return `## ${step.name}\nStatus: ${step.status}\nSummary:\n${step.summary || "No summary."}${artifacts}`;
    })
    .join("\n\n");
}

export function buildPipelineStepPrompt(options: {
  pipeline: PipelineDefinition;
  step: PipelineStepDefinition;
  userInput: string;
  artifactsDir: string;
  previousSteps: PipelineStepRun[];
}): string {
  return [
    "You are one agent inside an Eggent pipeline powered by pi SDK.",
    "",
    `Pipeline: ${options.pipeline.name}`,
    options.pipeline.description ? `Pipeline description: ${options.pipeline.description}` : "",
    "",
    "Original user request:",
    options.userInput,
    "",
    `Current step: ${options.step.name}`,
    options.step.projectId ? `This step runs Eggent project/pi-agent config: ${options.step.projectId}` : "This step runs the pipeline's active Eggent project/pi-agent config.",
    options.step.skills?.length ? `Preferred skills for this step: ${options.step.skills.join(", ")}` : "",
    "Step handoff instructions:",
    options.step.instructions,
    "",
    `Artifacts directory: ${options.artifactsDir}`,
    "",
    "Previous step results:",
    formatPreviousSteps(options.previousSteps),
    "",
    "Architecture rules:",
    "- Each pipeline step is an Eggent project used as a pi agent configuration.",
    "- The project's context.md, memory.md, skills/, mcp.json, cron.json, and model.json configure that pi agent.",
    "- RAG/knowledge-base handoff is not used; pass state through artifact files and the project's memory.md file.",
    "- Treat the artifacts directory as the handoff boundary between project agents.",
    "- Save important intermediate and final outputs as files in the artifacts directory.",
    "- Read previous artifacts when needed instead of asking the user to repeat information.",
    "- Finish with a concise summary of what you did and which files you created or changed.",
  ]
    .filter(Boolean)
    .join("\n");
}
