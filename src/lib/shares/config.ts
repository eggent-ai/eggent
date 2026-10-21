/**
 * Where this workspace's shared files are kept track of, if anywhere.
 *
 * A hosted deployment that groups workspaces into companies sets
 * EGGENT_SHARES_API_URL; the workspace then authenticates with the same token
 * its usage meter uses (EGGENT_SHARES_API_TOKEN, else EGGENT_USAGE_API_TOKEN),
 * and the service decides from that token who it is and what it may see.
 * Without the variable nothing about sharing exists: no section, no button, no
 * tool, no background work.
 */
export interface SharesConfig {
  url: string;
  token: string;
}

export function getSharesConfig(): SharesConfig | null {
  const url = process.env.EGGENT_SHARES_API_URL?.trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const token = process.env.EGGENT_SHARES_API_TOKEN?.trim() || process.env.EGGENT_USAGE_API_TOKEN?.trim();
  if (!token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

export function sharesEnabled(): boolean {
  return getSharesConfig() !== null;
}
