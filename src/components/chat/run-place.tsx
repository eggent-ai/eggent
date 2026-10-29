"use client";

import { Check, Cloud, Laptop } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import { choiceFor, nothingToChoose, placeChoices, type PlaceChoice } from "@/lib/remote/client";
import type { ChatHome, RemoteStatus } from "@/lib/remote/types";

export interface RunPlaceProps {
  status: RemoteStatus | null;
  /** The chat's stored home, or what a chat that does not exist yet will be started with. Null is "wherever it is typed". */
  home: ChatHome | null;
  /** A turn is running: where it runs cannot change until it is over. */
  busy: boolean;
  onSelect: (home: ChatHome) => void;
  /** The menu was opened; the list of computers is looked at again. */
  onOpen?: () => void;
}

const REASON_KEYS: Record<"offline" | "not-ready" | "cloud-unreachable", MessageKey> = {
  offline: "chat.runPlace.unavailableReason",
  "not-ready": "chat.runPlace.notReadyReason",
  "cloud-unreachable": "chat.runPlace.cloudUnreachable",
};

function PlaceIcon({ choice }: { choice: PlaceChoice | null }) {
  return choice?.label === "cloud" ? (
    <Cloud className="size-3 shrink-0" aria-hidden />
  ) : (
    <Laptop className="size-3 shrink-0" aria-hidden />
  );
}

/**
 * Where this chat runs, in the line under the composer that already reports the
 * model and the context.
 *
 * A chat runs on the side it was started on, wherever it is typed into later,
 * until the person says otherwise here. The control is absent altogether on an
 * install that has nothing to switch between, and it is a static label - with
 * the reason - while a turn is running, because a turn does not move.
 */
export function RunPlaceControl({ status, home, busy, onSelect, onOpen }: RunPlaceProps) {
  const { t } = useI18n();
  if (!status?.enabled || !status.node) return null;
  if (nothingToChoose(status, home)) return null;

  const choices = placeChoices(status);
  const current = choiceFor(status, home);

  const nameOf = (choice: PlaceChoice | null): string => {
    if (!choice) return t("chat.runPlace.yourComputer");
    if (choice.label === "cloud") return t("chat.runPlace.cloud");
    if (choice.label === "thisComputer") return t("chat.runPlace.thisComputer");
    return choice.name || t("chat.runPlace.yourComputer");
  };

  const label = nameOf(current);

  if (busy) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex min-w-0 max-w-full cursor-default items-center gap-1" data-testid="run-place">
            <PlaceIcon choice={current} />
            <span className="min-w-0 truncate" title={label}>{label}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-72 text-xs leading-relaxed">
          {t("chat.runPlace.busy")}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <DropdownMenu onOpenChange={(open) => open && onOpen?.()}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("chat.runPlace.trigger")}
              data-testid="run-place"
              className="flex min-w-0 max-w-full items-center gap-1 rounded-sm underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <PlaceIcon choice={current} />
              <span className="min-w-0 truncate" title={label}>{label}</span>
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-80 text-xs leading-relaxed">
          {t("chat.runPlace.hint")}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" side="top" className="max-w-[min(20rem,calc(100vw-2rem))]">
        {choices.map((choice) => (
          <DropdownMenuItem
            key={choice.node}
            disabled={!choice.available}
            onSelect={() => onSelect(choice.node)}
            className="flex-col items-start gap-0.5 py-2"
            data-testid={`run-place-${choice.node}`}
          >
            <span className="flex min-w-0 w-full items-center gap-2 font-medium">
              <PlaceIcon choice={choice} />
              <span className="min-w-0 [overflow-wrap:anywhere]">{nameOf(choice)}</span>
              {choice.node === current?.node && <Check className="size-3.5 shrink-0" aria-hidden />}
            </span>
            {!choice.available ? (
              <span className="text-xs leading-snug text-muted-foreground">
                {t("chat.runPlace.unavailable")}. {t(REASON_KEYS[choice.reason])}
              </span>
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
