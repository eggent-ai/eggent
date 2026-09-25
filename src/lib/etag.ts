import { createHash } from "node:crypto";

/**
 * A weak validator for a response body: equal bodies, equal tags.
 *
 * Weak because a proxy that compresses the response on its way out may not
 * keep a strong tag, and a comparison that fails there silently turns every
 * revalidation back into a full download.
 */
export function weakEtag(body: string): string {
  return `W/"${createHash("sha1").update(body).digest("base64url")}"`;
}

/** Whether an If-None-Match header names this tag, compared weakly as RFC 9110 asks for. */
export function matchesIfNoneMatch(header: string | null | undefined, etag: string): boolean {
  if (!header) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, "");
  const wanted = opaque(etag);
  return header.split(",").some((candidate) => {
    const tag = candidate.trim();
    return tag === "*" || opaque(tag) === wanted;
  });
}
