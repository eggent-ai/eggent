"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Archive, OctagonAlert, Play, Plus, SquareKanban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SkeletonList } from "@/components/ui/skeleton-list";
import { CardForm, type CardFormValues } from "@/components/board/card-form";
import { CardSheet } from "@/components/board/card-sheet";
import { CardTile } from "@/components/board/card-tile";
import { useBackgroundSync } from "@/hooks/use-background-sync";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import * as board from "@/lib/board/client";
import { compareInColumn, scopeOf } from "@/lib/board/logic";
import type { BoardCard, BoardSnapshot, CardStatus } from "@/lib/board/types";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app-store";

const COLUMNS: Array<{ status: CardStatus; label: MessageKey; hint: MessageKey }> = [
  { status: "inbox", label: "board.column.inbox", hint: "board.column.inboxHint" },
  { status: "queued", label: "board.column.queued", hint: "board.column.queuedHint" },
  { status: "running", label: "board.column.running", hint: "board.column.runningHint" },
  { status: "waiting", label: "board.column.waiting", hint: "board.column.waitingHint" },
  { status: "done", label: "board.column.done", hint: "board.column.doneHint" },
];

const ALL = "all";
/** How many finished cards the Done column shows before "show more". */
const DONE_SHOWN = 10;
const ORCHESTRATOR = "none";

/** Which columns a card may be dropped into from where it is. Only the person moves cards, and never into "working". */
function canDrop(card: BoardCard, to: CardStatus): boolean {
  if (card.status === "running") return false;
  if (to === "inbox" || to === "queued") return true;
  if (to === "done") return card.status === "waiting" && card.waiting?.reason === "review";
  return false;
}

/** The position that puts a card between two neighbours of its new column. */
function positionBetween(before: BoardCard | undefined, after: BoardCard | undefined): number {
  if (before && after) return (before.position + after.position) / 2;
  if (before) return before.position + 1;
  if (after) return after.position - 1;
  return 1;
}

/**
 * The task board: five columns of cards the agent carries out one by one.
 *
 * The page reads one snapshot and keeps it fresh from the board's own events;
 * every change goes through the board's routes and the snapshot after it is the
 * truth, so two tabs - or the agent writing cards meanwhile - never disagree
 * for longer than an event takes. Dragging is a shortcut for the moves the
 * opened card offers as buttons, which is where the keyboard does them.
 */
export function BoardView() {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const projects = useAppStore((state) => state.projects);

  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showAllDone, setShowAllDone] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Null until the person picks one: a phone opens on the column that has something in it.
  const [mobileChoice, setMobileChoice] = useState<CardStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ status: CardStatus; index: number } | null>(null);
  const listRefs = useRef(new Map<CardStatus, HTMLUListElement | null>());
  const tabStrip = useRef<HTMLDivElement>(null);

  const filter = searchParams.get("project") || ALL;
  const openId = searchParams.get("card");

  const setParam = useCallback(
    (name: string, value: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === null) params.delete(name);
      else params.set(name, value);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  const tick = useBackgroundSync({ topics: ["board", "global"], fallbackIntervalMs: 15_000 });
  const load = useCallback(async () => {
    try {
      setSnapshot(await board.fetchBoard({ archived: showArchived }));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [showArchived]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  // The phone's column strip scrolls sideways; the column shown must not be the one past its edge.
  useEffect(() => {
    const strip = tabStrip.current;
    const tab = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!strip || !tab) return;
    const left = tab.offsetLeft - strip.offsetLeft;
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    else if (left + tab.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = left + tab.offsetWidth - strip.clientWidth;
  });

  const anyRunning = Boolean(snapshot && (Object.keys(snapshot.live).length > 0 || snapshot.cards.some((card) => card.status === "running")));
  useEffect(() => {
    if (!anyRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => window.clearInterval(timer);
  }, [anyRunning]);

  const cards = useMemo(() => snapshot?.cards ?? [], [snapshot]);
  const byId = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards]);
  const visible = useMemo(
    () => (filter === ALL ? cards : cards.filter((card) => scopeOf(card) === filter)),
    [cards, filter]
  );
  const columns = useMemo(() => {
    const result = new Map<CardStatus, BoardCard[]>(COLUMNS.map((column) => [column.status, []]));
    for (const card of visible) {
      if (card.archived) continue;
      // A card a turn is working in shows as working whatever it says, for the moment until it does.
      const status: CardStatus = snapshot?.live[card.id] ? "running" : card.status;
      result.get(status)?.push(card);
    }
    for (const list of result.values()) list.sort(compareInColumn);
    return result;
  }, [visible, snapshot]);
  const archived = useMemo(() => visible.filter((card) => card.archived), [visible]);
  const mobileColumn: CardStatus =
    mobileChoice ??
    (["waiting", "running", "inbox", "queued", "done"] as const).find((status) => (columns.get(status)?.length ?? 0) > 0) ??
    "inbox";

  const projectName = useCallback(
    (card: BoardCard) => (card.projectId ? projects.find((project) => project.id === card.projectId)?.name ?? card.projectId : t("nav.orchestrator")),
    [projects, t]
  );

  const act = useCallback(
    async (work: () => Promise<unknown>) => {
      setActionError(null);
      try {
        await work();
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        void load();
      }
    },
    [load]
  );

  const moveTo = (card: BoardCard, status: CardStatus, index: number) => {
    const list = (columns.get(status) ?? []).filter((other) => other.id !== card.id);
    const position = positionBetween(list[index - 1], list[index]);
    // Shown where it was dropped at once; the snapshot after the move is the truth.
    setSnapshot((current) =>
      current
        ? {
            ...current,
            cards: current.cards.map((other) => (other.id === card.id ? { ...other, status, position } : other)),
          }
        : current
    );
    const to = status === "done" ? "done" : status === "queued" ? "queued" : "inbox";
    void act(() => board.moveCard(card.id, to, status === "done" ? undefined : position));
  };

  // Up puts it before the card above; down, after the card below.
  const moveWithin = (card: BoardCard, direction: -1 | 1) => {
    const list = columns.get(card.status) ?? [];
    const index = list.findIndex((other) => other.id === card.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= list.length) return;
    moveTo(card, card.status, target);
  };

  const dropIndex = (status: CardStatus, clientY: number): number => {
    const list = listRefs.current.get(status);
    if (!list) return 0;
    const items = [...list.querySelectorAll<HTMLElement>("[data-card-id]")].filter((item) => item.dataset.cardId !== dragId);
    const index = items.findIndex((item) => {
      const rect = item.getBoundingClientRect();
      return clientY < rect.top + rect.height / 2;
    });
    return index < 0 ? items.length : index;
  };

  const dragged = dragId ? byId.get(dragId) ?? null : null;
  const openCard = openId ? byId.get(openId) ?? null : null;
  const filterValue = filter === ALL || filter === ORCHESTRATOR || projects.some((project) => project.id === filter) ? filter : ALL;
  const empty = snapshot !== null && visible.length === 0;

  const createCard = async (values: CardFormValues, start: boolean) => {
    setCreateBusy(true);
    setCreateError(null);
    try {
      await board.createCard({ ...values, start });
      setCreating(false);
      void load();
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreateBusy(false);
    }
  };

  const column = (spec: (typeof COLUMNS)[number]) => {
    const all = columns.get(spec.status) ?? [];
    // Done only grows: the most recent are shown, the rest one click away.
    const capped = spec.status === "done" && !showAllDone && all.length > DONE_SHOWN;
    const list = capped ? all.slice(0, DONE_SHOWN) : all;
    const accepting = dragged ? canDrop(dragged, spec.status) && !(spec.status === dragged.status && spec.status === "done") : false;
    const target = dropTarget?.status === spec.status ? dropTarget.index : null;
    return (
      <section
        key={spec.status}
        aria-labelledby={`board-column-${spec.status}`}
        className={cn(
          "flex min-h-40 min-w-0 flex-col rounded-xl border bg-muted/30 transition-colors duration-150",
          accepting && "border-dashed border-ring",
          accepting && target !== null && "bg-muted/60"
        )}
        onDragOver={(event) => {
          if (!accepting) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          const index = dropIndex(spec.status, event.clientY);
          if (dropTarget?.status !== spec.status || dropTarget.index !== index) setDropTarget({ status: spec.status, index });
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (dragged && accepting) moveTo(dragged, spec.status, dropIndex(spec.status, event.clientY));
          setDragId(null);
          setDropTarget(null);
        }}
      >
        <header className="flex items-center gap-2 px-3 pt-3 pb-2">
          <h3 id={`board-column-${spec.status}`} className="text-sm font-semibold" title={t(spec.hint)}>
            {t(spec.label)}
          </h3>
          <span className="text-xs/4 tabular-nums text-muted-foreground">{all.length}</span>
          {spec.status === "inbox" && list.length > 1 ? (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-7 px-2 text-xs"
              onClick={() => act(() => board.startInbox(filter === ALL ? undefined : filter))}
            >
              <Play aria-hidden />
              {t("board.startAll")}
            </Button>
          ) : null}
        </header>
        <p className="px-3 pb-2 text-xs/4 text-muted-foreground">{t(spec.hint)}</p>
        <ul ref={(node) => { listRefs.current.set(spec.status, node); }} className="flex flex-1 flex-col gap-2 px-2 pb-2">
          {list.map((card) => {
            // Where the drop would land is counted among the other cards, as the drop itself counts it.
            const markerHere = card.id !== dragId && target === ordinalOf(list, card.id, dragId);
            return (
            <FragmentWithMarker key={card.id} show={markerHere}>
              <CardTile
                card={card}
                byId={byId}
                live={snapshot?.live[card.id]}
                projectName={filter === ALL ? projectName(card) : null}
                now={now}
                draggable={card.status !== "running" && !snapshot?.live[card.id]}
                dragging={dragId === card.id}
                onOpen={() => setParam("card", card.id)}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", card.id);
                  setDragId(card.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDropTarget(null);
                }}
              />
            </FragmentWithMarker>
            );
          })}
          {target !== null && target >= list.filter((card) => card.id !== dragId).length ? <DropMarker /> : null}
          {capped ? (
            <li>
              <Button size="sm" variant="ghost" className="h-8 w-full text-xs" onClick={() => setShowAllDone(true)}>
                {t("board.showMoreDone", { count: all.length - DONE_SHOWN })}
              </Button>
            </li>
          ) : null}
          {list.length === 0 ? (
            <li className="flex items-center justify-center rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
              {accepting ? t("board.column.dropHere") : t("board.column.empty")}
            </li>
          ) : null}
        </ul>
      </section>
    );
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-start gap-3">
        {/* A basis wide enough that the controls wrap below the text on a phone, instead of squeezing it to a word a line. */}
        <div className="min-w-0 flex-[1_1_18rem] space-y-1">
          <h2 className="text-2xl font-semibold">{t("board.heading")}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">{t("board.description")}</p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Select value={filterValue} onValueChange={(value) => setParam("project", value === ALL ? null : value)}>
            <SelectTrigger className="min-w-0 flex-1 sm:w-48 sm:flex-none" aria-label={t("board.filter.label")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("board.filter.all")}</SelectItem>
              <SelectSeparator />
              <SelectItem value={ORCHESTRATOR}>{t("nav.orchestrator")}</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            onClick={() => {
              setCreateError(null);
              setCreating(true);
            }}
          >
            <Plus aria-hidden />
            {t("board.new")}
          </Button>
        </div>
      </div>

      {snapshot?.state.paused ? (
        <div role="status" className="flex flex-wrap items-start gap-3 rounded-lg border border-destructive p-3">
          <OctagonAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium">{t("board.paused.title")}</p>
            <p className="text-sm text-muted-foreground">{t("board.paused.body")}</p>
            {snapshot.state.paused.detail ? <p className="text-sm">{snapshot.state.paused.detail}</p> : null}
          </div>
          <Button size="sm" onClick={() => act(() => board.resumeBoard())}>
            {t("board.paused.resume")}
          </Button>
        </div>
      ) : null}

      {actionError ? (
        <p role="alert" className="rounded-md border border-destructive px-3 py-2 text-sm">
          {t("board.errors.action", { error: actionError })}
        </p>
      ) : null}

      {!snapshot ? (
        loadError ? (
          <p role="alert" className="rounded-md border border-destructive px-3 py-2 text-sm">
            {t("board.errors.load")} {loadError}
          </p>
        ) : (
          <SkeletonList rows={4} />
        )
      ) : empty && !showArchived ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SquareKanban aria-hidden />
            </EmptyMedia>
            <EmptyTitle>{t("board.empty.title")}</EmptyTitle>
            <EmptyDescription>{t("board.empty.body")}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t("board.new")}
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          {/* A phone shows one column at a time; the tabs say how many are in each. */}
          <div ref={tabStrip} role="tablist" aria-label={t("board.heading")} className="flex gap-1 overflow-x-auto md:hidden">
            {COLUMNS.map((spec) => {
              const count = columns.get(spec.status)?.length ?? 0;
              const selected = mobileColumn === spec.status;
              return (
                <button
                  key={spec.status}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setMobileChoice(spec.status)}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    selected ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  {t(spec.label)}
                  <span className="tabular-nums opacity-80">{count}</span>
                </button>
              );
            })}
          </div>
          <div className="md:hidden">{column(COLUMNS.find((spec) => spec.status === mobileColumn) ?? COLUMNS[0])}</div>

          <div className="hidden min-w-0 gap-3 overflow-x-auto pb-2 md:grid md:auto-cols-[minmax(11.5rem,1fr)] md:grid-flow-col">
            {COLUMNS.map((spec) => column(spec))}
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            {snapshot ? <span>{t("board.limits", { running: snapshot.limits.running, perProject: snapshot.limits.perProject })}</span> : null}
            <Button size="sm" variant="ghost" className="ml-auto h-7 px-2 text-xs" onClick={() => setShowArchived((value) => !value)}>
              <Archive aria-hidden />
              {showArchived ? t("board.hideArchived") : t("board.showArchived")}
            </Button>
          </div>

          {showArchived && archived.length > 0 ? (
            <section aria-labelledby="board-archived" className="space-y-2">
              <h3 id="board-archived" className="text-sm font-semibold">
                {t("board.column.archived")}
              </h3>
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {archived.map((card) => (
                  <CardTile
                    key={card.id}
                    card={card}
                    byId={byId}
                    projectName={filter === ALL ? projectName(card) : null}
                    now={now}
                    draggable={false}
                    dragging={false}
                    onOpen={() => setParam("card", card.id)}
                    onDragStart={() => undefined}
                    onDragEnd={() => undefined}
                  />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}

      <CardSheet
        card={openCard}
        cards={cards}
        live={openCard ? snapshot?.live[openCard.id] : undefined}
        projects={projects}
        now={now}
        onClose={() => setParam("card", null)}
        onChanged={() => void load()}
        onMoveWithin={moveWithin}
      />

      <Sheet open={creating} onOpenChange={setCreating}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader className="px-4 pt-4 pb-0">
            <SheetTitle>{t("board.form.newTitle")}</SheetTitle>
          </SheetHeader>
          <div className="p-4">
            {creating ? (
              <CardForm
                initial={{ title: "", body: "", projectId: filter === ALL || filter === ORCHESTRATOR ? null : filter, after: [], review: false }}
                cards={cards}
                projects={projects}
                busy={createBusy}
                error={createError}
                onCancel={() => setCreating(false)}
                onSubmit={(values, start) => void createCard(values, start)}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** A card's place in its column, not counting the card being dragged. */
function ordinalOf(list: BoardCard[], id: string, dragId: string | null): number {
  let ordinal = 0;
  for (const card of list) {
    if (card.id === id) return ordinal;
    if (card.id !== dragId) ordinal += 1;
  }
  return ordinal;
}

function DropMarker() {
  return <li aria-hidden className="h-0.5 rounded-full bg-ring" />;
}

function FragmentWithMarker({ show, children }: { show: boolean; children: React.ReactNode }) {
  return (
    <>
      {show ? <DropMarker /> : null}
      {children}
    </>
  );
}
