"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AtSign } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useI18n } from "@/i18n/provider";
import { useMailContacts } from "./use-mail-contacts";
import { useEmailStatus } from "@/components/email/use-email-status";
import { EMAIL_ROOT_PATH } from "@/components/email/paths";
import { SidebarCount } from "@/components/sidebar-count";
import { useArrivals } from "@/hooks/use-arrivals";

/** The wrapper the sidebar positions; the count draws itself (SidebarCount). */
const BADGE_SLOT = "px-0 min-w-0 top-1.5";

/** How many people the sidebar lists before it says "all messages". */
const SHOWN = 5;

export function mailThreadPath(contactId: string): string {
  return `/dashboard/messages/${encodeURIComponent(contactId)}`;
}

/**
 * The Messages section of the sidebar: the agent's Mail first, when the
 * workspace has a mailbox, then one row per person of the company, newest
 * first, with what is unread from each. Absent when there is neither.
 */
export function MailNav({ className }: { className?: string } = {}) {
  const { t } = useI18n();
  const pathname = usePathname();
  const answer = useMailContacts();
  const email = useEmailStatus();
  const contacts = answer && answer.enabled ? answer.contacts : [];
  const hasEmail = Boolean(email && email.enabled);
  const shown = contacts.slice(0, SHOWN);
  const arrived = useArrivals(shown.map((contact) => contact.id));
  if (!hasEmail && contacts.length === 0) return null;
  const hidden = contacts.slice(SHOWN);
  const hiddenUnread = hidden.reduce((sum, contact) => sum + contact.unread, 0);
  const emailUnread = email && email.enabled ? email.unread.inbox : 0;

  return (
    <SidebarGroup className={className}>
      <SidebarGroupLabel>{t("nav.messages")}</SidebarGroupLabel>
      <SidebarMenu>
        {hasEmail ? (
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={pathname === EMAIL_ROOT_PATH || pathname.startsWith(`${EMAIL_ROOT_PATH}/`)} title={email && email.enabled ? email.address || undefined : undefined}>
              <Link href={EMAIL_ROOT_PATH}>
                <AtSign className="size-4" aria-hidden />
                <span className={emailUnread > 0 ? "truncate font-medium" : "truncate"}>{t("nav.mail")}</span>
              </Link>
            </SidebarMenuButton>
            {emailUnread > 0 ? (
              <SidebarMenuBadge className={BADGE_SLOT}>
                <SidebarCount count={emailUnread} label={t("nav.messagesUnread", { count: emailUnread })} />
              </SidebarMenuBadge>
            ) : null}
          </SidebarMenuItem>
        ) : null}
        {shown.map((contact) => {
          const href = mailThreadPath(contact.id);
          return (
            <SidebarMenuItem key={contact.id} className={arrived(contact.id) ? "eggent-row-in" : undefined}>
              <SidebarMenuButton asChild isActive={pathname === href} title={contact.about || undefined}>
                <Link href={href}>
                  <span className={contact.unread > 0 ? "truncate font-medium" : "truncate"}>{contact.name}</span>
                </Link>
              </SidebarMenuButton>
              {contact.unread > 0 ? (
                <SidebarMenuBadge className={BADGE_SLOT}>
                <SidebarCount count={contact.unread} label={t("nav.messagesUnread", { count: contact.unread })} />
              </SidebarMenuBadge>
              ) : null}
            </SidebarMenuItem>
          );
        })}
        {hidden.length > 0 ? (
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={pathname === "/dashboard/messages"}>
              <Link href="/dashboard/messages">
                <span className="text-muted-foreground truncate">{t("nav.messagesAll")}</span>
              </Link>
            </SidebarMenuButton>
            {hiddenUnread > 0 ? (
              <SidebarMenuBadge className={BADGE_SLOT}>
                <SidebarCount count={hiddenUnread} label={t("nav.messagesUnread", { count: hiddenUnread })} />
              </SidebarMenuBadge>
            ) : null}
          </SidebarMenuItem>
        ) : null}
      </SidebarMenu>
    </SidebarGroup>
  );
}
