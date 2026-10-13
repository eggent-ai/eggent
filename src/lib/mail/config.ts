/**
 * Where this workspace's messages are kept, if anywhere.
 *
 * A hosted deployment that groups workspaces into companies sets
 * EGGENT_MAIL_API_URL; the workspace then authenticates with the same token
 * its usage meter uses (EGGENT_MAIL_API_TOKEN, else EGGENT_USAGE_API_TOKEN),
 * and the service decides from that token who it is and whom it may write to.
 * Without the variable nothing about messages exists: no section, no tool, no
 * background work.
 */
export interface MailConfig {
  url: string;
  token: string;
}

export function getMailConfig(): MailConfig | null {
  const url = process.env.EGGENT_MAIL_API_URL?.trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const token = process.env.EGGENT_MAIL_API_TOKEN?.trim() || process.env.EGGENT_USAGE_API_TOKEN?.trim();
  if (!token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

export function mailEnabled(): boolean {
  return getMailConfig() !== null;
}
