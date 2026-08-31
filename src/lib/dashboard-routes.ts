/**
 * Where a conversation lives in the address bar.
 *
 * Chats had ids all along but no address, so the browser always said
 * `/dashboard` no matter which one was open: a conversation could not be
 * linked to, bookmarked, opened in a second tab, or found again with Back. A
 * chat is now `/dashboard/<chatId>`, sitting beside the dashboard's own pages
 * rather than under a prefix of its own.
 *
 * Next resolves that on its own - a static segment always beats a dynamic one,
 * so `/dashboard/settings` keeps meaning settings. The gap it does not cover is
 * a directory that has no page of its own: `/dashboard/pipeline-runs` only
 * exists as `[id]` underneath, so it used to be a 404 and would otherwise fall
 * through to the chat route and quietly become a conversation named after it.
 * Hence the list below, and hence the route refusing anything in it.
 */

/**
 * Every name that belongs to the dashboard rather than to a conversation.
 *
 * Add a directory under `src/app/dashboard`, add it here - with or without a
 * page of its own. `npm run test:dashboard-routes` reads the route folder back
 * off disk and fails when the two disagree, because nothing else would: the
 * page keeps serving while its address quietly starts meaning a chat.
 */
export const RESERVED_DASHBOARD_SEGMENTS: readonly string[] = [
  "api",
  "context",
  "files",
  "mcp",
  "memory",
  "messengers",
  "onboarding",
  "pipeline-runs",
  "pipelines",
  "projects",
  "schedules",
  "settings",
  "skills",
];

const RESERVED = new Set(RESERVED_DASHBOARD_SEGMENTS);

export const DASHBOARD_CHAT_ROOT = "/dashboard";

/** True when this name is the dashboard's, and so can never be a chat. */
export function isReservedDashboardSegment(segment: string): boolean {
  return RESERVED.has(segment);
}

/** The address of a chat, or of the empty composer when there is no chat yet. */
export function chatPath(chatId: string | null | undefined): string {
  return chatId ? `${DASHBOARD_CHAT_ROOT}/${encodeURIComponent(chatId)}` : DASHBOARD_CHAT_ROOT;
}
