import { localNode, remoteEnabled } from "@/lib/remote/config";
import { CLOUD_HOME, isDeviceHome, type ChatHome } from "@/lib/remote/types";
import type { BoardCard } from "@/lib/board/types";

/**
 * Where a card runs when a workspace and a computer are paired, and which side
 * keeps the board.
 *
 * Both sides show the same board - its folder travels with the conversations -
 * but only one carries it out: the cloud. It starts every card, writes how each
 * run went, and runs a card that lives on a computer by handing the turn to
 * that computer exactly as a chat that lives there is handed over: through the
 * relay and the computer's own consent. Letting the computer start cards from
 * the synced folder by itself would have been simpler and wrong: anything that
 * can write a file in the workspace - its agent included - could then put a
 * card on the board that runs on the person's computer without that computer
 * ever being asked.
 *
 * - In a pair, a card without a home runs in the cloud: what runs while the
 *   computer is shut has to be the cloud's.
 * - Where there is no pair, this side keeps its own board and runs the cards
 *   that are its own: those with no home, and those whose home is this side -
 *   a workspace is told it is the cloud whether or not it is paired, so the
 *   cards it gave "cloud" while it was keep running once the pairing is off.
 *   Any other home belongs to a pair this side is not part of right now (a
 *   computer that has signed out is told no name at all) and is never started
 *   here.
 */

/** Whether this side carries the board out: the cloud in a pair, any side without one. */
export function boardRunsHere(): boolean {
  return !remoteEnabled() || localNode() === CLOUD_HOME;
}

/** The side a card runs on, or null where there is no pair. */
export function cardHome(card: Pick<BoardCard, "home">): ChatHome | null {
  if (!remoteEnabled()) return null;
  return card.home ?? CLOUD_HOME;
}

/** Whether this side starts the card - running it here, or handing it to the computer it lives on. */
export function cardStartedHere(card: Pick<BoardCard, "home">): boolean {
  if (!remoteEnabled()) return !card.home || card.home === localNode();
  return localNode() === CLOUD_HOME;
}

/** Whether the card runs on a computer, which the cloud reaches through the relay. */
export function cardRunsOnComputer(card: Pick<BoardCard, "home">): boolean {
  return isDeviceHome(cardHome(card));
}

/** The home a new card gets when nobody chose one: the cloud in a pair, nothing elsewhere. */
export function defaultCardHome(): ChatHome | undefined {
  return remoteEnabled() ? CLOUD_HOME : undefined;
}

/**
 * Whether this side may give a card that home. A computer can put a card in the
 * cloud or on itself, never on another computer: two computers reach each other
 * only through the workspace, as their chats do.
 */
export function homeAllowedHere(home: ChatHome): boolean {
  const me = localNode();
  if (!remoteEnabled() || !me) return false;
  if (me === CLOUD_HOME) return true;
  return home === CLOUD_HOME || home === me;
}
