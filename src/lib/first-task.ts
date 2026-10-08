/**
 * A first task chosen before the workspace was ever opened.
 *
 * Whoever creates a workspace for somebody can ask what to start with and pass
 * the answer along with the one-time sign-in link, as `#handoff=…&start=<skill>`
 * with an optional `&brief=<text>`. The dashboard then starts that skill the way
 * its quick-start card would, with the brief as the first thing said to it, so
 * the person arrives in a chat that is already working instead of an empty one.
 *
 * It is honoured only together with a sign-in link that was actually redeemed.
 * Without that, any link sent to a signed-in owner could start an agent with a
 * shell on their behalf and words of somebody else's choosing.
 */

export interface FirstTask {
  skill: string;
  brief: string;
}

const STORAGE_KEY = "eggent-first-task";
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Long enough for a sentence about what to make, short enough that a link
// cannot carry a whole prompt.
export const FIRST_TASK_BRIEF_MAX = 500;
// A task that was never picked up - a sign-in that went to the onboarding
// screen, a tab closed mid-redirect - must not start itself hours later.
const MAX_AGE_MS = 10 * 60 * 1000;

function decodePart(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return "";
  }
}

export function parseFirstTask(fragment: string): FirstTask | null {
  let skill = "";
  let brief = "";
  for (const part of fragment.replace(/^#/, "").split("&")) {
    if (part.startsWith("start=")) skill = decodePart(part.slice("start=".length)).trim();
    else if (part.startsWith("brief=")) brief = decodePart(part.slice("brief=".length));
  }
  if (!SKILL_NAME.test(skill)) return null;
  const compact = brief.replace(/\s+/g, " ").trim().slice(0, FIRST_TASK_BRIEF_MAX);
  return { skill, brief: compact };
}

export function rememberFirstTask(task: FirstTask): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...task, at: Date.now() }));
  } catch {
    // Storage refused (a private window, blocked site data): the person lands
    // on the ordinary new-chat screen, which is where they would have been.
  }
}

/** Returns the remembered task once and forgets it, so it starts only once. */
export function takeFirstTask(): FirstTask | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(STORAGE_KEY);
    const parsed = JSON.parse(raw) as { skill?: unknown; brief?: unknown; at?: unknown };
    if (typeof parsed.at !== "number" || Date.now() - parsed.at > MAX_AGE_MS) return null;
    const skill = typeof parsed.skill === "string" ? parsed.skill : "";
    if (!SKILL_NAME.test(skill)) return null;
    const brief = typeof parsed.brief === "string" ? parsed.brief.slice(0, FIRST_TASK_BRIEF_MAX) : "";
    return { skill, brief };
  } catch {
    return null;
  }
}
