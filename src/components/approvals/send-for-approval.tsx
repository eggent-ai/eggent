"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Plus, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n/provider";
import { APPROVAL_MAX_CHAIN, APPROVAL_MAX_NOTE_CHARS, type Approval, type ApprovalPeopleAnswer } from "@/lib/approvals/types";
import { approvalsApi } from "./api";
import { refreshApprovalsSummary } from "./use-approvals-summary";

type Person = ApprovalPeopleAnswer["people"][number];

/**
 * Choosing who approves a file, in order, and sending the version it holds now.
 * The order is the chain: the first person decides first, the next is asked
 * only once they approve.
 */
export function SendForApproval({
  projectId,
  path,
  initialChain = [],
  submitLabel,
  onSent,
  onCancel,
}: {
  projectId: string;
  path: string;
  initialChain?: string[];
  submitLabel?: string;
  onSent: (approval: Approval) => void;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [chain, setChain] = useState<string[]>(initialChain);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    approvalsApi
      .people()
      .then((answer) => {
        if (cancelled) return;
        setPeople(answer.people);
        // Somebody who has left the company since cannot be asked again.
        setChain((current) => current.filter((id) => answer.people.some((person) => person.id === id)));
      })
      .catch((failure) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : t("approvals.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const byId = useMemo(() => new Map((people ?? []).map((person) => [person.id, person])), [people]);
  const others = (people ?? []).filter((person) => !chain.includes(person.id));

  const move = (index: number, by: -1 | 1) => {
    setChain((current) => {
      const next = [...current];
      const target = index + by;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const send = async () => {
    if (!chain.length || sending) return;
    setSending(true);
    setError(null);
    try {
      const approval = await approvalsApi.send({ project: projectId, path, approvers: chain, note: note.trim() });
      void refreshApprovalsSummary();
      onSent(approval);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("approvals.sendFailed"));
    } finally {
      setSending(false);
    }
  };

  if (people === null && !error) return <p className="text-sm text-muted-foreground">{t("approvals.loading")}</p>;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t("approvals.form.chainTitle")}</h3>
        {chain.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("approvals.form.chainEmpty")}</p>
        ) : (
          <ol className="space-y-1.5">
            {chain.map((id, index) => (
              <li key={id} className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5">
                <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{byId.get(id)?.name ?? id}</span>
                <Button type="button" variant="ghost" size="icon" className="size-7" onClick={() => move(index, -1)} disabled={index === 0} aria-label={t("approvals.form.up", { name: byId.get(id)?.name ?? id })}>
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button type="button" variant="ghost" size="icon" className="size-7" onClick={() => move(index, 1)} disabled={index === chain.length - 1} aria-label={t("approvals.form.down", { name: byId.get(id)?.name ?? id })}>
                  <ArrowDown className="size-3.5" />
                </Button>
                <Button type="button" variant="ghost" size="icon" className="size-7" onClick={() => setChain((current) => current.filter((entry) => entry !== id))} aria-label={t("approvals.form.remove", { name: byId.get(id)?.name ?? id })}>
                  <X className="size-3.5" />
                </Button>
              </li>
            ))}
          </ol>
        )}
        {others.length > 0 && chain.length < APPROVAL_MAX_CHAIN ? (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {others.map((person) => (
              <Button key={person.id} type="button" variant="outline" size="sm" className="h-8 gap-1" title={person.about || undefined} onClick={() => setChain((current) => [...current, person.id])}>
                <Plus className="size-3.5" />
                {person.name}
              </Button>
            ))}
          </div>
        ) : null}
        {people !== null && people.length === 0 ? <p className="text-sm text-muted-foreground">{t("approvals.form.nobody")}</p> : null}
      </div>
      <div className="space-y-1.5">
        <label htmlFor={`approval-note-${path}`} className="text-sm font-medium">{t("approvals.form.noteLabel")}</label>
        <Textarea
          id={`approval-note-${path}`}
          value={note}
          onChange={(event) => setNote(event.target.value.slice(0, APPROVAL_MAX_NOTE_CHARS))}
          placeholder={t("approvals.form.notePlaceholder")}
          rows={2}
          className="min-h-16 text-base md:text-sm"
        />
      </div>
      <p className="text-xs text-muted-foreground">{t("approvals.form.howItWorks")}</p>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => void send()} disabled={!chain.length || sending} className="gap-2">
          {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          {submitLabel ?? t("approvals.form.send")}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={sending}>
            {t("common.cancel")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
