"use client";

import { useEffect } from "react";
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
    openChat(chatId, projectId);
  }, [chatId, projectId, openChat]);

  return null;
}
