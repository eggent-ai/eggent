"use client";

/**
 * The agent's browser, in a panel of its own beside the chat.
 *
 * The agent drives a real browser on a machine of the deployment's with a
 * program in its shell; this panel shows the page it is on, live, and lets the
 * person take control - to sign in, type a one-time code or get past a
 * captcha - and hand it back. While the person has control the agent's
 * program waits, so the two never act on one page at once.
 *
 * Shown only where the deployment offers a browser: the button and the panel
 * ask /api/browser/status first and stay away when it says there is none.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";
import { create } from "zustand";
import { Globe, Hand, Loader2, LogOut, Power, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";

interface BrowserStatus {
  available: boolean;
  open?: boolean;
  minutes?: { monthly: number; used: number; left: number };
  control?: "agent" | "person";
  error?: string;
}

interface Frame {
  data: string;
  width: number;
  height: number;
}

const OPEN_KEY = "eggent.browserPanelOpen";

interface PanelState {
  open: boolean;
  status: BrowserStatus | null;
  loaded: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setStatus: (status: BrowserStatus | null) => void;
}

function remember(open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // The panel still works for this page.
  }
}

const useBrowserPanel = create<PanelState>((set) => ({
  open: false,
  status: null,
  loaded: false,
  setOpen: (open) => {
    remember(open);
    set({ open });
  },
  toggle: () =>
    set((state) => {
      remember(!state.open);
      return { open: !state.open };
    }),
  setStatus: (status) => set({ status, loaded: true }),
}));

let statusRequest: Promise<void> | null = null;

/** One request at a time for the whole page, whichever component asks. */
function refreshStatus(): Promise<void> {
  if (statusRequest) return statusRequest;
  statusRequest = fetch("/api/browser/status", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : { available: false }))
    .then((status: BrowserStatus) => useBrowserPanel.getState().setStatus(status))
    .catch(() => useBrowserPanel.getState().setStatus({ available: false }))
    .finally(() => {
      statusRequest = null;
    });
  return statusRequest;
}

async function post(path: string, body: unknown, method = "POST"): Promise<Response> {
  return fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const SPECIAL_KEYS = new Set(["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "PageDown", "PageUp", "Home", "End"]);

export function BrowserPanel() {
  const { t } = useI18n();
  const open = useBrowserPanel((state) => state.open);
  const status = useBrowserPanel((state) => state.status);
  const setOpen = useBrowserPanel((state) => state.setOpen);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [page, setPage] = useState<{ url: string; title: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pictureRef = useRef<HTMLImageElement>(null);
  // Typing goes through a field of its own rather than key events on the
  // picture: a phone's keyboard, an input method and pasting all arrive as
  // text in a field, and only keys that write nothing come as key events.
  const typingRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const lastWheel = useRef(0);

  // After mount, not as the store's initial value: the server renders this too.
  useEffect(() => {
    let wanted = false;
    try {
      wanted = window.localStorage.getItem(OPEN_KEY) === "1";
    } catch {
      wanted = false;
    }
    void refreshStatus().then(() => {
      if (wanted && useBrowserPanel.getState().status?.available) useBrowserPanel.setState({ open: true });
    });
  }, []);

  // While the panel is open its status is kept fresh: the agent may open or
  // close the browser at any moment.
  useEffect(() => {
    if (!open) return;
    void refreshStatus();
    const timer = setInterval(() => void refreshStatus(), 10_000);
    return () => clearInterval(timer);
  }, [open]);

  const browserOpen = Boolean(status?.available && status.open);
  useEffect(() => {
    if (!open || !browserOpen) {
      setFrame(null);
      return;
    }
    const source = new EventSource("/api/browser/stream");
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as
        | { type: "frame"; data: string; width: number; height: number }
        | { type: "page"; url: string; title: string }
        | { type: "closed"; reason: string };
      if (event.type === "frame") setFrame({ data: event.data, width: event.width, height: event.height });
      else if (event.type === "page") setPage({ url: event.url, title: event.title });
      else {
        source.close();
        setFrame(null);
        void refreshStatus();
      }
    };
    return () => source.close();
  }, [open, browserOpen]);

  const control = status?.control ?? "agent";
  const inControl = control === "person";

  const act = useCallback(async (work: () => Promise<Response>, after?: (response: Response) => Promise<void> | void) => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await work();
      if (!response.ok) {
        const json = (await response.json().catch(() => ({}))) as { error?: string };
        setNotice(t("browser.panel.error", { reason: json.error || String(response.status) }));
      } else if (after) {
        await after(response);
      }
    } catch (error) {
      setNotice(t("browser.panel.error", { reason: error instanceof Error ? error.message : "" }));
    } finally {
      setBusy(false);
      void refreshStatus();
    }
  }, [t]);

  const pointFrom = (event: { clientX: number; clientY: number }) => {
    const picture = pictureRef.current;
    if (!picture || !frame) return null;
    const rect = picture.getBoundingClientRect();
    return {
      x: Math.round(((event.clientX - rect.left) / rect.width) * frame.width),
      y: Math.round(((event.clientY - rect.top) / rect.height) * frame.height),
    };
  };

  const onPictureClick = (event: MouseEvent<HTMLImageElement>) => {
    if (!inControl) return;
    const point = pointFrom(event);
    if (point) void post("/api/browser/input", { type: "click", ...point });
    typingRef.current?.focus({ preventScroll: true });
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!inControl) return;
    const now = Date.now();
    if (now - lastWheel.current < 80) return;
    lastWheel.current = now;
    const point = pointFrom(event);
    if (point) void post("/api/browser/input", { type: "wheel", ...point, deltaY: Math.max(-1200, Math.min(1200, event.deltaY * 2)) });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!inControl || composing.current) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (SPECIAL_KEYS.has(event.key)) {
      event.preventDefault();
      void post("/api/browser/input", { type: "key", key: event.key });
    }
  };

  const onInput = (event: FormEvent<HTMLTextAreaElement>) => {
    const field = event.currentTarget;
    if (!inControl || composing.current) return;
    const text = field.value;
    field.value = "";
    if (text) void post("/api/browser/input", { type: "text", text: text.slice(0, 2000) });
  };

  const onCompositionEnd = (event: { currentTarget: HTMLTextAreaElement }) => {
    composing.current = false;
    const field = event.currentTarget;
    const text = field.value;
    field.value = "";
    if (inControl && text) void post("/api/browser/input", { type: "text", text: text.slice(0, 2000) });
  };

  if (!status?.available) return null;

  return (
    <>
      {open ? (
        <button
          type="button"
          aria-label={t("browser.panel.close")}
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
        />
      ) : null}
      <aside
        data-state={open ? "open" : "closed"}
        aria-label={t("browser.panel.title")}
        inert={!open}
        className={[
          "sticky top-[var(--header-height,3.5rem)] h-[calc(100svh-var(--header-height,3.5rem))] shrink-0 overflow-hidden border-l bg-background",
          "transition-[width,transform] duration-200 ease-out motion-reduce:transition-none",
          "max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-50 max-md:h-auto max-md:w-[min(100vw,40rem)]",
          "max-md:data-[state=closed]:translate-x-full max-md:data-[state=open]:translate-x-0",
          "md:data-[state=closed]:w-0 md:data-[state=open]:w-[min(44rem,46vw)]",
        ].join(" ")}
      >
        <div className="flex h-full w-[min(100vw,40rem)] flex-col md:w-[min(44rem,46vw)]">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
              <Globe className="size-4 shrink-0" />
              <span>{t("browser.panel.title")}</span>
              {page?.title || page?.url ? (
                <span className="truncate font-normal text-muted-foreground" title={page.url}>· {page.title || page.url}</span>
              ) : null}
            </span>
            <span className="flex shrink-0 items-center gap-0.5">
              {browserOpen ? (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-foreground"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(t("browser.panel.forgetConfirm"))) return;
                      void act(() => fetch("/api/browser/profile", { method: "DELETE", headers: { "content-type": "application/json" } }), () => setNotice(t("browser.panel.forgotten")));
                    }}
                    aria-label={t("browser.panel.forget")}
                    title={t("browser.panel.forget")}
                  >
                    <LogOut className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-foreground"
                    disabled={busy}
                    onClick={() => void act(() => post("/api/browser/session", { action: "close" }))}
                    aria-label={t("browser.panel.closeBrowser")}
                    title={t("browser.panel.closeBrowser")}
                  >
                    <Power className="size-4" />
                  </Button>
                </>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-foreground"
                onClick={() => setOpen(false)}
                aria-label={t("browser.panel.close")}
                title={t("browser.panel.close")}
              >
                <X className="size-4" />
              </Button>
            </span>
          </div>

          {browserOpen ? (
            <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs">
              <span role="status" className="min-w-0 text-muted-foreground">
                {inControl ? t("browser.panel.youHaveControl") : t("browser.panel.agentHasControl")}
              </span>
              <Button
                variant={inControl ? "default" : "outline"}
                size="xs"
                className="shrink-0 gap-1"
                disabled={busy}
                onClick={() => void act(() => post("/api/browser/control", { take: !inControl }))}
              >
                <Hand className="size-3.5" />
                {inControl ? t("browser.panel.return") : t("browser.panel.take")}
              </Button>
            </div>
          ) : null}

          <div className="relative min-h-0 flex-1 overflow-auto bg-muted/20">
            {browserOpen ? (
              frame ? (
                <div
                  onWheel={onWheel}
                  data-control={inControl ? "person" : "agent"}
                  className="relative data-[control=person]:ring-2 data-[control=person]:ring-primary data-[control=person]:ring-inset"
                >
                  {inControl ? (
                    <textarea
                      ref={typingRef}
                      aria-label={t("browser.panel.typing")}
                      autoCapitalize="off"
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                      onKeyDown={onKeyDown}
                      onInput={onInput}
                      onCompositionStart={() => { composing.current = true; }}
                      onCompositionEnd={onCompositionEnd}
                      className="absolute left-0 top-0 h-px w-px resize-none overflow-hidden border-0 p-0 opacity-0"
                    />
                  ) : null}
                  {/* eslint-disable-next-line @next/next/no-img-element -- frames are data URLs, refreshed many times a second */}
                  <img
                    ref={pictureRef}
                    src={`data:image/jpeg;base64,${frame.data}`}
                    alt={t("browser.panel.picture")}
                    draggable={false}
                    onClick={onPictureClick}
                    className={["block h-auto w-full select-none", inControl ? "cursor-pointer" : "cursor-default"].join(" ")}
                  />
                </div>
              ) : (
                <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  <span role="status">{t("browser.panel.connecting")}</span>
                </div>
              )
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
                <Globe className="size-6" aria-hidden />
                <span>{t("browser.panel.notOpen")}</span>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void act(() => post("/api/browser/session", { action: "open" }))}>
                  {busy ? <Loader2 className="mr-1 size-3.5 animate-spin" aria-hidden /> : null}
                  {busy ? t("browser.panel.opening") : t("browser.panel.open")}
                </Button>
              </div>
            )}
          </div>

          {notice || status?.minutes ? (
            <div className="flex items-center justify-between gap-2 border-t px-3 py-1.5 text-xs text-muted-foreground">
              <span role="status" className="min-w-0">{notice}</span>
              {status?.minutes ? (
                <span className="shrink-0 tabular-nums">{t("browser.panel.minutes", { left: status.minutes.left, monthly: status.minutes.monthly })}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      </aside>
    </>
  );
}

/** The button that opens it, beside the terminal's; absent where there is no browser. */
export function BrowserPanelTrigger() {
  const { t } = useI18n();
  const open = useBrowserPanel((state) => state.open);
  const available = useBrowserPanel((state) => Boolean(state.status?.available));
  const toggle = useBrowserPanel((state) => state.toggle);
  useEffect(() => {
    if (!useBrowserPanel.getState().loaded) void refreshStatus();
  }, []);
  if (!available) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8"
      onClick={toggle}
      aria-label={t("browser.panel.toggle")}
      aria-pressed={open}
      title={t("browser.panel.toggle")}
    >
      <Globe className="size-4" />
    </Button>
  );
}
