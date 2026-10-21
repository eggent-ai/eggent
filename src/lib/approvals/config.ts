/**
 * Where this workspace's approvals are kept, if anywhere.
 *
 * A hosted deployment that groups workspaces into companies sets
 * EGGENT_APPROVALS_API_URL; the workspace then authenticates with the same
 * token its usage meter uses (EGGENT_APPROVALS_API_TOKEN, else
 * EGGENT_USAGE_API_TOKEN), and the service decides from that token who it is,
 * whom it may ask and whose turn it is. Without the variable nothing about
 * approvals exists: no section, no button, no tool, no background work.
 */
export interface ApprovalsConfig {
  url: string;
  token: string;
}

export function getApprovalsConfig(): ApprovalsConfig | null {
  const url = process.env.EGGENT_APPROVALS_API_URL?.trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const token = process.env.EGGENT_APPROVALS_API_TOKEN?.trim() || process.env.EGGENT_USAGE_API_TOKEN?.trim();
  if (!token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

export function approvalsEnabled(): boolean {
  return getApprovalsConfig() !== null;
}
