/**
 * Hiring an AI employee: a bundled skill with an `employee` id, started in a
 * project of its own on the one thing the person gave it (a site, a channel, a
 * file, a topic).
 *
 * Two doors lead here. A deployment's signup writes `data/onboarding.json`
 * before the person first opens the workspace, so the first screen is the
 * employee already at work; and the hire screen inside the app asks the same
 * question and calls hireEmployee directly.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { launchBundledSkill, listBundledSkills, type BundledSkill } from "@/lib/storage/bundled-skills-store";
import { getProjectModelSettingsPath, getWorkDir } from "@/lib/storage/project-store";
import { getManagedProviderId } from "@/lib/pi/config-store";
import { runPiAgentText } from "@/lib/pi/chat-runner";
import { createChat, getChat, saveChat } from "@/lib/storage/chat-store";
import { jobTitle } from "@/lib/employees/job-title";
import { resolveLocalePreference, type SupportedLocale } from "@/i18n/locales";
import { translate } from "@/i18n/messages";

const DATA_DIR = path.join(process.cwd(), "data");
const ONBOARDING_FILE = path.join(DATA_DIR, "onboarding.json");
const ONBOARDING_LOCK = path.join(DATA_DIR, "onboarding.lock");
/** Where a file given at signup waits until its employee's project exists. */
const ONBOARDING_FILES = path.join(DATA_DIR, "onboarding");

export interface OnboardingRecord {
  version: 1;
  /** The bundled skill to start. */
  skill: string;
  /** What the person gave: a link, a channel, a topic, a role. */
  input?: string;
  /** A file the person gave, relative to data/onboarding. */
  file?: string;
  createdAt?: string;
  takenAt?: string;
  projectId?: string | null;
  chatId?: string;
  /** When somebody first opened the employee's chat after it was started without them. */
  openedAt?: string;
}

export interface HireResult {
  projectId: string | null;
  /** The chat the employee's first job runs in, already started. */
  chatId: string;
  /** The first message, as the chat sends it: `/skill:<name> <input>`. */
  message: string;
  skill: BundledSkill;
}

const MAX_INPUT = 2000;

function cleanInput(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_INPUT) : "";
}

export async function readOnboarding(): Promise<OnboardingRecord | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(ONBOARDING_FILE, "utf-8")) as OnboardingRecord;
    if (!parsed || typeof parsed.skill !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Whether a signup left an employee waiting to start. */
export async function onboardingPending(): Promise<boolean> {
  const record = await readOnboarding();
  // Waiting to start, or started by the deployment before anybody opened it.
  return Boolean(record && (!record.takenAt || (record.chatId && !record.openedAt)));
}

async function writeRecord(record: OnboardingRecord): Promise<void> {
  await fs.writeFile(`${ONBOARDING_FILE}.tmp`, JSON.stringify(record, null, 2));
  await fs.rename(`${ONBOARDING_FILE}.tmp`, ONBOARDING_FILE);
}

/**
 * The first visit to the dashboard after the signup: the employee's chat to
 * open - started now if nothing started it yet, else the one the deployment
 * started the moment the workspace was ready. Once only.
 */
export async function openOnboarding(locale: SupportedLocale): Promise<
  { ok: true; chatId: string; projectId: string | null } | { ok: false; error: string; code: number }
> {
  const record = await readOnboarding();
  if (record?.takenAt && record.chatId && !record.openedAt) {
    await writeRecord({ ...record, openedAt: new Date().toISOString() });
    return { ok: true, chatId: record.chatId, projectId: record.projectId ?? null };
  }
  const taken = await takeOnboarding(locale);
  if (!taken.ok) return taken;
  const after = await readOnboarding();
  if (after) await writeRecord({ ...after, openedAt: new Date().toISOString() });
  return { ok: true, chatId: taken.result.chatId, projectId: taken.result.projectId };
}

/** Copies a file into the employee's project, beside its work, under a name that is not taken. */
async function moveIntoProject(source: string, projectId: string | null): Promise<string> {
  const cwd = getWorkDir(projectId ?? "none");
  const inbox = path.join(cwd, "inbox");
  await fs.mkdir(inbox, { recursive: true });
  const base = path.basename(source);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length) || "file";
  let target = path.join(inbox, base);
  for (let i = 2; await fs.stat(target).then(() => true, () => false); i += 1) {
    target = path.join(inbox, `${stem}-${i}${ext}`);
  }
  await fs.copyFile(source, target);
  return path.relative(cwd, target);
}

/**
 * The deployment may name the included model employees work on
 * (EGGENT_EMPLOYEE_MODEL): a first job is a few dozen steps, and on a cheap
 * model it costs cents. Only for a workspace on the included models; one on
 * its own key keeps whatever it chose.
 */
async function pinEmployeeModel(projectId: string): Promise<void> {
  const model = process.env.EGGENT_EMPLOYEE_MODEL?.trim();
  if (!model) return;
  const provider = await getManagedProviderId();
  if (!provider) return;
  await fs.writeFile(
    getProjectModelSettingsPath(projectId),
    JSON.stringify({ inheritsGlobal: false, provider, model }, null, 2)
  );
}

/**
 * Starts an employee: its project, its skill installed there, and the first
 * message that hands it the input. The file, when there is one, is copied into
 * the project first and named in the message by its path there.
 */
export async function hireEmployee(options: {
  skill: string;
  input?: string;
  /** An absolute path to a file to hand over. */
  filePath?: string;
  locale?: SupportedLocale;
  /** False leaves the first message to the caller: the Telegram bot relays it so the job streams into the chat. */
  startTurn?: boolean;
}): Promise<{ ok: true; result: HireResult } | { ok: false; error: string; code: number }> {
  const locale = options.locale ?? "en";
  const skill = (await listBundledSkills(locale)).find((item) => item.name === options.skill.trim().toLowerCase());
  if (!skill?.employee) return { ok: false, error: "No such employee", code: 404 };

  const launched = await launchBundledSkill(skill.name, undefined, locale);
  if (!launched.success) return { ok: false, error: launched.error, code: launched.code };

  if (launched.projectId) await pinEmployeeModel(launched.projectId).catch((error) => {
    console.error("Could not set the employee's model:", error);
  });

  let input = cleanInput(options.input);
  if (options.filePath) {
    const relative = await moveIntoProject(options.filePath, launched.projectId);
    input = input ? `${relative} ${input}` : relative;
  }
  const message = input ? `${launched.initialMessage} ${input}` : launched.initialMessage;
  const title = jobTitle(skill.employee.task, skill.employee.input, cleanInput(options.input), options.filePath);
  const chatId = options.startTurn === false ? "" : await startFirstJob(launched.projectId, message, title, skill.employee.role);
  return { ok: true, result: { projectId: launched.projectId, chatId, message, skill } };
}

/**
 * A first job that ended without a word - the model could not be reached, the
 * turn failed before it began - must not leave the person looking at an empty
 * chat they were sent to: one line says so and how to go on.
 */
async function sayWhenNothingCame(chatId: string): Promise<void> {
  const chat = await getChat(chatId).catch(() => null);
  if (!chat || chat.messages.at(-1)?.role !== "user") return;
  const locale = resolveLocalePreference(process.env.EGGENT_DEFAULT_LANGUAGE);
  await saveChat({
    ...chat,
    messages: [
      ...chat.messages,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content: translate(locale, "employees.focus.startFailed"),
        createdAt: new Date().toISOString(),
      },
    ],
    updatedAt: new Date().toISOString(),
  });
}

const STATE_FILE = path.join(DATA_DIR, "employees-state.json");

/** The very first job any employee did in this workspace: the one a deployment may offer a plan under. */
export async function rememberFirstJob(chatId: string, role: string): Promise<void> {
  try {
    await fs.access(STATE_FILE);
    return;
  } catch {
    // The first one: written once, never moved.
  }
  await fs.writeFile(STATE_FILE, JSON.stringify({ firstJob: { chatId, role, at: new Date().toISOString() } }, null, 2), { flag: "wx" }).catch(() => {});
}

export async function firstJob(): Promise<{ chatId: string; role: string } | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(STATE_FILE, "utf-8")) as { firstJob?: { chatId?: string; role?: string } };
    return parsed.firstJob?.chatId ? { chatId: parsed.firstJob.chatId, role: parsed.firstJob.role ?? "" } : null;
  } catch {
    return null;
  }
}

/**
 * Starts the first job on the server, in a chat of its own, and returns at
 * once. The screen then opens that chat and follows the turn already running
 * - the way a turn started from Telegram is watched from the web - so the job
 * does not depend on which page happened to be mounted when it began.
 */
async function startFirstJob(projectId: string | null, message: string, title: string, role: string): Promise<string> {
  const chatId = crypto.randomUUID();
  await createChat(chatId, title, projectId ?? undefined);
  await rememberFirstJob(chatId, role).catch(() => {});
  void runPiAgentText({ chatId, userMessage: message, projectId: projectId ?? undefined })
    .catch((error) => {
      console.error(`[employees] the first job in ${chatId.slice(0, 8)} failed:`, error);
      return "";
    })
    .then(() => sayWhenNothingCame(chatId));
  return chatId;
}

/**
 * Starts the employee a signup left waiting, once. A lock file keeps two tabs
 * opened at the same moment from hiring it twice; the record keeps what was
 * started, so a reload finds the project instead of nothing.
 */
export async function takeOnboarding(locale: SupportedLocale): Promise<
  { ok: true; result: HireResult } | { ok: false; error: string; code: number }
> {
  let lock: fs.FileHandle | null = null;
  try {
    lock = await fs.open(ONBOARDING_LOCK, "wx");
  } catch {
    return { ok: false, error: "Already starting", code: 409 };
  }
  try {
    const record = await readOnboarding();
    if (!record) return { ok: false, error: "Nothing to start", code: 404 };
    if (record.takenAt) return { ok: false, error: "Already started", code: 409 };
    let filePath: string | undefined;
    if (record.file) {
      const resolved = path.resolve(ONBOARDING_FILES, record.file);
      if (!resolved.startsWith(ONBOARDING_FILES + path.sep)) return { ok: false, error: "Bad file", code: 400 };
      filePath = resolved;
    }
    const hired = await hireEmployee({ skill: record.skill, input: record.input, filePath, locale });
    // A record that cannot start (the skill is gone, the file is gone) is
    // closed all the same: the person must not meet the same failure on every
    // visit to the new-chat screen.
    const done: OnboardingRecord = {
      ...record,
      takenAt: new Date().toISOString(),
      projectId: hired.ok ? hired.result.projectId : null,
      ...(hired.ok ? { chatId: hired.result.chatId } : {}),
    };
    await fs.writeFile(`${ONBOARDING_FILE}.tmp`, JSON.stringify(done, null, 2));
    await fs.rename(`${ONBOARDING_FILE}.tmp`, ONBOARDING_FILE);
    return hired;
  } finally {
    await lock.close().catch(() => {});
    await fs.rm(ONBOARDING_LOCK, { force: true }).catch(() => {});
  }
}
