"use client";

/**
 * A text file laid out for paper, and the print dialog opened on it: Markdown
 * as a document, anything else as its text - a file of this workspace
 * (`project` and `path`), or one a colleague shared (`share`). Pages (HTML)
 * print themselves (/api/files/page-print and /api/shares/<id>/print send
 * them elsewhere).
 */

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const MARKDOWN = /\.(md|markdown|mdx)$/i;

function resolveImage(project: string, filePath: string, src: string): string {
  if (/^(https?:|data:|blob:)/i.test(src)) return src;
  const folder = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/") + 1) : "";
  const parts: string[] = [];
  for (const part of `${folder}${decodeURIComponent(src)}`.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/api/files/download?${new URLSearchParams({ project, path: parts.join("/"), inline: "1" }).toString()}`;
}

export default function PrintPage() {
  const params = useSearchParams();
  const share = params.get("share") || "";
  const project = params.get("project") || "none";
  const [filePath, setFilePath] = useState(params.get("path") || "");
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const url = share
      ? `/api/shares/${encodeURIComponent(share)}/text`
      : `/api/files/content?${new URLSearchParams({ project, path: params.get("path") || "" }).toString()}`;
    fetch(url, { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json()) as { content?: string; text?: string; name?: string };
        const body = share ? data.text : data.content;
        if (!response.ok || typeof body !== "string") throw new Error("failed");
        if (share && data.name) setFilePath(data.name);
        setText(body);
      })
      .catch(() => setFailed(true));
  }, [project, share, params]);

  useEffect(() => {
    if (text === null) return;
    document.title = (filePath.split("/").pop() || "document").replace(/\.[^.]+$/, "");
    const images = Array.from(document.images).filter((image) => !image.complete);
    const ready = Promise.all(images.map((image) => new Promise((resolve) => {
      image.addEventListener("load", resolve, { once: true });
      image.addEventListener("error", resolve, { once: true });
    })));
    void Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 4000))]).then(() => setTimeout(() => window.print(), 150));
  }, [text, filePath]);

  if (failed) return <p className="p-8 text-sm">This file cannot be printed.</p>;
  if (text === null) return null;
  // A shared file brings no pictures of its own folder: only one on the web shows.
  const components: Components = {
    img: ({ src, alt }) =>
      typeof src !== "string" ? null : share ? (/^(https?:|data:)/i.test(src) ? <img src={src} alt={alt || ""} /> : <span>{alt || ""}</span>) : <img src={resolveImage(project, filePath, src)} alt={alt || ""} />,
  };
  return (
    <main className="eggent-print mx-auto max-w-[46rem] px-8 py-10 text-[11pt]/[1.55] text-black">
      {MARKDOWN.test(filePath) ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
      ) : (
        <pre className="whitespace-pre-wrap break-words font-mono text-[9.5pt]/[1.5]">{text}</pre>
      )}
      <style>{`
        html, body { background: #fff !important; color: #000; }
        @page { margin: 16mm; }
        .eggent-print h1 { font-size: 20pt; font-weight: 700; margin: 0 0 10pt; line-height: 1.2; }
        .eggent-print h2 { font-size: 15pt; font-weight: 650; margin: 16pt 0 6pt; break-after: avoid; }
        .eggent-print h3 { font-size: 12.5pt; font-weight: 650; margin: 12pt 0 4pt; break-after: avoid; }
        .eggent-print p, .eggent-print ul, .eggent-print ol, .eggent-print table, .eggent-print pre, .eggent-print blockquote { margin: 0 0 8pt; }
        .eggent-print ul { list-style: disc; padding-left: 18pt; }
        .eggent-print ol { list-style: decimal; padding-left: 18pt; }
        .eggent-print a { color: #1d4ed8; text-decoration: underline; }
        .eggent-print code { font-family: ui-monospace, Menlo, monospace; font-size: 9.5pt; }
        .eggent-print pre { background: #f5f5f5; padding: 8pt; border-radius: 4pt; break-inside: avoid; }
        .eggent-print blockquote { border-left: 3pt solid #d4d4d4; padding-left: 10pt; color: #404040; }
        .eggent-print table { border-collapse: collapse; width: 100%; break-inside: avoid; }
        .eggent-print th, .eggent-print td { border: 1px solid #d4d4d4; padding: 4pt 6pt; text-align: left; vertical-align: top; }
        .eggent-print img { max-width: 100%; break-inside: avoid; }
        .eggent-print hr { border: 0; border-top: 1px solid #d4d4d4; margin: 12pt 0; }
      `}</style>
    </main>
  );
}
