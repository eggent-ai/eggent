/**
 * Where this workspace learns which of its projects are shared, if anywhere.
 *
 * A hosted deployment keeps the public links and the openings to a company's
 * people outside the workspace and sets EGGENT_PROJECT_SHARING_API_URL; the
 * workspace asks with its services token (EGGENT_SERVICES_TOKEN, else
 * EGGENT_USAGE_API_TOKEN). Without it there is nothing to mark, and the
 * sidebar shows no marks.
 */
export interface ProjectSharingConfig {
  url: string;
  token: string;
}

export function getProjectSharingConfig(): ProjectSharingConfig | null {
  const url = process.env.EGGENT_PROJECT_SHARING_API_URL?.trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const token = process.env.EGGENT_SERVICES_TOKEN?.trim() || process.env.EGGENT_USAGE_API_TOKEN?.trim();
  if (!token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}
