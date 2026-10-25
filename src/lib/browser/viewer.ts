import { browserControl, browserToken, rememberedTarget } from "@/lib/browser/config";
import { browserCdpUrl } from "@/lib/browser/gateway";

/**
 * The picture of the agent's browser, for the Browser panel.
 *
 * This process keeps one CDP connection to the browser while somebody has the
 * panel open, asks it for a screencast of the page the agent's program works
 * on, and hands every frame to the panels that are listening. What the person
 * does in the panel - a click, a key, some text - goes back the same way, and
 * only while they have taken control: the agent's program refuses to act then,
 * so the two never fight over one page.
 *
 * Kept on globalThis because every route is compiled on its own and a module's
 * own state would be one copy per route.
 */

export type ViewerEvent =
  | { type: "frame"; data: string; width: number; height: number }
  /** `back` and `forward` say whether the page's history has somewhere to go. */
  | { type: "page"; url: string; title: string; back: boolean; forward: boolean }
  | { type: "closed"; reason: string };

export type ViewerInput =
  | { type: "click"; x: number; y: number }
  | { type: "wheel"; x: number; y: number; deltaY: number }
  | { type: "key"; key: string }
  | { type: "text"; text: string }
  /** An address already checked by `pageAddress`. */
  | { type: "navigate"; url: string }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" };

export type InputOutcome = "ok" | "not-yours" | "not-connected" | { failed: string };

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

interface ViewerState {
  ws: WebSocket | null;
  connecting: Promise<void> | null;
  sessionId: string | null;
  targetId: string | null;
  seq: number;
  pending: Map<number, Pending>;
  listeners: Set<(event: ViewerEvent) => void>;
  lastFrame: Extract<ViewerEvent, { type: "frame" }> | null;
  lastPage: Extract<ViewerEvent, { type: "page" }> | null;
  follow: ReturnType<typeof setInterval> | null;
  idle: ReturnType<typeof setTimeout> | null;
  /** Counts what is said about the page, so an older answer never lands after a newer one. */
  pageTurn: number;
  /** A page the agent's program named that this browser no longer has, so it is not tried again. */
  missing: string | null;
}

const KEY = Symbol.for("eggent.browser.viewer");
// Nobody watching for this long, and the connection goes: an open connection
// keeps the browser from closing when it is no longer used.
const LINGER_MS = 30_000;

function state(): ViewerState {
  const holder = globalThis as unknown as Record<symbol, ViewerState | undefined>;
  if (!holder[KEY]) {
    holder[KEY] = {
      ws: null, connecting: null, sessionId: null, targetId: null, seq: 0, pending: new Map(),
      listeners: new Set(), lastFrame: null, lastPage: null, follow: null, idle: null, pageTurn: 0, missing: null,
    };
  }
  return holder[KEY]!;
}

function emit(event: ViewerEvent): void {
  for (const listener of state().listeners) {
    try {
      listener(event);
    } catch {
      // A listener that throws is a panel that went away.
    }
  }
}

function sendTo(sessionId: string | null, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const current = state();
  const ws = current.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("The browser is not connected."));
  return new Promise((resolve, reject) => {
    const id = ++current.seq;
    current.pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

function send(method: string, params: Record<string, unknown> = {}, withSession = true): Promise<Record<string, unknown>> {
  return sendTo(withSession ? state().sessionId : null, method, params);
}

function disconnect(reason: string): void {
  const current = state();
  if (current.follow) clearInterval(current.follow);
  if (current.idle) clearTimeout(current.idle);
  current.follow = null;
  current.idle = null;
  const ws = current.ws;
  current.ws = null;
  current.sessionId = null;
  current.targetId = null;
  current.lastFrame = null;
  current.missing = null;
  for (const { reject } of current.pending.values()) reject(new Error("The browser connection closed."));
  current.pending.clear();
  try {
    ws?.close();
  } catch {
    // Already closed.
  }
  emit({ type: "closed", reason });
}

/**
 * Tell the panels which page is shown, and whether Back and Forward lead
 * anywhere - which only the page's own history knows, so it is asked each time.
 */
async function announcePage(url: string, title: string): Promise<void> {
  const current = state();
  const turn = ++current.pageTurn;
  let back = false;
  let forward = false;
  try {
    const history = await send("Page.getNavigationHistory");
    const index = Number(history.currentIndex);
    const count = Array.isArray(history.entries) ? history.entries.length : 0;
    back = index > 0;
    forward = index >= 0 && index < count - 1;
  } catch {
    // Between two documents; the next change asks again.
  }
  if (turn !== current.pageTurn) return;
  current.lastPage = { type: "page", url, title, back, forward };
  emit(current.lastPage);
}

async function attachTo(targetId: string): Promise<void> {
  const current = state();
  // The new page first, the old one let go after: a page the agent's program
  // named may be gone - a tab it closed, or a browser started afresh since -
  // and then the page already shown stays shown and answers the panel.
  const attached = await send("Target.attachToTarget", { targetId, flatten: true }, false);
  const previous = current.sessionId;
  current.sessionId = String(attached.sessionId);
  current.targetId = targetId;
  if (previous && previous !== current.sessionId) {
    await sendTo(previous, "Page.stopScreencast").catch(() => undefined);
    await send("Target.detachFromTarget", { sessionId: previous }, false).catch(() => undefined);
  }
  await send("Page.enable");
  await send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
  // A tab the agent's program switched to has a page of its own to name.
  const info = await send("Target.getTargetInfo", { targetId }, false).catch(() => ({}));
  const target = ((info as { targetInfo?: { url?: string; title?: string } }).targetInfo) || {};
  await announcePage(String(target.url || ""), String(target.title || ""));
}

async function pickTarget(): Promise<string | null> {
  const targets = await send("Target.getTargets", {}, false);
  const pages = ((targets.targetInfos as Array<{ targetId: string; type: string; url: string; title: string }>) || []).filter((t) => t.type === "page");
  const remembered = rememberedTarget();
  const page = pages.find((t) => t.targetId === remembered) || pages[0];
  return page?.targetId ?? null;
}

async function connect(): Promise<void> {
  const current = state();
  if (current.ws && current.ws.readyState === WebSocket.OPEN) return;
  if (current.connecting) return current.connecting;
  current.connecting = (async () => {
    // Node's WebSocket takes headers, which the browser's does not; this runs
    // in the server, never in the page.
    const ws = new (WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket)(
      browserCdpUrl(),
      { headers: { authorization: `Bearer ${browserToken()}` } },
    );
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("The browser could not be reached."));
    });
    current.ws = ws;
    ws.onmessage = (event) => {
      const message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8")) as {
        id?: number; result?: Record<string, unknown>; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string;
      };
      if (message.id && current.pending.has(message.id)) {
        const waiter = current.pending.get(message.id)!;
        current.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message || "CDP error"));
        else waiter.resolve(message.result || {});
        return;
      }
      if (message.method === "Page.screencastFrame" && message.sessionId === current.sessionId) {
        const params = message.params || {};
        const metadata = (params.metadata || {}) as { deviceWidth?: number; deviceHeight?: number };
        void send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => undefined);
        const frame = { type: "frame" as const, data: String(params.data || ""), width: Number(metadata.deviceWidth) || 1280, height: Number(metadata.deviceHeight) || 800 };
        current.lastFrame = frame;
        emit(frame);
      } else if (message.method === "Target.targetInfoChanged") {
        const info = (message.params?.targetInfo || {}) as { targetId?: string; url?: string; title?: string };
        if (info.targetId && info.targetId === current.targetId) void announcePage(String(info.url || ""), String(info.title || ""));
      }
    };
    ws.onclose = () => {
      if (current.ws === ws) disconnect("connection closed");
    };
    await send("Target.setDiscoverTargets", { discover: true }, false);
    const target = await pickTarget();
    if (target) await attachTo(target);
    // The agent's program may switch tabs or open a new one; the panel follows it.
    current.follow = setInterval(() => {
      const remembered = rememberedTarget();
      if (!remembered || remembered === current.targetId || remembered === current.missing) return;
      void attachTo(remembered).catch(() => {
        current.missing = remembered;
      });
    }, 2000);
    (current.follow as { unref?: () => void }).unref?.();
  })();
  try {
    await current.connecting;
  } catch (error) {
    disconnect("could not connect");
    throw error;
  } finally {
    current.connecting = null;
  }
}

/** Listen to the picture; the latest frame comes at once. Returns the way to stop. */
export async function watchBrowser(listener: (event: ViewerEvent) => void): Promise<() => void> {
  const current = state();
  current.listeners.add(listener);
  if (current.idle) {
    clearTimeout(current.idle);
    current.idle = null;
  }
  await connect();
  if (current.lastPage) listener(current.lastPage);
  if (current.lastFrame) listener(current.lastFrame);
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size === 0 && !current.idle) {
      current.idle = setTimeout(() => disconnect("nobody watching"), LINGER_MS);
      (current.idle as { unref?: () => void }).unref?.();
    }
  };
}

export function stopWatchingBrowser(reason: string): void {
  if (state().ws) disconnect(reason);
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string; key?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  PageDown: { code: "PageDown", keyCode: 34 },
  PageUp: { code: "PageUp", keyCode: 33 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
};

/**
 * What the person does in the panel, on the page. Only while they have taken
 * control: otherwise a stray click on the picture would act on a page the
 * agent is in the middle of.
 */
export async function sendBrowserInput(input: ViewerInput): Promise<InputOutcome> {
  if (browserControl() !== "person") return "not-yours";
  const current = state();
  if (!current.ws || !current.sessionId) return "not-connected";
  if (input.type === "navigate") {
    const result = await send("Page.navigate", { url: input.url });
    if (result.errorText) return { failed: String(result.errorText) };
  } else if (input.type === "back" || input.type === "forward") {
    const history = await send("Page.getNavigationHistory");
    const entries = (history.entries as Array<{ id: number }>) || [];
    const entry = entries[Number(history.currentIndex) + (input.type === "back" ? -1 : 1)];
    if (entry) await send("Page.navigateToHistoryEntry", { entryId: entry.id });
  } else if (input.type === "reload") {
    await send("Page.reload");
  } else if (input.type === "click") {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x: input.x, y: input.y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 });
    }
  } else if (input.type === "wheel") {
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: input.x, y: input.y, deltaX: 0, deltaY: input.deltaY });
  } else if (input.type === "text") {
    await send("Input.insertText", { text: input.text });
  } else if (input.type === "key") {
    const key = KEYS[input.key];
    if (!key) return "ok";
    const base = { key: key.key || input.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode };
    await send("Input.dispatchKeyEvent", { type: key.text ? "keyDown" : "rawKeyDown", ...base, ...(key.text ? { text: key.text } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
  return "ok";
}

export function browserViewerKeys(): string[] {
  return Object.keys(KEYS);
}
