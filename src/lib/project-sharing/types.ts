/** Which of this workspace's projects are shared, as its sidebar marks them. Client-safe. */

export interface ProjectSharingMark {
  /** A live link anybody can open. */
  public: boolean;
  /** Who among the company's people the project is open to, or null. */
  company: { all: boolean; teams: string[]; people: string[] } | null;
}

export type ProjectSharingAnswer = { enabled: false } | { enabled: true; projects: Record<string, ProjectSharingMark> };

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string" && name.trim() !== "").slice(0, 50) : [];
}

/** What the service answered, keeping only the fields the marks use. */
export function cleanProjectSharing(raw: unknown): Record<string, ProjectSharingMark> {
  const projects = (raw as { projects?: unknown } | null)?.projects;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) return {};
  const marks: Record<string, ProjectSharingMark> = {};
  for (const [projectId, value] of Object.entries(projects as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as { public?: unknown; company?: unknown };
    const company = entry.company && typeof entry.company === "object"
      ? (entry.company as { all?: unknown; teams?: unknown; people?: unknown })
      : null;
    const mark: ProjectSharingMark = {
      public: entry.public === true,
      company: company ? { all: company.all === true, teams: names(company.teams), people: names(company.people) } : null,
    };
    if (mark.public || mark.company) marks[projectId] = mark;
  }
  return marks;
}
