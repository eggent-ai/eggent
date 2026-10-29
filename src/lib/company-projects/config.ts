/**
 * Where this workspace finds the projects its company opened to it, if anywhere.
 *
 * A hosted deployment that groups workspaces into companies sets
 * EGGENT_COMPANY_PROJECTS_API_URL for the company's people; the workspace then
 * authenticates with the token its usage meter uses, and the service decides
 * from that token who is asking and which projects they may ask. Without the
 * variable nothing about it exists: no rows in the sidebar, no page, no route.
 */
export interface CompanyProjectsConfig {
  url: string;
  token: string;
}

export function getCompanyProjectsConfig(): CompanyProjectsConfig | null {
  const url = process.env.EGGENT_COMPANY_PROJECTS_API_URL?.trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const token = process.env.EGGENT_USAGE_API_TOKEN?.trim();
  if (!token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

export function companyProjectsEnabled(): boolean {
  return getCompanyProjectsConfig() !== null;
}
