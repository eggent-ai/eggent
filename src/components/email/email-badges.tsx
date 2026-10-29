"use client";

import { useI18n } from "@/i18n/provider";
import type { EmailSummary } from "@/lib/email/types";

/**
 * What the service checked about a letter, in a word or two: from the person,
 * a reply to the agent's letter, a sender in doubt, a letter that did not go.
 * Only facts the service vouched for; nothing here comes from the letter.
 */
export function EmailBadges({ letter }: { letter: EmailSummary }) {
  const { t } = useI18n();
  const badges: Array<{ key: string; text: string; tone: "plain" | "warn" }> = [];
  if (letter.direction === "in" && letter.fromOwner) badges.push({ key: "owner", text: t("email.badge.owner"), tone: "plain" });
  if (letter.direction === "in" && letter.threadReply) badges.push({ key: "reply", text: t("email.badge.reply"), tone: "plain" });
  if (letter.direction === "in" && letter.suspicious) badges.push({ key: "doubt", text: t("email.badge.doubtful"), tone: "warn" });
  if (letter.direction === "out" && letter.error) badges.push({ key: "notSent", text: t("email.badge.notSent"), tone: "warn" });
  if (!badges.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {badges.map((badge) => (
        <span
          key={badge.key}
          className={
            badge.tone === "warn"
              ? "rounded border border-warning px-1.5 text-[11px]/4 text-foreground"
              : "rounded border px-1.5 text-[11px]/4 text-muted-foreground"
          }
        >
          {badge.text}
        </span>
      ))}
    </span>
  );
}
