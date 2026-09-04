/**
 * The largest single upload this workspace accepts.
 *
 * Less a policy about files than a budget for memory. Every request that
 * passes through middleware is buffered whole before the route handler ever
 * sees it, and the framework's own ceiling for that buffer is 10 MB — past
 * which it keeps the first 10 MB, drops the rest and lets the connection
 * abort. A 16 MB video dropped into the file tree therefore produced no file,
 * no error and no explanation: the multipart body arrived cut in half.
 *
 * So this number has to agree with `experimental.middlewareClientMaxBodySize`
 * in next.config.mjs, and `npm run test:upload-limit` fails if the two drift.
 * Raising it costs memory in a container that also runs the agent: the body is
 * held once by the buffer, again by the multipart parser and again while it is
 * written, so the peak is a small multiple of whatever is set here.
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Short, unitful, and the same in every language. */
export function formatUploadSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export const MAX_UPLOAD_LABEL = formatUploadSize(MAX_UPLOAD_BYTES);

/**
 * The size of a request too big to survive the buffer, or null if it fits.
 *
 * Decided from the header rather than from the body: by the time the body can
 * be measured it has already been truncated, and a truncated multipart body
 * fails as a parse error, which is the least informative thing a person could
 * be told about a file that is simply too large.
 */
export function oversizedRequestBytes(contentLength: string | null): number | null {
  const declared = Number(contentLength);
  if (!Number.isFinite(declared) || declared <= MAX_UPLOAD_BYTES) return null;
  return declared;
}
