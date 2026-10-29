"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AtSign, Mail } from "lucide-react";
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

/**
 * The count beside a row. The sidebar recolours a badge's text on an active
 * row (peer-data-[active=true]), which put dark digits on the dark badge - so
 * this says the colour again for that case.
 */
const UNREAD_BADGE = "bg-primary text-primary-foreground peer-data-[active=true]/menu-button:text-primary-foreground peer-hover/menu-button:text-primary-foreground rounded-full px-1.5";

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
export function MailNav() {
  const { t } = useI18n();
  const pathname = usePathname();
  const answer = useMailContacts();
  const email = useEmailStatus();
  const contacts = answer && answer.enabled ? answer.contacts : [];
  const hasEmail = Boolean(email && email.enabled);
  if (!hasEmail && contacts.length === 0) return null;
  const shown = contacts.slice(0, SHOWN);
  const hidden = contacts.slice(SHOWN);
  const hiddenUnread = hidden.reduce((sum, contact) => sum + contact.unread, 0);
  const emailUnread = email && email.enabled ? email.unread.inbox : 0;

  return (
    <SidebarGroup>
      <SidebarGroupLabel>
        <Mail className="size-3.5 mr-1" aria-hidden />
        {t("nav.messages")}
      </SidebarGroupLabel>
      <SidebarMenu>
        {hasEmail ? (
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={pathname === EMAIL_ROOT_PATH || pathname.startsWith(`${EMAIL_ROOT_PATH}/`)} title={email && email.enabled ? email.address || undefined : undefined}>
              <Link href={EMAIL_ROOT_PATH}>
                <AtSign className="size-3.5" aria-hidden />
                <span className={emailUnread > 0 ? "truncate font-medium" : "truncate"}>{t("nav.mail")}</span>
              </Link>
            </SidebarMenuButton>
            {emailUnread > 0 ? (
              <SidebarMenuBadge aria-label={t("nav.messagesUnread", { count: emailUnread })} className={UNREAD_BADGE}>
                {emailUnread > 99 ? "99+" : emailUnread}
              </SidebarMenuBadge>
            ) : null}
          </SidebarMenuItem>
        ) : null}
        {shown.map((contact) => {
          const href = mailThreadPath(contact.id);
          return (
            <SidebarMenuItem key={contact.id}>
              <SidebarMenuButton asChild isActive={pathname === href} title={contact.about || undefined}>
                <Link href={href}>
                  <span className={contact.unread > 0 ? "truncate font-medium" : "truncate"}>{contact.name}</span>
                </Link>
              </SidebarMenuButton>
              {contact.unread > 0 ? (
                <SidebarMenuBadge aria-label={t("nav.messagesUnread", { count: contact.unread })} className={UNREAD_BADGE}>
                  {contact.unread > 99 ? "99+" : contact.unread}
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
              <SidebarMenuBadge aria-label={t("nav.messagesUnread", { count: hiddenUnread })} className={UNREAD_BADGE}>
                {hiddenUnread > 99 ? "99+" : hiddenUnread}
              </SidebarMenuBadge>
            ) : null}
          </SidebarMenuItem>
        ) : null}
      </SidebarMenu>
    </SidebarGroup>
  );
}
