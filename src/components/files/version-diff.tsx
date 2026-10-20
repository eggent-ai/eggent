"use client";

/**
 * Two versions of a file, side by side in time: what was taken out and what was
 * put in, with the unchanged parts folded away.
 *
 * Two ways to read it. As text, a change is the newer wording with the older
 * words struck through in place - how an edited document reads to someone who
 * did not make the edit. As lines, it is the older lines over the newer ones,
 * numbered, the way a change to code is read. Colour marks only the edge and the
 * background of a change; the words themselves keep the text colour, because a
 * green word on a green wash is the one thing nobody can read.
 */

import { useState, type ReactNode } from "react";
import { ChevronsDownUp } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import type { DiffBlock, DiffModel, DiffRow, DiffSegment } from "@/lib/files/versions/diff-model";
import { cn } from "@/lib/utils";

export type DiffMode = "text" | "lines";

const DEL_MARK = "bg-destructive/20 line-through decoration-destructive/70 decoration-1 rounded-[2px]";
const ADD_MARK = "bg-success/25 rounded-[2px]";

function segmentsOf(segments: DiffSegment[] | undefined, text: string, kind: "add" | "del"): ReactNode {
  if (!segments) return text || " ";
  return segments.map((segment, index) =>
    segment.kind === "same" ? (
      <span key={index}>{segment.text}</span>
    ) : (
      <span key={index} className={kind === "del" ? DEL_MARK : ADD_MARK}>{segment.text}</span>
    )
  );
}

function LineRow({ row }: { row: DiffRow }) {
  const marker = row.kind === "add" ? "+" : row.kind === "del" ? "−" : "";
  return (
    <div
      className={cn(
        "grid grid-cols-[2.75rem_2.75rem_1rem_minmax(0,1fr)] border-l-2",
        row.kind === "add" && "border-success bg-success/10",
        row.kind === "del" && "border-destructive bg-destructive/10",
        row.kind === "same" && "border-transparent"
      )}
    >
      <span className="select-none pr-2 text-right text-muted-foreground/70 tabular-nums">{row.oldNo ?? ""}</span>
      <span className="select-none pr-2 text-right text-muted-foreground/70 tabular-nums">{row.newNo ?? ""}</span>
      <span className="select-none text-muted-foreground" aria-hidden>{marker}</span>
      <span className="whitespace-pre-wrap break-words pr-3">
        {row.kind === "same" ? row.text || " " : segmentsOf(row.segments, row.text, row.kind)}
      </span>
    </div>
  );
}

function Fold({ rows, mode, onOpen }: { rows: DiffRow[]; mode: DiffMode; onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full items-center gap-2 border-y border-dashed bg-muted/40 px-3 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        mode === "lines" ? "font-sans" : ""
      )}
    >
      <ChevronsDownUp className="size-3.5 shrink-0" aria-hidden />
      {t("files.history.unchangedLines", { count: rows.length })}
    </button>
  );
}

function TextChange({ block }: { block: Extract<DiffBlock, { type: "change" }> }) {
  // The same change as running text: the newer wording, the older words struck through in it.
  if (block.inline) {
    const onlyAdded = block.removed.length === 0;
    const onlyRemoved = block.added.length === 0;
    return (
      <div
        className={cn(
          "whitespace-pre-wrap break-words border-l-2 px-3 py-1",
          onlyRemoved ? "border-destructive bg-destructive/10" : onlyAdded ? "border-success bg-success/10" : "border-warning bg-warning/10"
        )}
      >
        {block.inline.map((segment, index) =>
          segment.kind === "same" ? (
            <span key={index}>{segment.text}</span>
          ) : (
            <span key={index} className={segment.kind === "del" ? DEL_MARK : ADD_MARK}>{segment.text}</span>
          )
        )}
      </div>
    );
  }
  return (
    <div>
      {block.removed.map((row, index) => (
        <div key={`d${index}`} className="whitespace-pre-wrap break-words border-l-2 border-destructive bg-destructive/10 px-3 py-0.5">
          <span className={DEL_MARK}>{row.text || " "}</span>
        </div>
      ))}
      {block.added.map((row, index) => (
        <div key={`a${index}`} className="whitespace-pre-wrap break-words border-l-2 border-success bg-success/10 px-3 py-0.5">
          {row.text || " "}
        </div>
      ))}
    </div>
  );
}

export function VersionDiff({ model, mode, activeChange }: { model: DiffModel; mode: DiffMode; activeChange: number }) {
  const [opened, setOpened] = useState<Set<number>>(() => new Set());
  const open = (index: number) => setOpened((current) => new Set(current).add(index));

  return (
    <div className={cn(mode === "lines" ? "font-mono text-xs leading-5" : "text-sm leading-6")}>
      {model.blocks.map((block, index) => {
        if (block.type === "same") {
          if (block.collapsed && !opened.has(index)) return <Fold key={index} rows={block.rows} mode={mode} onOpen={() => open(index)} />;
          return mode === "lines" ? (
            <div key={index}>{block.rows.map((row) => <LineRow key={`${row.oldNo}-${row.newNo}`} row={row} />)}</div>
          ) : (
            <div key={index} className="whitespace-pre-wrap break-words border-l-2 border-transparent px-3 text-muted-foreground">
              {block.rows.map((row) => row.text).join("\n") || " "}
            </div>
          );
        }
        return (
          <div
            key={index}
            data-change={block.index}
            // The change the arrows last moved to keeps a ring, so it can be found again after scrolling.
            className={cn("scroll-mt-12 transition-shadow", block.index === activeChange && "ring-2 ring-inset ring-ring")}
          >
            {mode === "lines" ? (
              <>
                {block.removed.map((row) => <LineRow key={`d${row.oldNo}`} row={row} />)}
                {block.added.map((row) => <LineRow key={`a${row.newNo}`} row={row} />)}
              </>
            ) : (
              <TextChange block={block} />
            )}
          </div>
        );
      })}
    </div>
  );
}
