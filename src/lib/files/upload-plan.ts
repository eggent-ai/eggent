/**
 * How a folder becomes requests.
 *
 * The rules here are the browser's half of an upload, so - unlike the route's
 * own rules in ./upload.ts - nothing in this file may touch node:path or
 * anything else the client bundle cannot have.
 */

const BYTES_PER_MB = 1024 * 1024;

/**
 * Every directory a set of relative file paths implies, shallowest first.
 *
 * A dropped folder reports its directories separately, but a picked one does
 * not: the browser hands over the files alone, with `webkitRelativePath` as the
 * only trace of the shape they came in. Reading that shape back means a picked
 * folder arrives as the same request a dropped one does, and that the folder
 * appears in the tree even when every file in it turns out to be a conflict.
 */
export function collectParentDirectories(relativePaths: string[]): string[] {
  const directories = new Set<string>();

  for (const relativePath of relativePaths) {
    const segments = relativePath.split("/").filter(Boolean);
    for (let depth = 1; depth < segments.length; depth += 1) {
      directories.add(segments.slice(0, depth).join("/"));
    }
  }

  return [...directories].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)
  );
}

/**
 * Largest request a batched upload builds when the install has no limit.
 *
 * `EGGENT_MAX_UPLOAD_MB=0` says the install trusts its own memory with a single
 * large file; it does not say a folder of ten thousand files should arrive as
 * one request. The batches stay bounded either way.
 */
export const UNLIMITED_BATCH_BYTES = 64 * BYTES_PER_MB;

/**
 * Most files one request carries, however little they weigh.
 *
 * A thousand tiny files weigh nothing and still cost a thousand multipart parts
 * to parse, all of them held in memory at once.
 */
export const MAX_FILES_PER_BATCH = 200;

/**
 * What multipart adds around each file before its name: a boundary and a few
 * headers, twice over, since every file travels with the path it should land
 * at. Counted so a batch sized against the limit does not cross it on overhead
 * alone - the name itself is the caller's to add, through `sizeOf`.
 */
const PART_OVERHEAD_BYTES = 512;

/**
 * Split an upload into requests that each stay under the byte budget.
 *
 * A folder weighs as much as everything inside it, and the route holds a whole
 * request in memory while it parses it - so a folder cannot be one request the
 * way a single file can. Sending it as several keeps the worst case the same as
 * the one `EGGENT_MAX_UPLOAD_MB` was chosen for, and it is what makes a folder
 * larger than the limit uploadable at all rather than refused with 413.
 *
 * A file too large for the budget on its own still gets a batch: a request it
 * is refused in is more useful than a batch it silently vanishes from.
 */
export function planUploadBatches<T>(
  items: T[],
  sizeOf: (item: T) => number,
  budgetBytes: number,
  maxFilesPerBatch: number = MAX_FILES_PER_BATCH
): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let batchBytes = 0;

  for (const item of items) {
    const cost = sizeOf(item) + PART_OVERHEAD_BYTES;
    const full = batch.length >= maxFilesPerBatch || batchBytes + cost > budgetBytes;
    if (batch.length > 0 && full) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }

    batch.push(item);
    batchBytes += cost;
  }

  if (batch.length > 0) batches.push(batch);

  return batches;
}
