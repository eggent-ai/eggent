/**
 * Where a chat runs.
 *
 * A workspace and a computer that is paired with it hold the same chats - the
 * files travel both ways - so the same conversation can be continued from
 * either. Left alone, a message runs wherever it is typed. A chat that has a
 * home runs there instead, whichever of the two the person is typing in: the
 * other side hands the message over, shows the answer as it streams, and the
 * stored chat comes back through the ordinary file sync.
 *
 * Only these two shapes exist. A computer never hands a chat to another
 * computer: the workspace is the one place every device already talks to.
 */
export type ChatHome = "cloud" | `device:${string}`;

export const CLOUD_HOME: ChatHome = "cloud";

const DEVICE_HOME = /^device:[A-Za-z0-9._-]{1,128}$/;

/** A valid home, or undefined for anything else. Never trusts a stored value to be well formed. */
export function parseHome(value: unknown): ChatHome | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === CLOUD_HOME) return CLOUD_HOME;
  return DEVICE_HOME.test(trimmed) ? (trimmed as ChatHome) : undefined;
}

export function isDeviceHome(home: ChatHome | null | undefined): home is `device:${string}` {
  return typeof home === "string" && home.startsWith("device:");
}

/**
 * What one side has of a chat, in the two places a turn reads it from.
 *
 * The screen reads the stored chat, the agent reads its own record of the
 * conversation (the pi session), and the two travel as separate files. A turn
 * handed to the other side is only safe once that side holds both up to the
 * point the person is at, so the handing side says where it is and the other
 * checks it already has that - or something later.
 */
export interface ChatHead {
  /** How many messages the stored chat holds. Informational; the id below is what is compared. */
  messages: number;
  /** The id of the last stored message of any role, or null for an empty chat. */
  lastMessageId: string | null;
  /** The id of the last entry in the agent's own record, or null when there is none yet. */
  sessionLeaf: string | null;
}

export const EMPTY_HEAD: ChatHead = { messages: 0, lastMessageId: null, sessionLeaf: null };

/** A computer the workspace can hand a chat to, as the control plane reports it. */
export interface RemoteDevice {
  /** The chat home that names it: `device:<id>`. */
  node: ChatHome;
  /** What the person called it, for the switch. */
  name: string;
  /** Connected to the control plane right now. */
  online: boolean;
  /**
   * How it treats a chat handed to it: "ask" shows a question the first time
   * for each chat, "always" does not. Null when the app does not take tasks.
   */
  accept: "ask" | "always" | null;
  /** The app has the chat history folders shared, so a handed-over chat can be found there. */
  historyShared: boolean;
  lastSeenAt: string | null;
}

/** Everything the chat screen needs to draw the switch. */
export interface RemoteStatus {
  enabled: boolean;
  /** This process: "cloud" in a workspace, `device:<id>` in the app. */
  node: ChatHome | null;
  /** The name of this process, for the switch ("This computer", the computer's name, "Cloud"). */
  nodeName: string | null;
  /** On the workspace: its paired computers. On a computer: empty (the only other place is the cloud). */
  devices: RemoteDevice[];
  /** Whether the control plane could be reached for the answer above. */
  reachable: boolean;
}

/** Request headers that mark and describe a turn handed over from another side. */
export const REMOTE_HEADERS = {
  /** "1" on every handed-over request: the receiving side runs it here and never hands it on. */
  relayed: "x-eggent-relayed",
  /** The side that handed it over. */
  from: "x-eggent-from",
  /** The sender's `ChatHead`, JSON in base64url. */
  expectHead: "x-eggent-expect-head",
  /** The home to record on the chat, so a stale copy of the file cannot lose a switch. */
  home: "x-eggent-home",
  /** The chat's title, URI-encoded, for the question a computer asks before it runs it. */
  title: "x-eggent-chat-title",
  /** "0" when nobody is looking at the screen of this turn (a messenger asked): a question cannot be put to anyone. */
  interactive: "x-eggent-interactive",
} as const;

export type RemoteFailureCode =
  | "disabled"
  | "offline"
  | "denied"
  | "not-ready"
  | "not-synced"
  | "busy"
  | "failed"
  | "timeout";

/** A handed-over turn that could not run, with a reason a screen can translate. */
export class RemoteError extends Error {
  readonly code: RemoteFailureCode;
  readonly status: number;
  readonly home?: ChatHome;

  constructor(code: RemoteFailureCode, message: string, options: { status?: number; home?: ChatHome } = {}) {
    super(message);
    this.name = "RemoteError";
    this.code = code;
    this.status = options.status ?? statusFor(code);
    this.home = options.home;
  }
}

function statusFor(code: RemoteFailureCode): number {
  switch (code) {
    case "disabled":
      return 404;
    case "denied":
      return 403;
    case "timeout":
      return 504;
    case "failed":
      return 502;
    default:
      return 409;
  }
}

export function encodeHead(head: ChatHead): string {
  return Buffer.from(JSON.stringify(head), "utf-8").toString("base64url");
}

/** The head a request carries, or null when it carries none or one that does not parse. */
export function decodeHead(value: string | null | undefined): ChatHead | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf-8")) as Partial<ChatHead>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      messages: typeof parsed.messages === "number" && Number.isFinite(parsed.messages) ? parsed.messages : 0,
      lastMessageId: typeof parsed.lastMessageId === "string" && parsed.lastMessageId ? parsed.lastMessageId : null,
      sessionLeaf: typeof parsed.sessionLeaf === "string" && parsed.sessionLeaf ? parsed.sessionLeaf : null,
    };
  } catch {
    return null;
  }
}
