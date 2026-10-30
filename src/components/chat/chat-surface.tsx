"use client";

/**
 * Whose screen the conversation is drawn on.
 *
 * The workspace's own chat and a guest's - somebody asking a project that was
 * shared with them, from a public link or from another workspace of the company
 * - draw messages with the same components. A guest has no files panel and no
 * file routes in the workspace that answers, so what would open a file there is
 * drawn as plain text instead of a link that leads nowhere (or, worse, into the
 * guest's own workspace, which holds other files under the same names).
 */
import { createContext, useContext } from "react";

export interface ChatSurface {
  guest: boolean;
  /** Where a recording is turned into words, when not the workspace's own route. */
  transcribeUrl?: string;
}

const ChatSurfaceContext = createContext<ChatSurface>({ guest: false });

export const ChatSurfaceProvider = ChatSurfaceContext.Provider;

export function useChatSurface(): ChatSurface {
  return useContext(ChatSurfaceContext);
}
