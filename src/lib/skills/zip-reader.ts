/**
 * A small reader for ZIP archives, built to be pointed at a file somebody else
 * made.
 *
 * An uploaded skill is a stranger's archive, so nothing it says about itself is
 * taken on trust. The central directory is read first and costs next to
 * nothing; an entry is inflated only when the caller asks for it, and never past
 * the size the directory declared - the inflater is told that size as its
 * ceiling, so an entry that claims to be 1 KB and unpacks to a gigabyte stops
 * at 1 KB and is reported as damaged. Every entry is also checked against its
 * CRC, which is what tells a cut-off download from a good one.
 *
 * What it does not read is as deliberate as what it does: ZIP64, split
 * archives, encryption and compression other than stored/deflate all raise
 * `unsupported` or `encrypted`, because a skill is a few text files and an
 * archive that needs more than that has something else going on. Deciding what
 * a path may be called, which entries to ignore and how much is too much is the
 * caller's job; this module only reads.
 */
import { promisify } from "node:util";
import zlib from "node:zlib";

const inflateRaw = promisify(zlib.inflateRaw);

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const END_RECORD_BYTES = 22;
const MAX_ARCHIVE_COMMENT = 0xffff;

const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

export type ZipFailure = "not-zip" | "unsupported" | "encrypted" | "corrupt";

/** `detail` says what was unsupported or which entry is damaged. */
export class ZipError extends Error {
  readonly code: ZipFailure;
  readonly detail: string;

  constructor(code: ZipFailure, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

export type ZipEntryKind = "file" | "directory" | "link";

export interface ZipEntry {
  /** The name as stored, with backslashes read as separators. */
  path: string;
  /** A link, device, pipe or socket is `link`: a skill carries none of them. */
  kind: ZipEntryKind;
  /** Whether the archive marks the file as executable (Unix archives only). */
  executable: boolean;
  /** Uncompressed size as declared - a claim, enforced when the entry is read. */
  size: number;
  compressedSize: number;
  method: number;
  crc: number;
  encrypted: boolean;
  localOffset: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) value = CRC_TABLE[(value ^ data[i]) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function findEndRecord(data: Buffer): number {
  if (data.length < END_RECORD_BYTES) throw new ZipError("not-zip");
  const lowest = Math.max(0, data.length - END_RECORD_BYTES - MAX_ARCHIVE_COMMENT);
  for (let at = data.length - END_RECORD_BYTES; at >= lowest; at -= 1) {
    if (data.readUInt32LE(at) !== END_SIGNATURE) continue;
    // A signature inside the archive comment is not the record: the comment it
    // would announce has to fit in what is left of the file.
    if (at + END_RECORD_BYTES + data.readUInt16LE(at + 20) > data.length) continue;
    return at;
  }
  throw new ZipError("not-zip");
}

function decodeName(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Names written in a legacy code page: keep every byte distinct instead of
    // letting two different names collapse into the same replacement characters.
    return bytes.toString("latin1");
  }
}

/** The entries an archive lists, without reading any of their contents. */
export function listZip(data: Buffer): ZipEntry[] {
  const end = findEndRecord(data);
  if (end >= 20 && data.readUInt32LE(end - 20) === ZIP64_LOCATOR_SIGNATURE) throw new ZipError("unsupported", "ZIP64");

  const diskNumber = data.readUInt16LE(end + 4);
  const directoryDisk = data.readUInt16LE(end + 6);
  const entriesOnDisk = data.readUInt16LE(end + 8);
  const total = data.readUInt16LE(end + 10);
  const directorySize = data.readUInt32LE(end + 12);
  const directoryOffset = data.readUInt32LE(end + 16);
  if (total === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new ZipError("unsupported", "ZIP64");
  }
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== total) {
    throw new ZipError("unsupported", "split archive");
  }
  const directoryEnd = directoryOffset + directorySize;
  if (directoryEnd > end) throw new ZipError("corrupt", "central directory");

  const entries: ZipEntry[] = [];
  let at = directoryOffset;
  for (let index = 0; index < total; index += 1) {
    if (at + 46 > directoryEnd || data.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw new ZipError("corrupt", "central directory");
    }
    const madeBy = data.readUInt16LE(at + 4);
    const flags = data.readUInt16LE(at + 8);
    const method = data.readUInt16LE(at + 10);
    const crc = data.readUInt32LE(at + 16);
    const compressedSize = data.readUInt32LE(at + 20);
    const size = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    const attributes = data.readUInt32LE(at + 38);
    const localOffset = data.readUInt32LE(at + 42);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > directoryEnd) throw new ZipError("corrupt", "central directory");
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError("unsupported", "ZIP64");
    }

    const path = decodeName(data.subarray(at + 46, at + 46 + nameLength)).replace(/\\/g, "/");
    // The Unix file mode rides in the top half of the attributes, and only when
    // the archive says it was made on Unix; anywhere else those bits are noise.
    const mode = madeBy >> 8 === 3 ? (attributes >>> 16) & 0xffff : 0;
    const type = mode & 0o170000;
    let kind: ZipEntryKind = "file";
    if (type === 0o040000 || path.endsWith("/")) kind = "directory";
    else if (type !== 0 && type !== 0o100000) kind = "link";

    entries.push({
      path,
      kind,
      executable: kind === "file" && (mode & 0o111) !== 0,
      size,
      compressedSize,
      method,
      crc,
      encrypted: (flags & 0x41) !== 0,
      localOffset,
    });
    at = next;
  }
  return entries;
}

/**
 * The contents of one entry.
 *
 * The caller has already decided the declared size is acceptable; this makes
 * the entry live up to it.
 */
export async function readZipEntry(data: Buffer, entry: ZipEntry): Promise<Buffer> {
  if (entry.encrypted) throw new ZipError("encrypted", entry.path);
  if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATED) {
    throw new ZipError("unsupported", `compression method ${entry.method}`);
  }

  const header = entry.localOffset;
  if (header + 30 > data.length || data.readUInt32LE(header) !== LOCAL_SIGNATURE) {
    throw new ZipError("corrupt", entry.path);
  }
  const start = header + 30 + data.readUInt16LE(header + 26) + data.readUInt16LE(header + 28);
  const stop = start + entry.compressedSize;
  if (stop > data.length) throw new ZipError("corrupt", entry.path);
  const packed = data.subarray(start, stop);

  let contents: Buffer;
  if (entry.size === 0) {
    contents = Buffer.alloc(0);
  } else if (entry.method === METHOD_STORED) {
    contents = packed;
  } else {
    try {
      contents = await inflateRaw(packed, { maxOutputLength: entry.size });
    } catch {
      throw new ZipError("corrupt", entry.path);
    }
  }
  if (contents.length !== entry.size || crc32(contents) !== entry.crc) throw new ZipError("corrupt", entry.path);
  return contents;
}
