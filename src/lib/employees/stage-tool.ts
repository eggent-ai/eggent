/**
 * eggent_stage: the agent says what stage of the work it is at, and what it
 * found there, so the screen can show the work as it happens instead of a list
 * of tool calls. Every workspace has it; a skill decides when to use it.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { normalizePlan, normalizeStage, STAGE_TOOL } from "@/lib/employees/stage";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

/** The picture's path relative to the working folder, or the reason it cannot be shown. */
async function checkImage(cwd: string, asked: string): Promise<{ relative: string } | { error: string }> {
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, asked.replace(/^\.\//, ""));
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return { error: "image must be a file inside your working folder." };
  if (!IMAGE_EXTENSIONS.has(path.extname(absolute).toLowerCase())) return { error: "image must be a .png, .jpg, .webp or .gif file." };
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat?.isFile()) return { error: `image ${asked} is not there; save the picture first.` };
  return { relative: path.relative(root, absolute) };
}

const Tone = Type.Optional(Type.Union([Type.Literal("good"), Type.Literal("bad"), Type.Literal("neutral")]));

export function createStageTool(options: { cwd?: string }) {
  return defineTool({
    name: STAGE_TOOL,
    label: "Stage",
    promptSnippet: "show the person which stage of the work you are at and what you found there",
    description:
      "Show the person the stage of the work you are at, as a step on their screen with a picture, a number, a table or cards. Call it when a stage starts (status running, with detail saying what you are doing) and again when it ends (status done, or warn when you found a problem), with what you found. Use the same id for both calls; a later call keeps what an earlier one said unless it replaces it. The first call may carry plan: every stage ahead, so the person sees the whole path. A picture is a file you saved in your working folder (a browser screenshot, a generated image). Write titles, details and verdicts in the person's language, short and plain, about their business - never about tools. Use it only when a skill asks for stages. It is a tool of your own: call it directly, never through mcp. Leave out a field you have nothing real for (no stat without a figure).",
    parameters: Type.Object({
      id: Type.String({ description: "Short stable id of the stage, e.g. site, search, rivals." }),
      title: Type.Optional(Type.String({ description: "The stage's name, a few words." })),
      status: Type.Optional(Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("warn")])),
      detail: Type.Optional(Type.String({ description: "One line: what you are doing now, or what you found." })),
      plan: Type.Optional(Type.Array(Type.Object({ id: Type.String(), title: Type.String() }), { description: "All stages ahead, in order; only on the first call." })),
      image: Type.Optional(Type.String({ description: "A picture in your working folder to show big." })),
      caption: Type.Optional(Type.String()),
      stat: Type.Optional(Type.Object({ value: Type.String({ description: "A short figure, e.g. 3 из 5, 2,5 с, 38/100." }), label: Type.Optional(Type.String()), tone: Tone })),
      table: Type.Optional(Type.Object({ columns: Type.Array(Type.String()), rows: Type.Array(Type.Array(Type.String())) })),
      cards: Type.Optional(Type.Array(Type.Object({ title: Type.String(), body: Type.Optional(Type.String()), badge: Type.Optional(Type.String()), tone: Tone }))),
      verdict: Type.Optional(Type.Object({ text: Type.String({ description: "The finding in one sentence, plainly." }), tone: Tone })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const cwd = options.cwd || ctx?.cwd || path.join(process.cwd(), "data", "projects");
      const stage = normalizeStage(params);
      if (!stage) return textResult(JSON.stringify({ success: false, error: "id is a short word of letters, digits, - or _." }));
      const problems: string[] = [];
      if (stage.image) {
        const checked = await checkImage(cwd, stage.image);
        if ("error" in checked) {
          problems.push(checked.error);
          delete stage.image;
        } else {
          stage.image = checked.relative;
        }
      }
      const plan = normalizePlan(params.plan);
      return textResult(
        JSON.stringify({ success: true, stage, ...(plan.length ? { plan } : {}), ...(problems.length ? { problems } : {}) }),
        { stage }
      );
    },
  });
}
