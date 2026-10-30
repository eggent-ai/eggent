"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, MessagesSquare } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GuestChat, type GuestChatEndpoints } from "@/components/chat/guest-chat";
import { GuestConversationsBar } from "@/components/chat/guest-conversations";

/**
 * A project's public link, as its visitor sees it: who they are first (a name
 * and an email; a code from the letter when the address has been here before
 * from another browser), then the workspace's own chat with their own
 * conversations. Who may see which conversation is decided by the server
 * (lib/public-chat/visitors.ts); this screen only asks and shows.
 */

interface LinkInfo {
  share: { title: string; welcome: string | null };
  visitor: { name: string; email: string; confirmed: boolean } | null;
  conversations: Array<{ id: string; title: string; updatedAt: string }>;
  mail: boolean;
}

/** A visitor's screen follows their own system's light or dark, not the workspace owner's setting. */
function useSystemTheme() {
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = ((await response.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  return { ok: response.ok, data };
}

function WhoAreYou({ base, title, welcome, onReady }: { base: string; title: string; welcome: string | null; onReady: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (sentTo) codeRef.current?.focus();
  }, [sentTo]);

  const start = async (event?: FormEvent) => {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await postJson(`${base}/visitor`, { name, email });
      if (!ok) throw new Error(typeof data.error === "string" ? data.error : t("publicChat.failed"));
      if (data.needsCode) {
        setSentTo(typeof data.email === "string" ? data.email : email);
        setCode("");
      } else {
        onReady();
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("publicChat.failed"));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await postJson(`${base}/verify`, { email, code });
      if (!ok) throw new Error(typeof data.error === "string" ? data.error : t("publicChat.failed"));
      onReady();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("publicChat.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <MessagesSquare className="size-6" aria-hidden />
        </div>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">{title}</h1>
        {welcome ? <p className="mt-2 text-sm leading-6 whitespace-pre-line text-muted-foreground">{welcome}</p> : null}
        {sentTo ? (
          <form onSubmit={verify} className="mt-6 space-y-4">
            <p className="text-sm leading-6">{t("publicChat.codeSent", { email: sentTo })}</p>
            <div className="space-y-2">
              <Label htmlFor="public-code">{t("publicChat.code")}</Label>
              <Input
                id="public-code"
                ref={codeRef}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={9}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className="h-11 text-lg tracking-[0.3em]"
                required
              />
            </div>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" className="h-11 w-full" disabled={busy || code.replace(/\D/g, "").length < 6}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t("publicChat.verify")}
            </Button>
            <div className="flex flex-wrap justify-between gap-2 text-sm">
              <button type="button" className="text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50" disabled={busy} onClick={() => void start()}>
                {t("publicChat.resend")}
              </button>
              <button type="button" className="text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => { setSentTo(null); setError(null); }}>
                {t("publicChat.otherEmail")}
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={start} className="mt-6 space-y-4">
            <p className="text-sm leading-6 text-muted-foreground">{t("publicChat.intro")}</p>
            <div className="space-y-2">
              <Label htmlFor="public-name">{t("publicChat.name")}</Label>
              <Input id="public-name" autoComplete="name" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} className="h-11" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="public-email">{t("publicChat.email")}</Label>
              <Input id="public-email" type="email" autoComplete="email" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} className="h-11" required />
            </div>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" className="h-11 w-full" disabled={busy || !name.trim() || !email.trim()}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t("publicChat.start")}
            </Button>
            <p className="text-xs leading-5 text-muted-foreground">{t("publicChat.privacy")}</p>
          </form>
        )}
      </div>
    </div>
  );
}

export function PublicChat({ token }: { token: string }) {
  const { t } = useI18n();
  useSystemTheme();
  const router = useRouter();
  const search = useSearchParams();
  const base = `/s/${encodeURIComponent(token)}/api`;
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [state, setState] = useState<"loading" | "closed" | "ready">("loading");
  const [busy, setBusy] = useState(false);
  const fromAddress = search.get("c");
  // As on the company page: a key that changes only when the visitor opens
  // another conversation, so the first answer naming a new one keeps the screen.
  const [opened, setOpened] = useState<{ key: string; conversation: string | null } | null>(null);
  const named = useRef<string | null>(fromAddress);

  const load = useCallback(async () => {
    const response = await fetch(base, { cache: "no-store" }).catch(() => null);
    if (!response?.ok) {
      setState("closed");
      return null;
    }
    const data = (await response.json()) as LinkInfo;
    setInfo(data);
    setState("ready");
    return data;
  }, [base]);

  useEffect(() => {
    void load().then((data) => {
      if (!data) return;
      // Back to where the visitor was: the conversation in the address, else their latest one.
      const own = new Set(data.conversations.map((item) => item.id));
      const start = fromAddress && own.has(fromAddress) ? fromAddress : data.conversations[0]?.id ?? null;
      named.current = start;
      setOpened({ key: start ?? "new", conversation: start });
    });
    // Once, when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const path = `/s/${encodeURIComponent(token)}`;
  const openConversation = (id: string | null) => {
    if (busy) return;
    named.current = id;
    router.replace(id ? `${path}?c=${id}` : path);
    setOpened({ key: id ?? `new-${Date.now()}`, conversation: id });
  };

  const endpoints = useMemo<GuestChatEndpoints>(() => ({
    send: `${base}/message`,
    history: (conversation) => `${base}/chats/${encodeURIComponent(conversation)}`,
    resume: (conversation) => `${base}/chats/${encodeURIComponent(conversation)}/stream`,
    stop: `${base}/stop`,
    answer: `${base}/answer`,
    transcribe: `${base}/transcribe`,
  }), [base]);

  const forget = async () => {
    await postJson(`${base}/forget`, {});
    router.replace(path);
    setOpened(null);
    await load();
  };

  if (state === "loading") {
    return <div className="flex h-svh items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("publicChat.loading")} /></div>;
  }
  if (state === "closed" || !info) {
    return (
      <div className="flex h-svh items-center justify-center px-4">
        <p className="max-w-sm text-center text-sm text-muted-foreground">{t("publicChat.closed")}</p>
      </div>
    );
  }
  if (!info.visitor) {
    return (
      <div className="h-svh overflow-y-auto">
        <WhoAreYou
          base={base}
          title={info.share.title}
          welcome={info.share.welcome}
          onReady={() => void load().then((data) => {
            const latest = data?.conversations[0]?.id ?? null;
            named.current = latest;
            setOpened({ key: latest ?? `new-${Date.now()}`, conversation: latest });
          })}
        />
      </div>
    );
  }

  const header = (
    <GuestConversationsBar
      icon={<MessagesSquare />}
      title={info.share.title}
      notice={
        <span>
          {t("publicChat.writingAs", { name: info.visitor.name })}{" "}
          <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => void forget()}>
            {t("publicChat.notYou")}
          </button>
        </span>
      }
      conversations={info.conversations}
      current={opened?.conversation ?? null}
      busy={busy}
      onOpen={openConversation}
    />
  );

  return (
    <div className="mx-auto flex h-svh w-full max-w-5xl flex-col">
      {opened ? (
        <GuestChat
          key={opened.key}
          endpoints={endpoints}
          conversation={opened.conversation}
          onConversation={(id) => {
            named.current = id;
            setOpened((current) => (current ? { ...current, conversation: id } : current));
            router.replace(`${path}?c=${id}`);
          }}
          onBusyChange={setBusy}
          onSettled={() => void load()}
          empty={{ title: info.share.title, description: info.share.welcome || t("publicChat.empty") }}
          note={t("publicChat.note")}
          header={header}
        />
      ) : null}
    </div>
  );
}
