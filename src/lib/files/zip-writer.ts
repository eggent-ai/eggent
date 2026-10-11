import { Readable, Transform, pipeline } from "node:stream";
import zlib from "node:zlib";
import { openPlainFile } from "@/lib/files/safe-open";

/**
 * A ZIP archive written as a stream.
 *
 * What it is for: handing somebody a folder - or the files an answer produced -
 * in one piece, from a container that also runs the agent. So nothing is held
 * whole: each file is read, compressed and written out as it goes, with the
 * sizes and the CRC that the format wants in front of the data written behind
 * it (the data-descriptor form every unzip tool reads). Memory is a few
 * buffers whatever the folder weighs; the central directory, one small record
 * per file, is the only thing kept until the end.
 *
 * What it leaves out, on purpose: ZIP64 (the caller caps an archive well below
 * 4 GiB and 65 535 files), encryption, and anything that is not a plain file.
 * A file that changes while it is read is written as far as the size it had
 * when it was listed, so the archive is always consistent with its own
 * directory. A file that cannot be opened when its turn comes - gone, unreadable,
 * or replaced by a link to somewhere else while the archive was being sent - is
 * left out rather than ending the archive.
 */

const LOCAL_SIGNATURE = 0x04034b50;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;

// Bit 3: sizes and CRC follow the data. Bit 11: names are UTF-8.
const FLAGS = 0x0008 | 0x0800;
const METHOD_DEFLATED = 8;
const VERSION_NEEDED = 20;
// Made on Unix, so the permission bits in the external attributes are honoured.
const VERSION_MADE_BY = (3 << 8) | 20;

const MAX_ENTRIES = 0xfffe;
const MAX_OFFSET = 0xfffffffe;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

// Node 22 has it built in; the table below is for the runtimes that do not, and
// is the same arithmetic.
const nativeCrc32 = (zlib as unknown as { crc32?: (data: Uint8Array, value?: number) => number }).crc32;

/** Folds more bytes into a running CRC-32. Start from 0; the result is the CRC of everything so far. */
export function crc32Update(crc: number, chunk: Uint8Array): number {
  if (nativeCrc32) return nativeCrc32(chunk, crc) >>> 0;
  let value = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < chunk.length; i += 1) value = CRC_TABLE[(value ^ chunk[i]) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export interface ZipFile {
  /** The name inside the archive: forward slashes, no leading slash, no "..". */
  name: string;
  /** Where the bytes come from. */
  filePath: string;
  /** The size when the file was listed; no more than this many bytes are read. */
  size: number;
  mode: number;
  mtime: Date;
}

// Compressing these again costs processor time and saves nothing.
const ALREADY_COMPRESSED = new Set([
  ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".zst",
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".avif",
  ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".mp4", ".mov", ".mkv", ".webm", ".avi",
  ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".epub", ".pdf", ".jar", ".apk",
]);

export function isAlreadyCompressed(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot >= 0 && ALREADY_COMPRESSED.has(name.slice(dot).toLowerCase());
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff,
    date: (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff,
  };
}

interface Finished {
  name: Buffer;
  time: number;
  date: number;
  crc: number;
  compressed: number;
  size: number;
  mode: number;
  offset: number;
}

function localHeader(name: Buffer, time: number, date: number): Buffer {
  const header = Buffer.alloc(30 + name.length);
  header.writeUInt32LE(LOCAL_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(FLAGS, 6);
  header.writeUInt16LE(METHOD_DEFLATED, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  // CRC and both sizes are zero here: they follow the data.
  header.writeUInt16LE(name.length, 26);
  name.copy(header, 30);
  return header;
}

function descriptor(entry: Finished): Buffer {
  const record = Buffer.alloc(16);
  record.writeUInt32LE(DESCRIPTOR_SIGNATURE, 0);
  record.writeUInt32LE(entry.crc, 4);
  record.writeUInt32LE(entry.compressed, 8);
  record.writeUInt32LE(entry.size, 12);
  return record;
}

function centralRecord(entry: Finished): Buffer {
  const record = Buffer.alloc(46 + entry.name.length);
  record.writeUInt32LE(CENTRAL_SIGNATURE, 0);
  record.writeUInt16LE(VERSION_MADE_BY, 4);
  record.writeUInt16LE(VERSION_NEEDED, 6);
  record.writeUInt16LE(FLAGS, 8);
  record.writeUInt16LE(METHOD_DEFLATED, 10);
  record.writeUInt16LE(entry.time, 12);
  record.writeUInt16LE(entry.date, 14);
  record.writeUInt32LE(entry.crc, 16);
  record.writeUInt32LE(entry.compressed, 20);
  record.writeUInt32LE(entry.size, 24);
  record.writeUInt16LE(entry.name.length, 28);
  // Extra field, comment, disk number and internal attributes: none (zeros).
  record.writeUInt32LE(((0o100000 | (entry.mode & 0o777)) << 16) >>> 0, 38);
  record.writeUInt32LE(entry.offset, 42);
  entry.name.copy(record, 46);
  return record;
}

function endRecord(count: number, directorySize: number, directoryOffset: number): Buffer {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(END_SIGNATURE, 0);
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(directorySize, 12);
  record.writeUInt32LE(directoryOffset, 16);
  return record;
}

async function* writeArchive(files: readonly ZipFile[], options: ZipStreamOptions): AsyncGenerator<Buffer> {
  const { signal, onActivity } = options;
  if (files.length > MAX_ENTRIES) throw new Error("Too many files for one archive.");
  const finished: Finished[] = [];
  let offset = 0;

  for (const file of files) {
    if (signal?.aborted) throw new Error("The archive was cancelled.");
    if (offset > MAX_OFFSET) throw new Error("The archive is too large.");
    onActivity?.();
    // Before the header, so a file that cannot be had leaves no trace in the archive.
    const handle = file.size > 0 ? await openPlainFile(file.filePath, { root: options.root }) : null;
    if (file.size > 0 && !handle) continue;
    // From here the handle is this entry's to close, whatever stops the archive: a reader that
    // goes away while the generator rests at the header (backpressure holds it there) ends it
    // through this block, and a handle opened above and not closed below is left to the
    // garbage collector - which on newer Node ends the process.
    try {
      const name = Buffer.from(file.name, "utf8");
      const { time, date } = dosDateTime(file.mtime);
      const header = localHeader(name, time, date);
      const entryOffset = offset;
      yield header;
      onActivity?.();
      offset += header.length;

      let crc = 0;
      let size = 0;
      let compressed = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          crc = crc32Update(crc, chunk);
          size += chunk.length;
          callback(null, chunk);
        },
      });
      const deflate = zlib.createDeflateRaw({ level: isAlreadyCompressed(file.name) ? 0 : 6 });
      // An empty file has no bytes to read, and a range of [0, -1] is an error.
      const input = handle
        ? handle.createReadStream({ start: 0, end: file.size - 1, autoClose: true })
        : Readable.from([]);
      const flow = pipeline(input, counter, deflate, () => undefined);
      try {
        for await (const out of flow) {
          const piece = out as Buffer;
          compressed += piece.length;
          offset += piece.length;
          yield piece;
          onActivity?.();
        }
      } finally {
        input.destroy();
        counter.destroy();
        deflate.destroy();
      }

      const entry: Finished = { name, time, date, crc, compressed, size, mode: file.mode, offset: entryOffset };
      const trailer = descriptor(entry);
      yield trailer;
      offset += trailer.length;
      finished.push(entry);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  const directoryOffset = offset;
  let directorySize = 0;
  for (const entry of finished) {
    const record = centralRecord(entry);
    directorySize += record.length;
    yield record;
  }
  yield endRecord(finished.length, directorySize, directoryOffset);
}

export interface ZipStreamOptions {
  signal?: AbortSignal;
  /**
   * The real path of the folder the files came from. With it, each file is checked
   * again when it is opened - see openForArchive.
   */
  root?: string;
  /** Called whenever the archive moves: a file opened, a piece written, a piece taken by the reader. */
  onActivity?: () => void;
}

/**
 * The archive as a byte stream. Destroy it to stop: reading and compressing
 * stop with it and every file handle is let go.
 */
export function zipStream(files: readonly ZipFile[], options: ZipStreamOptions = {}): Readable {
  return Readable.from(writeArchive(files, options), { objectMode: false });
}
