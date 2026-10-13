/**
 * A stamp for a change to a stored chat that is later than the one it replaces.
 *
 * Two copies of a chat are joined by taking the newer, and a switch of where it
 * runs adds no message, so it has to be newer than the file it changes. Taken
 * from this machine's clock alone it is not: a computer whose clock is behind
 * the other side's wrote a switch stamped earlier than the file it was changing.
 */
export function stampAfter(previous: string | null | undefined): string {
  const before = previous ? Date.parse(previous) : Number.NaN;
  const now = Date.now();
  return new Date(Number.isFinite(before) && before >= now ? before + 1 : now).toISOString();
}
