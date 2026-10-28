/**
 * Where this workspace reaches Google Sheets and Calendar, if anywhere.
 *
 * A hosted deployment that runs an OAuth app sets EGGENT_GOOGLE_API_URL: the
 * connection, its tokens and the calls to Google all live there, and the
 * workspace only asks it for an allowed action - it never holds a Google
 * credential. The workspace authenticates with its services token
 * (EGGENT_GOOGLE_API_TOKEN, else EGGENT_SERVICES_TOKEN, else the usage token),
 * and the service decides from that token which workspace asks. Without the
 * variable nothing about Google exists: no card, no tool.
 */
export interface GoogleConfig {
  url: string;
  token: string;
}

export function getGoogleConfig(): GoogleConfig | null {
  const url = process.env.EGGENT_GOOGLE_API_URL?.trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const token =
    process.env.EGGENT_GOOGLE_API_TOKEN?.trim() ||
    process.env.EGGENT_SERVICES_TOKEN?.trim() ||
    process.env.EGGENT_USAGE_API_TOKEN?.trim();
  if (!token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

export function googleEnabled(): boolean {
  return getGoogleConfig() !== null;
}
