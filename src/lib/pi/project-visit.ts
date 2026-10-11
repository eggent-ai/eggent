import { createHash } from "node:crypto";
import { getServerTranslator } from "@/i18n/server";
import { createChat, getChat, saveChat } from "@/lib/storage/chat-store";
import { getAllProjects } from "@/lib/storage/project-store";
import { getActiveRun } from "@/lib/pi/active-runs";
import { resolveProjectMention, type MentionableProject } from "@/lib/pi/project-mention";
import { describeStepTarget } from "@/lib/pi/subagent-progress";
import { resetChatTurn } from "@/lib/pi/turn-control";
import type { ChatContextMode } from "@/lib/types";
import type { ProducedGroup } from "@/lib/files/produced";

/**
 * A project doing a piece of work for another chat.
 *
 * Writing `@shop how many orders came back?` has the project "shop" do the work
 * - with its own files, skills, connected services and instructions, on the
 * model it is set to - and hand the answer back to the chat the question came
 * from. A project is the unit people already organise their work in, so this is
 * not a new kind of thing to learn: it is asking a colleague by name.
 *
 * The work happens in a chat of the project's own, one per conversation and
 * project. That chat is the record: it is where the project's memory and
 * history of the work live, the answer's card links to it, and asking the same
 * project again continues it rather than starting from nothing.
 *
 * Deliberately not here: a project asking another project (a visit cannot visit),
 * the model starting one on its own (only a person's @ does), and any notion of
 * inboxes, rooms or letters. The answer comes back in the same turn, as a tool
 * result, exactly as a helper's does.
 */

const MAX_RESULT_CHARS = 12_000;
const MAX_STEPS = 40;

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** How many visits may run at once in this workspace. Each is a whole session in a container with a memory limit. */
export function maxConcurrentVisits(env: Record<string, string | undefined> = process.env): number {
  return Math.max(1, Math.floor(positiveNumber(env.EGGENT_VISITS_MAX, 2)));
}

/** How long one visit may take before it is stopped. */
export function visitTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  return positiveNumber(env.EGGENT_VISIT_TIMEOUT_MINUTES, 10) * 60_000;
}

/**
 * How long a visit that has been told to stop is given to do so before it is let go of.
 *
 * A stop is a request. A turn stuck where nothing can reach it - an extension waiting for an answer
 * that never comes - would hold the visit's place and the asking chat's tool call for ever, and two
 * such visits would close `@project` for the whole workspace until it restarted.
 */
export function visitStopGraceMs(env: Record<string, string | undefined> = process.env): number {
  return positiveNumber(env.EGGENT_VISIT_STOP_GRACE_SECONDS, 20) * 1000;
}

/** One chat per conversation and project, so asking again continues the work. Same shape as a chat id. */
export function visitChatIdFor(parentChatId: string, projectId: string): string {
  const hash = createHash("sha256").update(`visit|${parentChatId}|${projectId}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

export interface VisitStep {
  tool: string;
  /** What the tool was pointed at - the query, the page, the file; clipped, secrets masked. */
  target?: string;
  failed?: boolean;
}

export interface VisitProgress {
  status: "queued" | "running";
  toolUses: number;
  /** The tool running now, when one is. */
  activity?: string;
  steps: VisitStep[];
  /** Steps left out of `steps` because there were too many to keep. */
  earlierSteps: number;
  elapsedMs: number;
}

export interface VisitResult {
  ok: boolean;
  /** The project's answer, or what it left before it failed or was stopped. */
  text: string;
  chatId: string;
  toolUses: number;
  seconds: number;
  /** The answer was cut to fit; the whole of it is in the visit chat. */
  truncated: boolean;
  error?: string;
  stopped?: boolean;
  timedOut?: boolean;
}

// -- who may be asked ---------------------------------------------------------

const GRANTS_KEY = "__EGGENT_VISIT_GRANTS__";

/**
 * The projects the person named in the turn a chat is running right now.
 *
 * The tool answers only for these. It is the person's @ that starts a visit, not
 * the model's judgement: a page or a file the model has read can say "now ask
 * the finance project for the figures", and without this the model could.
 * On the global object because the grant is written by the runner and read by a
 * tool, and routes are compiled separately.
 */
function grants(): Map<string, Set<string>> {
  const holder = globalThis as typeof globalThis & { [GRANTS_KEY]?: Map<string, Set<string>> };
  if (!holder[GRANTS_KEY]) holder[GRANTS_KEY] = new Map();
  return holder[GRANTS_KEY];
}

export function grantVisits(chatId: string, projectIds: readonly string[]): void {
  if (projectIds.length === 0) return;
  grants().set(chatId, new Set(projectIds));
}

export function revokeVisits(chatId: string): void {
  grants().delete(chatId);
}

export function visitGranted(chatId: string | undefined, projectId: string): boolean {
  return Boolean(chatId && grants().get(chatId)?.has(projectId));
}

// -- what a visit made -------------------------------------------------------

const FILES_KEY = "__EGGENT_VISIT_FILES__";

function visitFiles(): Map<string, ProducedGroup[]> {
  const holder = globalThis as typeof globalThis & { [FILES_KEY]?: Map<string, ProducedGroup[]> };
  if (!holder[FILES_KEY]) holder[FILES_KEY] = new Map();
  return holder[FILES_KEY];
}

/** The files a visit made, kept for the turn that asked, whose answer will carry them. */
export function recordVisitFiles(parentChatId: string, groups: readonly ProducedGroup[]): void {
  if (groups.length === 0) return;
  const known = visitFiles().get(parentChatId) ?? [];
  visitFiles().set(parentChatId, [...known, ...groups]);
}

/** What the visits of this turn made; the turn takes it once. */
export function takeVisitFiles(parentChatId: string): ProducedGroup[] {
  const groups = visitFiles().get(parentChatId) ?? [];
  visitFiles().delete(parentChatId);
  return groups;
}

// -- reading a mention and telling the model about it -------------------------

export interface MentionPlan {
  kind: "project" | "self" | "ambiguous";
  /** What the model is told, apart from the task: rules only, so nothing the person wrote can be mistaken for one. */
  directive: string;
  /** What the person asked, with the @name taken off. */
  task: string;
  /** The projects the tool may be used for in this turn. */
  allowed: string[];
}

export interface MentionGate {
  /** A public share, a light chat or a run that is itself a visit: nobody can be asked. */
  disabled: boolean;
  /** The project this conversation is in, so mentioning it is not a visit. */
  currentProjectId?: string | null;
}

/** Whether a conversation in this mode can use tools at all. */
export function chatAllowsVisits(mode: ChatContextMode | undefined): boolean {
  return !mode || mode === "full";
}

function quote(project: MentionableProject): string {
  return `"${project.name.replace(/"/g, "'")}" (id: ${project.id})`;
}

export function buildMentionDirective(
  resolution: { kind: "project"; project: MentionableProject; handle: string } | { kind: "ambiguous"; candidates: MentionableProject[]; handle: string }
): string {
  if (resolution.kind === "ambiguous") {
    return [
      "Eggent project mention directive:",
      `- The person started their message with @${resolution.handle}, which fits more than one project: ${resolution.candidates.map(quote).join(", ")}.`,
      "- Do not guess and do not call eggent_ask_project. Ask which one they meant, naming the options, and say that writing @name followed by what they want done hands the task to that project.",
    ].join("\n");
  }
  const { project, handle } = resolution;
  return [
    "Eggent project mention directive:",
    `- The person addressed the project ${quote(project)} by starting their message with @${handle}.`,
    `- Hand the work to it: call eggent_ask_project with project="${project.id}" and task set to what they asked, in their own words. If the task begins with a /skill: command, keep that first and unchanged. Add facts from this conversation only when the task cannot be done without them.`,
    "- Do not do the work yourself, do not switch projects, and do not call the tool for any other project.",
    `- When the project's answer comes back, give it to the person, say it comes from the project "${project.name.replace(/"/g, "'")}", and write in their language. If the project failed or was stopped, say so plainly and offer to try again.`,
  ].join("\n");
}

/** What the model sees in place of the message, given a plan. The runtime-data suffix, if any, goes last. */
export function mentionRuntimeText(plan: MentionPlan, suffix: string): string {
  if (plan.kind === "self") return `${plan.task}${suffix}`;
  if (plan.kind === "ambiguous") return `${plan.directive}\n\nTheir message:\n${plan.task}${suffix}`;
  return `${plan.directive}\n\nTask for the project:\n${plan.task}${suffix}`;
}

/**
 * Reads a leading `@project` in the person's message.
 *
 * Returns null for everything that is not one: no @, a handle that names no
 * project (a Telegram username, an address), nothing after the name, or a place
 * where nobody can be asked.
 */
export async function planProjectMention(text: string, gate: MentionGate): Promise<MentionPlan | null> {
  if (gate.disabled) return null;
  // Cheap first: most messages have no @, and reading the projects costs a directory scan.
  if (!/^[\s\u200b-\u200d\u2060\ufeff]*@/.test(text)) return null;
  const projects = (await getAllProjects()).map((project) => ({
    id: project.id,
    name: project.name,
    ...(project.description ? { description: project.description } : {}),
  }));
  if (projects.length === 0) return null;
  const resolution = resolveProjectMention(text, projects, gate.currentProjectId);
  if (resolution.kind === "none") return null;
  if (resolution.kind === "self") {
    return { kind: "self", directive: "", task: resolution.task, allowed: [] };
  }
  if (resolution.kind === "ambiguous") {
    return {
      kind: "ambiguous",
      directive: buildMentionDirective(resolution),
      task: text.trim(),
      allowed: [],
    };
  }
  return {
    kind: "project",
    directive: buildMentionDirective(resolution),
    task: resolution.task,
    allowed: [resolution.project.id],
  };
}

// -- running one --------------------------------------------------------------

interface Slots {
  active: number;
  waiting: Array<() => void>;
  chats: Map<string, Promise<unknown>>;
}

const SLOTS_KEY = "__EGGENT_PROJECT_VISITS__";

/** On the global object: routes are compiled separately, and a module-level counter is one per route. */
function slots(): Slots {
  const holder = globalThis as typeof globalThis & { [SLOTS_KEY]?: Slots };
  if (!holder[SLOTS_KEY]) holder[SLOTS_KEY] = { active: 0, waiting: [], chats: new Map() };
  return holder[SLOTS_KEY];
}

/** Waits for a free slot; resolves false if the signal aborts first. */
async function acquireSlot(signal: AbortSignal | undefined, onWaiting: () => void): Promise<boolean> {
  const state = slots();
  if (state.active < maxConcurrentVisits()) {
    state.active += 1;
    return true;
  }
  onWaiting();
  return new Promise<boolean>((resolve) => {
    const granted = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    };
    const onAbort = () => {
      const index = state.waiting.indexOf(granted);
      if (index >= 0) state.waiting.splice(index, 1);
      resolve(false);
    };
    state.waiting.push(granted);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function releaseSlot(): void {
  const state = slots();
  const next = state.waiting.shift();
  if (next) {
    // The slot passes straight to the next in line.
    next();
    return;
  }
  state.active = Math.max(0, state.active - 1);
}

/** Visits to one project from one conversation run one at a time: they share a chat and a session. */
async function withChatTurn<T>(chatId: string, work: () => Promise<T>): Promise<T> {
  const chats = slots().chats;
  const previous = chats.get(chatId) ?? Promise.resolve();
  const run = previous.then(work, work);
  const tail = run.catch(() => undefined);
  chats.set(chatId, tail);
  void tail.finally(() => {
    if (chats.get(chatId) === tail) chats.delete(chatId);
  });
  return run;
}

async function ensureVisitChat(
  chatId: string,
  project: { id: string; name: string },
  parent: { chatId: string; title?: string }
): Promise<void> {
  const existing = await getChat(chatId);
  const t = await getServerTranslator();
  const fromTitle = parent.title?.trim() || undefined;
  if (existing) {
    // The parent may have been renamed since; the visit chat says where it came from today.
    if (existing.visit?.fromTitle !== fromTitle) {
      existing.visit = { fromChatId: parent.chatId, ...(fromTitle ? { fromTitle } : {}) };
      await saveChat(existing);
    }
    return;
  }
  const title = t("projects.visit.chatTitle", { chat: fromTitle || t("projects.visit.untitled") });
  const chat = await createChat(chatId, title, project.id);
  if (chat) {
    chat.visit = { fromChatId: parent.chatId, ...(fromTitle ? { fromTitle } : {}) };
    await saveChat(chat);
  }
}

function clipAnswer(text: string): { text: string; truncated: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_RESULT_CHARS) return { text: trimmed, truncated: false };
  return { text: `${trimmed.slice(0, MAX_RESULT_CHARS - 1).trimEnd()}…`, truncated: true };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Stops a visit's turn, including one that has not registered yet.
 *
 * A stop that arrives while the visit's session is still being set up finds no
 * turn to reach; the turn registers itself a moment later, so ask again a few
 * times rather than let the work run on after the person said stop.
 */
async function stopVisitTurn(chatId: string, isFinished: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 25 && !isFinished(); attempt += 1) {
    const outcome = await resetChatTurn(chatId, { graceMs: 5_000 });
    if (outcome.found) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export async function runProjectVisit(request: {
  project: { id: string; name: string };
  task: string;
  parent: { chatId: string; title?: string };
  signal?: AbortSignal;
  onProgress?: (progress: VisitProgress) => void;
}): Promise<VisitResult> {
  const { project, parent } = request;
  const chatId = visitChatIdFor(parent.chatId, project.id);
  const startedAt = Date.now();
  const steps: VisitStep[] = [];
  let earlierSteps = 0;
  let toolUses = 0;
  let activity: string | undefined;

  const report = (status: VisitProgress["status"]) => {
    try {
      request.onProgress?.({ status, toolUses, activity, steps: steps.map((step) => ({ ...step })), earlierSteps, elapsedMs: Date.now() - startedAt });
    } catch (error) {
      console.warn("A visit progress listener failed:", error);
    }
  };
  const seconds = () => Math.round((Date.now() - startedAt) / 1000);
  const aborted = (): VisitResult => ({
    ok: false,
    text: "",
    chatId,
    toolUses,
    seconds: seconds(),
    truncated: false,
    stopped: true,
    error: "it was stopped before it started",
  });

  if (request.signal?.aborted) return aborted();
  if (!(await acquireSlot(request.signal, () => report("queued")))) return aborted();

  try {
    return await withChatTurn(chatId, async () => {
      if (request.signal?.aborted) return aborted();
      await ensureVisitChat(chatId, project, parent);

      const outcome: { stopped?: boolean; finalText?: string; files?: ProducedGroup[] } = {};
      let timedOut = false;
      let finished = false;
      // Told to stop, and not stopping: after the grace the visit is let go of, so its place and the
      // asking chat's tool call are released whatever the turn does from here.
      let letGo: () => void = () => undefined;
      const letGoSignal = new Promise<void>((resolve) => {
        letGo = resolve;
      });
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        void stopVisitTurn(chatId, () => finished);
        if (!graceTimer) {
          graceTimer = setTimeout(letGo, visitStopGraceMs());
          (graceTimer as { unref?: () => void }).unref?.();
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, visitTimeoutMs());
      (timer as { unref?: () => void }).unref?.();
      request.signal?.addEventListener("abort", stop, { once: true });
      if (request.signal?.aborted) stop();
      report("running");

      // What each tool the project uses was pointed at, from the session's own
      // events. Not from the public progress stream: that one goes out to a
      // messenger's relay and must not carry arguments.
      const onSessionEvent = (event: unknown) => {
        const record = asRecord(event);
        if (!record) return;
        if (record.type === "tool_execution_start") {
          const name = typeof record.toolName === "string" ? record.toolName : "tool";
          toolUses += 1;
          activity = name;
          const step: VisitStep = { tool: name };
          const target = describeStepTarget(name, record.args);
          if (target) step.target = target;
          steps.push(step);
          if (steps.length > MAX_STEPS) {
            steps.shift();
            earlierSteps += 1;
          }
          report("running");
        } else if (record.type === "tool_execution_end") {
          activity = undefined;
          if (record.isError === true) {
            const step = [...steps].reverse().find((candidate) => candidate.tool === record.toolName && !candidate.failed);
            if (step) step.failed = true;
          }
          report("running");
        }
      };

      let text = "";
      let error: string | undefined;
      try {
        // Loaded here: the runner builds sessions that carry the tool that calls this.
        const { runPiAgentText } = await import("@/lib/pi/chat-runner");
        const turn = runPiAgentText({
          chatId,
          // A task that opens with @ would be read as a mention of its own.
          userMessage: request.task.trimStart().startsWith("@") ? `Task: ${request.task}` : request.task,
          projectId: project.id,
          visit: { parentChatId: parent.chatId, ...(parent.title ? { parentTitle: parent.title } : {}) },
          outcome,
          onSessionEvent,
        });
        // Whatever the turn does after it was let go of is of no interest to anyone.
        void turn.catch(() => undefined);
        const settled = await Promise.race([
          turn.then((value) => ({ value }) as const),
          letGoSignal.then(() => null),
        ]);
        if (settled) text = settled.value;
        else console.warn(`[visit] ${project.id} did not stop when asked; let go of it after ${Math.round(visitStopGraceMs() / 1000)}s`);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      } finally {
        finished = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        request.signal?.removeEventListener("abort", stop);
      }

      // What the project made is a result of this turn too: the answer that
      // carries its words carries its files.
      if (outcome.files?.length) recordVisitFiles(parent.chatId, outcome.files);
      const answer = clipAnswer(outcome.finalText?.trim() || text);
      const base = { text: answer.text, chatId, toolUses, seconds: seconds(), truncated: answer.truncated };
      if (timedOut) {
        return {
          ok: false, ...base, timedOut: true, stopped: true,
          error: `it took longer than ${Math.round(visitTimeoutMs() / 60_000)} minutes, so it was stopped`,
        };
      }
      if (request.signal?.aborted || (outcome.stopped && !error)) {
        return { ok: false, ...base, stopped: true, error: "it was stopped" };
      }
      if (error) return { ok: false, ...base, error };
      return { ok: true, ...base };
    });
  } finally {
    releaseSlot();
  }
}

/** Whether a visit to this project from this conversation is running right now. */
export function visitRunning(parentChatId: string, projectId: string): boolean {
  return Boolean(getActiveRun(visitChatIdFor(parentChatId, projectId)));
}

/**
 * What the card is told while a visit runs, in the shape the helper cards
 * already read (`activity`, `toolUses`), plus the steps this one can name.
 */
export function visitProgressDetails(progress: VisitProgress, meta: { projectName: string; chatId: string }): Record<string, unknown> {
  return {
    status: progress.status,
    toolUses: progress.toolUses,
    activity: progress.status === "queued"
      ? "queued — waiting for a free slot"
      : progress.activity ? `${progress.activity}…` : "thinking…",
    steps: progress.steps.map((step) => ({
      tool: step.tool,
      ...(step.target ? { target: step.target } : {}),
      ...(step.failed ? { failed: true } : {}),
    })),
    ...(progress.earlierSteps > 0 ? { earlierSteps: progress.earlierSteps } : {}),
    projectName: meta.projectName,
    visitChatId: meta.chatId,
  };
}

/**
 * What the tool answers with. The first line is fixed, in English, because the
 * model and the card both read it - the card strips it and shows the rest - and
 * neither is helped by it being translated.
 */
export function describeVisitResult(projectName: string, result: VisitResult): string {
  const duration = result.seconds >= 60 ? `${Math.floor(result.seconds / 60)}m ${result.seconds % 60}s` : `${result.seconds}s`;
  const name = projectName.replace(/"/g, "'");
  if (result.ok) {
    const headline = `Project "${name}" finished in ${duration} (${result.toolUses} tool uses).`;
    const tail = result.truncated ? "\n\n[The answer was cut here; the whole of it is in the project's chat.]" : "";
    return `${headline}\n\n${result.text || "The project finished without writing an answer."}${tail}`;
  }
  const headline = `Project "${name}" failed: ${result.error || "it was stopped"}.`;
  return result.text ? `${headline}\n\n${result.text}` : headline;
}
