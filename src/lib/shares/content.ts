import path from "node:path";
import { comparisonOf } from "@/lib/files/versions/rules";
import { extractVersionText } from "@/lib/files/versions/text";
import { fetchSharedFile } from "@/lib/shares/client";

/**
 * What a shared file holds, the way its screen shows it: text to read (and,
 * with "edit", to change), the words read out of a document, a picture, or
 * something only to download.
 */

const MAX_TEXT_BYTES = 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

export type SharedContent =
  | { kind: "text"; text: string; name: string; mime: string; size: number; sha256: string }
  | { kind: "extracted"; text: string; truncated: boolean; name: string; mime: string; size: number; sha256: string }
  | { kind: "image" | "binary"; name: string; mime: string; size: number; sha256: string };

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
}

export async function readSharedContent(id: string): Promise<SharedContent> {
  const file = await fetchSharedFile(id);
  const facts = { name: file.name, mime: file.mime, size: file.data.length, sha256: file.sha256 };
  if (IMAGE_EXTENSIONS.has(path.extname(file.name).toLowerCase())) return { kind: "image", ...facts };
  if (comparisonOf(file.name) === "extracted") {
    const extracted = await extractVersionText(file.name, file.data);
    return extracted.kind === "none" ? { kind: "binary", ...facts } : { kind: "extracted", text: extracted.text, truncated: Boolean(extracted.truncated), ...facts };
  }
  if (file.data.length > MAX_TEXT_BYTES || looksBinary(file.data)) return { kind: "binary", ...facts };
  return { kind: "text", text: file.data.toString("utf8").replace(/^﻿/, ""), ...facts };
}
