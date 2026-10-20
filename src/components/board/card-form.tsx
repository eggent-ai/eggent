"use client";

import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cardPlaceChoices, placeName } from "@/components/board/card-place";
import { useI18n } from "@/i18n/provider";
import { wouldCycle } from "@/lib/board/logic";
import { MAX_BODY_CHARS, MAX_TITLE_CHARS, type BoardCard } from "@/lib/board/types";
import { CLOUD_HOME, type ChatHome, type RemoteStatus } from "@/lib/remote/types";
import type { Project } from "@/lib/types";

const ORCHESTRATOR = "none";

export interface CardFormValues {
  title: string;
  body: string;
  projectId: string | null;
  after: string[];
  review: boolean;
  /** Where it runs, in a pair; null leaves it to the default, which is the cloud. */
  home: ChatHome | null;
}

/**
 * Writing a card, and changing one. The same fields both times; what differs is
 * what the buttons do - a new card is started or kept in the inbox, an edited
 * one is saved - and whether its project can still change: once a card has
 * run, its conversation is in that project.
 *
 * Where it runs is asked only where there is a choice: a workspace with a
 * computer paired to it, or that computer. A place that is away can still be
 * chosen - the card waits for it - and the sentence under the choice says so.
 */
export function CardForm({
  initial,
  cards,
  editingId,
  projects,
  projectLocked,
  remote,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  initial: CardFormValues;
  /** The other cards, to choose which this one waits for. */
  cards: BoardCard[];
  editingId?: string;
  projects: Project[];
  projectLocked?: boolean;
  /** Whether there is a pair, and its computers; null while it loads or where there is none. */
  remote?: RemoteStatus | null;
  busy: boolean;
  error?: string | null;
  onSubmit: (values: CardFormValues, start: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [values, setValues] = useState<CardFormValues>(initial);
  const editing = Boolean(editingId);
  const ownId = editingId ?? "new-card";

  // Cards it could wait for: not itself, not put away, and not one that already waits for it.
  const candidates = useMemo(
    () =>
      cards
        .filter((card) => card.id !== editingId && !card.archived)
        .filter((card) => values.after.includes(card.id) || !wouldCycle(cards, ownId, [...values.after, card.id]))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 40),
    [cards, editingId, ownId, values.after]
  );

  const places = cardPlaceChoices(remote ?? null, values.home);
  const place = values.home ?? CLOUD_HOME;
  const chosen = places.find((choice) => choice.node === place) ?? null;

  const empty = !values.title.trim() && !values.body.trim();
  const toggleAfter = (cardId: string) =>
    setValues((current) => ({
      ...current,
      after: current.after.includes(cardId) ? current.after.filter((other) => other !== cardId) : [...current.after, cardId],
    }));

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!empty) onSubmit(values, !editing);
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-title`}>{t("board.form.title")}</Label>
        <Input
          id={`${id}-title`}
          value={values.title}
          maxLength={MAX_TITLE_CHARS}
          placeholder={t("board.form.titlePlaceholder")}
          autoFocus
          onChange={(event) => setValues((current) => ({ ...current, title: event.target.value }))}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-body`}>{t("board.form.body")}</Label>
        <Textarea
          id={`${id}-body`}
          value={values.body}
          rows={7}
          maxLength={MAX_BODY_CHARS}
          placeholder={t("board.form.bodyPlaceholder")}
          className="min-h-36 resize-y"
          onChange={(event) => setValues((current) => ({ ...current, body: event.target.value }))}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-project`}>{t("board.form.project")}</Label>
        <Select
          value={values.projectId ?? ORCHESTRATOR}
          disabled={projectLocked}
          onValueChange={(value) => setValues((current) => ({ ...current, projectId: value === ORCHESTRATOR ? null : value }))}
        >
          <SelectTrigger id={`${id}-project`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ORCHESTRATOR}>{t("nav.orchestrator")}</SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {places.length >= 2 ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-place`}>{t("board.form.place")}</Label>
          <Select value={place} onValueChange={(value) => setValues((current) => ({ ...current, home: value as ChatHome }))}>
            <SelectTrigger id={`${id}-place`} className="w-full" data-testid="card-place">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {places.map((choice) => (
                <SelectItem key={choice.node} value={choice.node}>
                  {placeName(choice, t)}
                  {choice.available ? null : <span className="text-muted-foreground"> · {t("board.form.placeAway")}</span>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {place === CLOUD_HOME
              ? t("board.form.placeCloud")
              : chosen?.label === "thisComputer"
                ? chosen.available
                  ? t("board.form.placeHere")
                  : t("board.form.placeHereOff")
                : t("board.form.placeDevice", { name: chosen ? placeName(chosen, t) : t("chat.runPlace.yourComputer") })}
          </p>
        </div>
      ) : null}

      {candidates.length > 0 ? (
        <fieldset className="grid gap-1.5">
          <legend className="text-sm font-medium">{t("board.form.after")}</legend>
          <p className="text-xs text-muted-foreground">{values.after.length === 0 ? t("board.form.afterNone") : t("board.form.afterHint")}</p>
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
            {candidates.map((card) => (
              <label key={card.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={values.after.includes(card.id)}
                  onChange={() => toggleAfter(card.id)}
                />
                <span className="truncate">{card.title}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-primary"
          checked={values.review}
          onChange={(event) => setValues((current) => ({ ...current, review: event.target.checked }))}
        />
        <span>{t("board.form.review")}</span>
      </label>

      {error ? (
        <p role="alert" className="rounded-md border border-destructive px-3 py-2 text-sm text-foreground">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          {t("board.form.cancel")}
        </Button>
        {editing ? (
          <Button type="submit" disabled={busy || empty}>
            {busy ? t("board.form.saving") : t("board.form.saveChanges")}
          </Button>
        ) : (
          <>
            <Button type="button" variant="outline" disabled={busy || empty} onClick={() => onSubmit(values, false)}>
              {t("board.form.save")}
            </Button>
            <Button type="submit" disabled={busy || empty}>
              {busy ? t("board.form.saving") : t("board.form.start")}
            </Button>
          </>
        )}
      </div>
    </form>
  );
}
