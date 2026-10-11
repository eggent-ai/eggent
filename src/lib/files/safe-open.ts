import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

/**
 * Opening a file that was looked at some time ago.
 *
 * Whatever sends a workspace file somewhere - the archive, the button under an
 * answer, `/files` - judges a path first and reads it later, and in between the
 * folder belongs to an agent with a shell. So the file is checked again when it
 * is opened, on the handle itself:
 *
 * - not followed if it has become a link (O_NOFOLLOW);
 * - not waited for if it has become a pipe: opening a FIFO that nobody writes to
 *   blocks for ever in a thread the process cannot get back (O_NONBLOCK, which a
 *   regular file ignores);
 * - a plain file, with one name (a second name may be a door to a file that is
 *   not in this folder);
 * - and, given the folder, the very file the path leads to inside it: the real
 *   path stays under the folder and is the file that was opened.
 *
 * Returns null for anything else, the handle closed.
 */
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

export async function openPlainFile(filePath: string, options: { root?: string } = {}): Promise<FileHandle | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(filePath, OPEN_FLAGS);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink > 1) throw new Error("not a plain file");
    if (options.root) {
      const real = await fs.realpath(filePath);
      if (!real.startsWith(options.root + path.sep)) throw new Error("outside the folder");
      const there = await fs.stat(real);
      if (there.ino !== opened.ino || there.dev !== opened.dev) throw new Error("replaced");
    }
    return handle;
  } catch {
    await handle?.close().catch(() => undefined);
    return null;
  }
}
