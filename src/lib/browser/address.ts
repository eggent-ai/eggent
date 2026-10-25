/**
 * What the person typed into the Browser panel's address bar, as an address
 * the browser may open - or nothing.
 *
 * Only web pages: a typed `file:`, `chrome:` or `javascript:` address would
 * reach into the browser's own machine or run code on the page in front of
 * it, and nobody types those to get somewhere. An address without a scheme is
 * taken as https, the way the agent's program takes one. Shared by the panel,
 * which says at once that something is not an address, and the route, which
 * decides.
 */
export function pageAddress(typed: string): string | null {
  const text = typed.trim();
  if (!text || text.length > 2000) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}
