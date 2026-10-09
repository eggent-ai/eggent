"use client";

/**
 * What the conversation lends to a command card.
 *
 * A card sits deep inside a message - under a code block in an answer - and
 * needs two things from the chat around it: the name of the conversation it
 * belongs to, so the same block in another chat is not the same command, and a
 * way to put its result in front of the agent. Passed through context instead
 * of down five levels of props that have nothing to do with either.
 */
import { createContext, useContext } from "react";

export interface ShellActions {
  /** Which conversation the cards belong to. */
  chatId: string;
  /** False while the agent is mid-turn: a message would be refused anyway. */
  canAsk: boolean;
  /** Send this as the person's next message. */
  ask: (text: string) => void;
}

const ShellActionsContext = createContext<ShellActions>({
  chatId: "",
  canAsk: false,
  ask: () => undefined,
});

export const ShellActionsProvider = ShellActionsContext.Provider;

export function useShellActions(): ShellActions {
  return useContext(ShellActionsContext);
}
