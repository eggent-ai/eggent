"use client";

import Link from "next/link";
import { Bot } from "lucide-react";
import { SkeletonList } from "@/components/ui/skeleton-list";
import { useI18n } from "@/i18n/provider";
import { mailThreadPath } from "./mail-nav";
import { useMailContacts } from "./use-mail-contacts";

/** Everybody this workspace can write to, newest conversation first. */
export function MailContactsList() {
  const { t, locale } = useI18n();
  const answer = useMailContacts();
  if (!answer) return <SkeletonList rows={3} />;
  if (!answer.enabled) return <p className="text-sm text-muted-foreground">{t("mail.unavailable")}</p>;
  if (answer.contacts.length === 0) return <p className="text-sm text-muted-foreground">{t("mail.noContacts")}</p>;
  return (
    <ul className="divide-y rounded-lg border">
      {answer.contacts.map((contact) => (
        <li key={contact.id}>
          <Link href={mailThreadPath(contact.id)} className="flex items-start justify-between gap-3 px-4 py-3 hover:bg-accent/50">
            <div className="min-w-0">
              <div className={`truncate text-sm ${contact.unread ? "font-semibold" : "font-medium"}`}>{contact.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {contact.role === "owner" ? t("mail.roleOwner") : contact.about ? t("mail.about", { about: contact.about }) : null}
              </div>
              {contact.lastMessage ? (
                <div className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                  {contact.lastMessage.authorKind === "agent" ? <Bot className="size-3 shrink-0" aria-hidden /> : null}
                  <span className="truncate">
                    {contact.lastMessage.fromMe ? `${t("mail.message.you")}: ` : ""}
                    {contact.lastMessage.preview}
                  </span>
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              {contact.lastMessageAt ? (
                <time className="text-xs text-muted-foreground" dateTime={contact.lastMessageAt}>
                  {new Date(contact.lastMessageAt).toLocaleDateString(locale, { day: "numeric", month: "short" })}
                </time>
              ) : null}
              {contact.unread > 0 ? (
                <span className="rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground" aria-label={t("nav.messagesUnread", { count: contact.unread })}>
                  {contact.unread}
                </span>
              ) : null}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
