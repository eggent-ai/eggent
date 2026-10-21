"use client";

/**
 * The first time a project is set onto a program of this computer, the person is
 * told what that means before it happens: the program works in the folder with
 * its own tools, it spends their own subscription and not their Eggent balance,
 * what they write goes to the company behind it, and a few things Eggent does
 * are not available in this mode. The sheet then asks the program for one word
 * to find out that it answers, so a project is never moved onto something that
 * would only fail on the first real message.
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useI18n } from "@/i18n/provider";
import { probeEngineRun, saveEngineChoice } from "@/lib/engines/client";
import type { EngineAccess, EngineInfo } from "@/lib/engines/types";

interface EngineConsentSheetProps {
  engine: EngineInfo | null;
  /** Null for the orchestrator, whose chats are those outside any project. */
  projectId: string | null;
  /** The model the person was already pointing at, when they came from a list of models. */
  initialModel?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once the choice is saved. */
  onConfirmed: () => void;
}

export function EngineConsentSheet({ engine, projectId, initialModel = "", open, onOpenChange, onConfirmed }: EngineConsentSheetProps) {
  const { t } = useI18n();
  const [model, setModel] = useState("");
  const [access, setAccess] = useState<EngineAccess>("project");
  const [phase, setPhase] = useState<"idle" | "checking" | "saving">("idle");
  const [error, setError] = useState<string | null>(null);

  // A sheet that is opened again starts from the defaults, not from the last attempt.
  useEffect(() => {
    if (open) {
      setModel(initialModel);
      setAccess("project");
      setPhase("idle");
      setError(null);
    }
  }, [open, engine?.id, initialModel]);

  if (!engine) return null;
  const name = engine.label;
  const busy = phase !== "idle";

  async function confirm() {
    if (!engine || busy) return;
    setError(null);
    setPhase("checking");
    const probe = await probeEngineRun(engine.id, model);
    if (!probe.ok) {
      setPhase("idle");
      setError(t("engines.consent.checkFailed", { engine: name, detail: probe.error?.message || "" }));
      return;
    }
    setPhase("saving");
    const saved = await saveEngineChoice(projectId, { engine: engine.id, model, access, confirm: true });
    if (!saved.ok) {
      setPhase("idle");
      setError(t("engines.consent.saveFailed"));
      return;
    }
    setPhase("idle");
    onOpenChange(false);
    onConfirmed();
  }

  return (
    <Sheet open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <SheetContent className="sm:max-w-md" side="right">
        <SheetHeader>
          <SheetTitle>{t(projectId ? "engines.consent.title" : "engines.consent.titleHere", { engine: name })}</SheetTitle>
          <SheetDescription>{t("engines.consent.folder", { engine: name })}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-4 text-sm">
          <ul className="list-disc space-y-2 pl-5 text-muted-foreground">
            <li>{t("engines.consent.cost")}</li>
            <li>{t("engines.consent.data", { engine: name })}</li>
            <li>{t("engines.consent.missing")}</li>
          </ul>

          {engine.models.length > 1 ? (
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">{t("engines.model.label")}</Label>
              <Select value={model || "__default"} onValueChange={(value) => setModel(value === "__default" ? "" : value)} disabled={busy}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {engine.models.map((option) => (
                    <SelectItem key={option.id || "__default"} value={option.id || "__default"}>
                      {option.id ? option.label : t("engines.model.default")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <fieldset className="space-y-2" disabled={busy}>
            <legend className="mb-1 text-xs text-muted-foreground">{t("engines.access.label")}</legend>
            {(["project", "full"] as const).map((level) => (
              <label
                key={level}
                className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 has-[:checked]:border-foreground/40 has-[:checked]:bg-accent/40"
              >
                <input
                  type="radio"
                  name="engine-access"
                  value={level}
                  checked={access === level}
                  onChange={() => setAccess(level)}
                  className="mt-1"
                />
                <span className="space-y-0.5">
                  <span className="block font-medium">{t(level === "project" ? "engines.access.project" : "engines.access.full")}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t(level === "project" ? "engines.access.projectNote" : "engines.access.fullNote", { engine: name })}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("engines.consent.cancel")}
          </Button>
          <Button onClick={() => void confirm()} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            {phase === "checking" ? t("engines.consent.checking") : t("engines.consent.confirm")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
