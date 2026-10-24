import fs from "node:fs";
import path from "node:path";

/**
 * A browser the agent drives, on a machine of the deployment's.
 *
 * The workspace holds no browser of its own: a deployment that offers one says
 * where with EGGENT_BROWSER_API_URL, and this workspace reaches it with the
 * same token it uses for the deployment's other services. Without that
 * address none of this is offered - no program for the agent, no panel, no
 * line in the agent's instructions.
 */

export function browserApiUrl(): string {
  return (process.env.EGGENT_BROWSER_API_URL || "").trim().replace(/\/+$/, "");
}

export function browserToken(): string {
  return (process.env.EGGENT_USAGE_API_TOKEN || "").trim();
}

export function browserAvailable(): boolean {
  return Boolean(browserApiUrl() && browserToken());
}

/**
 * Where the agent's program and the panel agree on what is shown: the page the
 * program works on (state.json) and whether the person has taken control
 * (control.json). Inside the data folder, outside every project.
 */
export function browserStateDir(): string {
  return process.env.EGGENT_BROWSER_STATE_DIR || path.join(process.cwd(), "data", "tmp", "browser");
}

export function browserStateFile(): string {
  return path.join(browserStateDir(), "state.json");
}

export function browserControlFile(): string {
  return path.join(browserStateDir(), "control.json");
}

/** The page the agent's program last worked on, if it said. */
export function rememberedTarget(): string | null {
  try {
    const state = JSON.parse(fs.readFileSync(browserStateFile(), "utf8")) as { targetId?: unknown };
    return typeof state.targetId === "string" ? state.targetId : null;
  } catch {
    return null;
  }
}

const CONTROL_STALE_MS = 30 * 60_000;

export type BrowserControl = "agent" | "person";

export function browserControl(): BrowserControl {
  try {
    const control = JSON.parse(fs.readFileSync(browserControlFile(), "utf8")) as { by?: unknown; since?: unknown };
    if (control.by === "person" && Date.now() - Number(control.since || 0) < CONTROL_STALE_MS) return "person";
  } catch {
    // Nobody has taken it.
  }
  return "agent";
}

export function setBrowserControl(control: BrowserControl): void {
  if (control === "agent") {
    fs.rmSync(browserControlFile(), { force: true });
    return;
  }
  fs.mkdirSync(browserStateDir(), { recursive: true });
  const file = browserControlFile();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ by: "person", since: Date.now() }));
  fs.renameSync(tmp, file);
}

/** The program for the agent's shell, beside the app in `scripts/bin`. */
export function browserCliPresent(binDir: string | null): boolean {
  if (!binDir) return false;
  try {
    fs.accessSync(path.join(binDir, "eggent-browser"), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Tells the agent's program where the shared state lives. */
export function exportBrowserEnvironment(): void {
  process.env.EGGENT_BROWSER_STATE_DIR = browserStateDir();
}
