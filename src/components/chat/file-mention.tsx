"use client";

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { fileDownloadUrl, filesPageUrl, isOpenableFile } from "@/lib/files/openable";

/**
 * A file path the agent named, turned into something you can click.
 *
 * The agent finishes by saying where it put the result, and until now that was
 * a piece of inline code: the person had to find the file panel, expand to the
 * right folder, click the file, land in the editor and then find the Open
 * button. For a built page that is five steps between "here is your site" and
 * seeing it.
 *
 * Only a path that really exists becomes a link. A dead link inside an answer is
 * worse than plain text, so an unverified path renders exactly as it did before.
 */

type Existence = "unknown" | "present" | "absent";

// One listing per directory, shared by every mention in every message. It
// expires, because the agent writes files as it works: a directory listed on the
// first pass would otherwise keep reporting the second pass's page as missing,
// and that mention would silently stay plain text.
const LISTING_TTL_MS = 30_000;
const listings = new Map<string, { at: number; entries: Promise<Set<string>> }>();

function directoryEntries(projectId: string, dir: string): Promise<Set<string>> {
  const key = `${projectId}|${dir}`;
  const cached = listings.get(key);
  if (cached && Date.now() - cached.at < LISTING_TTL_MS) return cached.entries;

  const pending = (async () => {
    try {
      const params = new URLSearchParams({ project: projectId, path: dir });
      const res = await fetch(`/api/files?${params.toString()}`);
      const data = await res.json();
      if (!Array.isArray(data)) return new Set<string>();
      return new Set<string>(
        data
          .filter((entry) => entry && entry.type === "file" && typeof entry.name === "string")
          .map((entry) => entry.name as string)
      );
    } catch {
      return new Set<string>();
    }
  })();

  listings.set(key, { at: Date.now(), entries: pending });
  return pending;
}

/** Forget what we listed, so a file written this turn stops looking absent. */
export function forgetFileListings(): void {
  listings.clear();
}

export function FileMention({ projectId, path, children }: {
  projectId: string;
  path: string;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const [exists, setExists] = useState<Existence>("unknown");

  useEffect(() => {
    let cancelled = false;
    const slash = path.lastIndexOf("/");
    const dir = slash === -1 ? "" : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    void directoryEntries(projectId, dir).then((names) => {
      if (!cancelled) setExists(names.has(name) ? "present" : "absent");
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, path]);

  if (exists !== "present") {
    return <code className="bg-muted px-1.5 py-0.5 rounded text-sm">{children}</code>;
  }

  const openable = isOpenableFile(path);
  // A page opens rendered, in its own tab. Anything else goes to the file's own
  // screen, where it can be read, edited and downloaded.
  const href = openable ? fileDownloadUrl(projectId, path, { inline: true }) : filesPageUrl(projectId, path);

  return (
    <a
      href={href}
      target={openable ? "_blank" : undefined}
      rel={openable ? "noopener noreferrer" : undefined}
      title={openable ? t("files.open") : t("files.openInEditor")}
      className="bg-muted hover:bg-accent inline-flex items-center gap-1 rounded px-1.5 py-0.5 align-baseline font-mono text-sm underline decoration-dotted underline-offset-2 transition-colors"
    >
      {children}
      {openable ? <ExternalLink className="size-3 shrink-0" aria-hidden /> : null}
    </a>
  );
}
