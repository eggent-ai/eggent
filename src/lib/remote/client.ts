import type { ChatHome, RemoteDevice, RemoteFailureCode, RemoteStatus } from "@/lib/remote/types";

/**
 * What the chat screen needs to know about places, with no server code in it.
 */

export interface HandoverFailure {
  message: string;
  code?: RemoteFailureCode;
  home?: ChatHome;
}

const CODES = new Set(["disabled", "offline", "denied", "not-ready", "not-synced", "busy", "not-running", "failed", "timeout"]);

/**
 * A failed send, as a refusal to hand the message over - or null when it was
 * something else. The chat transport throws the response body as the error's
 * message, so a refusal arrives as the JSON the route wrote.
 */
export function parseHandoverFailure(error: unknown): HandoverFailure | null {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!raw.trimStart().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; code?: unknown; home?: unknown };
    if (typeof parsed.code !== "string" || !CODES.has(parsed.code)) return null;
    return {
      message: typeof parsed.error === "string" ? parsed.error : raw,
      code: parsed.code as RemoteFailureCode,
      ...(typeof parsed.home === "string" ? { home: parsed.home as ChatHome } : {}),
    };
  } catch {
    return null;
  }
}

/** Refusals that moving the chat to this side fixes. */
export function canRunHereInstead(failure: HandoverFailure): boolean {
  return failure.code === "offline" || failure.code === "not-ready" || failure.code === "denied" || failure.code === "timeout";
}

export type PlaceChoice =
  | { node: ChatHome; label: "cloud" | "thisComputer" | "device"; name?: string; here: boolean; available: true }
  | { node: ChatHome; label: "cloud" | "thisComputer" | "device"; name?: string; here: boolean; available: false; reason: "offline" | "not-ready" | "cloud-unreachable" };

/** The places a chat can be sent, for the menu: this side first, then the other. */
export function placeChoices(status: RemoteStatus): PlaceChoice[] {
  if (!status.enabled || !status.node) return [];
  const here = status.node;
  const choices: PlaceChoice[] = [];

  if (here === "cloud") {
    choices.push({ node: "cloud", label: "cloud", here: true, available: true });
    for (const device of status.devices) choices.push(deviceChoice(device, here));
  } else {
    choices.push({ node: here, label: "thisComputer", here: true, available: true });
    choices.push(
      status.reachable
        ? { node: "cloud", label: "cloud", here: false, available: true }
        : { node: "cloud", label: "cloud", here: false, available: false, reason: "cloud-unreachable" }
    );
  }
  return choices;
}

function deviceChoice(device: RemoteDevice, here: ChatHome): PlaceChoice {
  const base = { node: device.node, label: "device" as const, name: device.name, here: device.node === here };
  if (!device.online || !device.accept) return { ...base, available: false, reason: "offline" };
  if (!device.historyShared) return { ...base, available: false, reason: "not-ready" };
  return { ...base, available: true };
}

/**
 * Whether there is nothing to choose between, so the control is left out.
 *
 * A workspace with no computer paired to it has one place to run a chat. A chat
 * that is left pointing at a computer that has since been unpaired is the
 * exception: it needs the way back to the cloud, so it keeps the control.
 */
export function nothingToChoose(status: RemoteStatus, home: ChatHome | null | undefined): boolean {
  if (placeChoices(status).length >= 2) return false;
  return home == null || choiceFor(status, home) !== null;
}

/** The choice a stored home stands for, or null when it names a place that is not on the list (an unpaired computer). */
export function choiceFor(status: RemoteStatus, home: ChatHome | null | undefined): PlaceChoice | null {
  const effective = home ?? status.node;
  return placeChoices(status).find((choice) => choice.node === effective) ?? null;
}
