import type { MessageKey, MessageValues } from "@/i18n/messages";
import { placeChoices, type PlaceChoice } from "@/lib/remote/client";
import { CLOUD_HOME, type ChatHome, type RemoteDevice, type RemoteStatus } from "@/lib/remote/types";

type Translate = (key: MessageKey, values?: MessageValues) => string;

/** Where a card runs, as the board shows it. */
export interface CardPlace {
  home: ChatHome;
  kind: "cloud" | "device";
  name: string;
  /** The place cannot take the card right now; it waits in the queue until it can. */
  away: boolean;
}

/** The name of a place, as the chat's own switch calls it. */
export function placeName(choice: Pick<PlaceChoice, "label" | "name">, t: Translate): string {
  if (choice.label === "cloud") return t("chat.runPlace.cloud");
  if (choice.label === "thisComputer") return t("chat.runPlace.thisComputer");
  return choice.name || t("chat.runPlace.yourComputer");
}

/**
 * Where a card runs, or null where there is no pair and the question does not
 * arise. `node` is this side, as the board said; the status adds the paired
 * computers and whether each can take a card right now, and may still be
 * loading - nothing is called away before it says so.
 */
export function cardPlace(home: ChatHome | undefined, node: ChatHome | null, status: RemoteStatus | null, t: Translate): CardPlace | null {
  if (!node) return null;
  const where = home ?? CLOUD_HOME;
  if (where === CLOUD_HOME) {
    return { home: where, kind: "cloud", name: t("chat.runPlace.cloud"), away: node !== CLOUD_HOME && status !== null && status.enabled && !status.reachable };
  }
  if (where === node) return { home: where, kind: "device", name: t("chat.runPlace.thisComputer"), away: Boolean(status?.self) && !takesCards(status!.self!) };
  const device = status?.devices.find((candidate) => candidate.node === where);
  return {
    home: where,
    kind: "device",
    name: device?.name || t("chat.runPlace.yourComputer"),
    away: status !== null && status.enabled && (!device || !takesCards(device)),
  };
}

/** Whether the cloud can hand a computer a card right now: the app is open, takes tasks, and shares the chats. */
function takesCards(device: RemoteDevice): boolean {
  return device.online && device.accept !== null && device.historyShared;
}

/**
 * The places a card can be given from this side: the chat's own list, plus the
 * place it already has when that is no longer on it - a computer since
 * unpaired - so that the way back to the cloud is a choice rather than a trap.
 */
export function cardPlaceChoices(status: RemoteStatus | null, current: ChatHome | null): PlaceChoice[] {
  if (!status?.enabled || !status.node) return [];
  const choices = placeChoices(status).map((choice): PlaceChoice =>
    // A chat typed here runs here whatever the app's setting; a card is started by the cloud, so it needs the app to take tasks.
    choice.label === "thisComputer" && status.self && !takesCards(status.self) ? { ...choice, available: false, reason: "offline" } : choice
  );
  if (current && !choices.some((choice) => choice.node === current)) {
    choices.push({ node: current, label: "device", here: false, available: false, reason: "offline" });
  }
  return choices;
}
