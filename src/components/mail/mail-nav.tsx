"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Mail } from "lucide-react";
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

/** How many people the sidebar lists before it says "all messages". */
const SHOWN = 5;

export function mailThreadPath(contactId: string): string {
  return `/dashboard/messages/${encodeURIComponent(contactId)}`;
}

/**
 * The Messages section of the sidebar: one row per person, newest first, with
 * what is unread from each. Absent when the workspace has no messages.
 */
export function MailNav() {
  const { t } = useI18n();
  const pathname = usePathname();
  const answer = useMailContacts();
  if (!answer || !answer.enabled || answer.contacts.length === 0) return null;
  const shown = answer.contacts.slice(0, SHOWN);
  const hidden = answer.contacts.slice(SHOWN);
  const hiddenUnread = hidden.reduce((sum, contact) => sum + contact.unread, 0);

  return (
    <SidebarGroup>
      <SidebarGroupLabel>
        <Mail className="size-3.5 mr-1" aria-hidden />
        {t("nav.messages")}
      </SidebarGroupLabel>
      <SidebarMenu>
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
                <SidebarMenuBadge aria-label={t("nav.messagesUnread", { count: contact.unread })} className="bg-primary text-primary-foreground rounded-full px-1.5">
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
              <SidebarMenuBadge aria-label={t("nav.messagesUnread", { count: hiddenUnread })} className="bg-primary text-primary-foreground rounded-full px-1.5">
                {hiddenUnread > 99 ? "99+" : hiddenUnread}
              </SidebarMenuBadge>
            ) : null}
          </SidebarMenuItem>
        ) : null}
      </SidebarMenu>
    </SidebarGroup>
  );
}
