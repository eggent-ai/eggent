"use client";

import { useEffect } from "react";
import { chatPath } from "@/lib/dashboard-routes";
import { useAppStore } from "@/store/app-store";

/**
 * Puts the conversation named by the address on screen. Renders nothing.
 *
 * The address is the one place that says which chat is open, and this is how it
 * says so: the route resolves the chat on the server and hands the answer to
 * the store, which the composer and the sidebar were already reading. Anything
 * that opens a chat from inside the app writes the same two values before it
 * navigates, so this arrives to confirm rather than to change - except when the
 * page was opened from a link, which is the whole point of it.
 */
export function ChatRouteSync({
  chatId,
  projectId,
}: {
  chatId: string | null;
  /** Omitted means "leave the project where it is". */
  projectId?: string | null;
}) {
  const openChat = useAppStore((state) => state.openChat);

  useEffect(() => {
    // Only if the browser is still on the address this was rendered for.
    //
    // Routes settle in the order their payloads arrive, not the order they were
    // asked for: leave a conversation and come back before the first navigation
    // has landed, and the page for the address you left mounts after the one
    // you arrived at. It would then assert an address nobody is on any more -
    // a chat named in the bar with an empty composer underneath it and nothing
    // selected in the list. The address bar is the authority; a page that no
    // longer matches it has nothing to say.
    if (window.location.pathname !== chatPath(chatId)) return;
    openChat(chatId, projectId);
  }, [chatId, projectId, openChat]);

  return null;
}
