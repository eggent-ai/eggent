"use client";

import Link from "next/link";
import { Brain } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { sentenceKey } from "@/lib/learning/sentences";
import type { LearnedNotice } from "@/lib/learning/types";
import { ORCHESTRATOR_SCOPE_ID, SCOPE_PARAM } from "@/lib/orchestrator-scope";

/**
 * Under an answer: what the agent wrote down after it.
 *
 * It keeps notes about the person and procedures for itself, and a person can
 * only object to what they can read - so the note is quoted, not announced.
 * Quiet on purpose: small, muted, below the answer, with a way to the page
 * where it can be taken back.
 */
export function LearnedNote({ notice }: { notice: LearnedNotice }) {
  const { t } = useI18n();
  const lines = notice.items
    .map((item) => {
      const key = sentenceKey(item);
      return key ? { id: `${item.kind}:${item.action}:${item.text}`, text: t(key, { text: item.text }) } : null;
    })
    .filter((line): line is { id: string; text: string } => Boolean(line));
  if (lines.length === 0) return null;

  const onlySkills = notice.items.every((item) => item.kind === "skill");
  const href = `${onlySkills ? "/dashboard/skills" : "/dashboard/memory"}?${SCOPE_PARAM}=${ORCHESTRATOR_SCOPE_ID}`;

  return (
    <div
      className="flex items-start gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground"
      data-learned-notice
    >
      <Brain className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <ul className="min-w-0 flex-1 space-y-0.5">
        {lines.map((line) => (
          <li key={line.id} className="break-words">
            {line.text}
          </li>
        ))}
      </ul>
      <Link href={href} className="shrink-0 underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground">
        {t("learning.notice.open")}
      </Link>
    </div>
  );
}
