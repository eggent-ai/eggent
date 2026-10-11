/**
 * Reading `@project do this` at the start of a message.
 *
 * Pure text in, a verdict out: no storage, no runtime, no node modules, so the
 * composer can use the very same function to offer the list and draw the pill
 * as the server uses to decide what the message means - two readings of one
 * message would sooner or later disagree about who was meant.
 *
 * A name is a person's word, not a slug. A project made in a language other
 * than English can have a random id, so the name has to match as well as the id,
 * and people write it as they like: capitals, a hyphen where there was a space,
 * the Russian yo for ye. Matching ignores all of that, and it ignores where a
 * space was, so "My Shop", "my-shop" and "myshop" are one name.
 *
 * What it will not do is guess. A handle that is not a project - a Telegram
 * username, a channel, an address - is not a mention. A mention with nothing
 * after it is not a task. And a name that fits two projects equally well is
 * ambiguous, never resolved to whichever came first.
 */

export interface MentionableProject {
  id: string;
  name: string;
  description?: string;
}

export type MentionResolution =
  /** Not a mention of a project: send the message as it is. */
  | { kind: "none" }
  /** One project is meant, and here is what to ask it. */
  | { kind: "project"; project: MentionableProject; task: string; handle: string }
  /** The project the conversation is already in: the prefix is dropped, the task stays. */
  | { kind: "self"; project: MentionableProject; task: string; handle: string }
  /** Two or more projects fit equally well. */
  | { kind: "ambiguous"; candidates: MentionableProject[]; task: string; handle: string };

// Spaces and the separators people use in their place, the no-break space, and
// the invisible characters that come along with a paste.
const SEPARATORS = /[\s_\-\u00a0\u200b-\u200d\u2060\ufeff]+/g;
// What may stand between the name and the task.
const BOUNDARY = /[\s:,\u00a0]/;
const MAX_HANDLE_CHARS = 80;

/**
 * A name as it is compared: case, the Russian yo (written as an escape so this
 * file stays language-neutral), separators and invisible characters do not count.
 */
export function squashName(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\u0451/g, "\u0435").replace(SEPARATORS, "");
}

function stripInvisible(text: string): string {
  return text.replace(/^[\u200b-\u200d\u2060\ufeff]+/, "");
}

interface Match {
  project: MentionableProject;
  length: number;
  byId: boolean;
}

export function resolveProjectMention(
  text: string,
  projects: readonly MentionableProject[],
  currentProjectId?: string | null
): MentionResolution {
  const trimmed = stripInvisible(text).trimStart();
  if (!trimmed.startsWith("@") || trimmed.length < 2) return { kind: "none" };
  const rest = trimmed.slice(1);

  // Every way of writing each project, squashed once.
  const forms = projects
    .map((project) => ({
      project,
      id: squashName(project.id),
      name: squashName(project.name),
    }))
    .filter((entry) => entry.id || entry.name);

  const matches: Match[] = [];
  const limit = Math.min(rest.length, MAX_HANDLE_CHARS);
  for (let end = 1; end <= limit; end += 1) {
    // The name has to be followed by a boundary - or by nothing, which is a
    // handle with no task and is dealt with below.
    if (end < rest.length && !BOUNDARY.test(rest[end])) continue;
    const squashed = squashName(rest.slice(0, end));
    if (!squashed) continue;
    for (const entry of forms) {
      if (entry.id === squashed) matches.push({ project: entry.project, length: end, byId: true });
      else if (entry.name === squashed) matches.push({ project: entry.project, length: end, byId: false });
    }
  }
  if (matches.length === 0) return { kind: "none" };

  // The longest handle wins, and at that length an id beats a name.
  const longest = Math.max(...matches.map((match) => match.length));
  let best = matches.filter((match) => match.length === longest);
  if (best.some((match) => match.byId)) best = best.filter((match) => match.byId);
  const distinct = [...new Map(best.map((match) => [match.project.id, match.project])).values()];

  const handle = rest.slice(0, longest);
  const task = rest.slice(longest).replace(/^[\s:,\u00a0]+/, "").trim();
  if (!task) return { kind: "none" };

  if (distinct.length > 1) return { kind: "ambiguous", candidates: distinct, task, handle };
  const [project] = distinct;
  if (currentProjectId && project.id === currentProjectId) return { kind: "self", project, task, handle };
  return { kind: "project", project, task, handle };
}

/**
 * The names a composer should offer for what has been typed after the `@`.
 * Prefix match on either form, the same squashing as above, so what is offered
 * is what would resolve.
 */
export function suggestProjects(
  typed: string,
  projects: readonly MentionableProject[],
  limit = 8
): MentionableProject[] {
  const wanted = squashName(typed);
  return projects
    .filter((project) => !wanted || squashName(project.name).startsWith(wanted) || squashName(project.id).startsWith(wanted))
    .slice(0, limit);
}

/**
 * How to write a project after an @ so that it is read as that project.
 *
 * Its name with the spaces turned into hyphens, so the handle is one word the
 * person recognises; its id when that would not do - the name has a separator
 * the grammar takes for the end of a handle, or another project reads the same.
 */
export function mentionHandleFor(project: MentionableProject, projects: readonly MentionableProject[]): string {
  for (const candidate of [project.name.trim().replace(/\s+/g, "-"), project.id]) {
    if (!candidate || /[\s:,]/.test(candidate)) continue;
    const resolution = resolveProjectMention(`@${candidate} x`, projects);
    if ((resolution.kind === "project" || resolution.kind === "self") && resolution.project.id === project.id) return candidate;
  }
  return project.id;
}
