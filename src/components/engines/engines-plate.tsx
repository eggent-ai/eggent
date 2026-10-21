"use client";

/**
 * "On this computer" on the Models tab: the programs found here that can do a
 * project's work on the person's own subscription.
 *
 * It is one more place a model can come from, so it sits beside the other ones
 * and says as little as it can. Nothing is drawn where no program is on the
 * computer, which is also every deployment that has none to offer. A program
 * that is installed but signed out gets one button, and the screen re-checks
 * when the person comes back from the browser. Using one for the first time goes
 * through the confirmation sheet; after that it is a switch.
 */
import { useState } from "react";
import { Check, Loader2, Terminal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EngineConsentSheet } from "@/components/engines/engine-consent-sheet";
import { useEngines } from "@/hooks/use-engines";
import { useI18n } from "@/i18n/provider";
import {
  busiestWindow,
  cancelEngineSignIn,
  saveEngineChoice,
  startEngineSignIn,
  visibleEngines,
  type EnginesResponse,
} from "@/lib/engines/client";
import type { EngineAccess, EngineChoice, EngineInfo } from "@/lib/engines/types";

export function EnginesPlate({ projectId }: { projectId: string | null }) {
  const { t } = useI18n();
  const { state, refresh } = useEngines(projectId);
  const [asking, setAsking] = useState<EngineInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState<Record<string, boolean>>({});

  const engines = visibleEngines(state);
  if (!state || engines.length === 0) return null;

  async function use(info: EngineInfo) {
    setError(null);
    // The first time for this project asks; after that it is only a switch.
    if (!state?.consents[info.id]) {
      setAsking(info);
      return;
    }
    setBusy(info.id);
    const saved = await saveEngineChoice(projectId, { engine: info.id });
    setBusy(null);
    if (!saved.ok) setError(t("engines.plate.saveFailed"));
    await refresh();
  }

  async function stopUsing() {
    setError(null);
    setBusy("off");
    const saved = await saveEngineChoice(projectId, { engine: null });
    setBusy(null);
    if (!saved.ok) setError(t("engines.plate.saveFailed"));
    await refresh();
  }

  async function adjust(info: EngineInfo, changes: Partial<Pick<EngineChoice, "model" | "access">>) {
    setError(null);
    setBusy(info.id);
    const saved = await saveEngineChoice(projectId, { engine: info.id, ...changes });
    setBusy(null);
    if (!saved.ok) setError(t("engines.plate.saveFailed"));
    await refresh();
  }

  async function signIn(info: EngineInfo) {
    setError(null);
    setTried((current) => ({ ...current, [info.id]: true }));
    const started = await startEngineSignIn(info.id);
    if (!started) setError(t("engines.row.signInFailed"));
    await refresh(true);
  }

  async function cancelSignIn(info: EngineInfo) {
    await cancelEngineSignIn(info.id);
    await refresh(true);
  }

  return (
    <section className="space-y-3 rounded-xl border bg-card p-5" aria-labelledby="engines-plate-title">
      <div className="space-y-1">
        <h3 id="engines-plate-title" className="flex items-center gap-2 text-sm font-medium">
          <Terminal className="size-4 text-muted-foreground" aria-hidden="true" />
          {t("engines.plate.title")}
        </h3>
        <p className="max-w-prose text-xs text-muted-foreground">{t(projectId ? "engines.plate.hint" : "engines.plate.hintHere")}</p>
      </div>

      <div className="divide-y">
        {engines.map((info) => (
          <EngineRow
            key={info.id}
            info={info}
            state={state}
            projectId={projectId}
            busy={busy === info.id || busy === "off"}
            tried={tried[info.id] === true}
            onUse={() => void use(info)}
            onStop={() => void stopUsing()}
            onSignIn={() => void signIn(info)}
            onCancelSignIn={() => void cancelSignIn(info)}
            onCheck={() => void refresh(true)}
            onAdjust={(changes) => void adjust(info, changes)}
          />
        ))}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <EngineConsentSheet
        engine={asking}
        projectId={projectId}
        open={asking !== null}
        onOpenChange={(next) => {
          if (!next) setAsking(null);
        }}
        onConfirmed={() => void refresh(true)}
      />
    </section>
  );
}

interface EngineRowProps {
  info: EngineInfo;
  state: EnginesResponse;
  projectId: string | null;
  busy: boolean;
  tried: boolean;
  onUse: () => void;
  onStop: () => void;
  onSignIn: () => void;
  onCancelSignIn: () => void;
  onCheck: () => void;
  onAdjust: (changes: Partial<Pick<EngineChoice, "model" | "access">>) => void;
}

function EngineRow({ info, state, projectId, busy, tried, onUse, onStop, onSignIn, onCancelSignIn, onCheck, onAdjust }: EngineRowProps) {
  const { t } = useI18n();
  const inUse = state.choice?.engine === info.id;
  const choice = inUse ? state.choice : null;
  const status = info.status;
  const window = busiestWindow(info);

  let line: string;
  if (status.state === "ready") {
    const who = status.account ? t("engines.row.account", { plan: status.account }) : t("engines.row.accountUnknown");
    line = window ? `${who} · ${t("engines.limits.window", { label: window.label, percent: window.percent })}` : who;
  } else if (status.state === "signed-out") {
    line = info.loggingIn ? t("engines.row.signingIn") : tried ? `${t("engines.row.signInFailed")}` : t("engines.row.signedOut");
  } else {
    const key = status.code === "api-key"
      ? "engines.row.problem.apiKey"
      : status.code === "old-version"
        ? "engines.row.problem.oldVersion"
        : status.code === "limit"
          ? "engines.row.problem.limit"
          : "engines.row.problem.error";
    line = t(key, { detail: status.detail ?? "" });
  }

  return (
    <div className="space-y-3 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{info.label}</span>
            {status.version ? <span className="text-xs text-muted-foreground">{status.version}</span> : null}
            {inUse ? (
              <Badge variant="secondary" className="gap-1">
                <Check aria-hidden="true" />
                {t("engines.row.inUse")}
              </Badge>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {line}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {status.state === "ready" && !inUse ? (
            <Button size="sm" onClick={onUse} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              {t(projectId ? "engines.row.use" : "engines.row.useHere")}
            </Button>
          ) : null}
          {inUse ? (
            <Button size="sm" variant="outline" onClick={onStop} disabled={busy}>
              {t("engines.row.stopUsing")}
            </Button>
          ) : null}
          {status.state === "signed-out" ? (
            info.loggingIn ? (
              <>
                <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
                <Button size="sm" variant="ghost" onClick={onCancelSignIn}>
                  {t("engines.consent.cancel")}
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={onSignIn}>
                {t("engines.row.signIn")}
              </Button>
            )
          ) : null}
          {status.state === "problem" ? (
            <Button size="sm" variant="outline" onClick={onCheck}>
              {t("engines.row.check")}
            </Button>
          ) : null}
        </div>
      </div>

      {inUse && choice ? (
        <div className="space-y-3 rounded-lg bg-muted/40 p-3">
          <p className="text-xs text-muted-foreground">
            {t(projectId ? "engines.plate.using" : "engines.plate.usingHere", { engine: info.label })}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {info.models.length > 1 ? (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("engines.model.label")}</Label>
                <Select
                  value={choice.model || "__default"}
                  onValueChange={(value) => onAdjust({ model: value === "__default" ? "" : value })}
                  disabled={busy}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {info.models.map((option) => (
                      <SelectItem key={option.id || "__default"} value={option.id || "__default"}>
                        {option.id ? option.label : t("engines.model.default")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("engines.access.label")}</Label>
              <Select value={choice.access} onValueChange={(value) => onAdjust({ access: value as EngineAccess })} disabled={busy}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="project">{t("engines.access.project")}</SelectItem>
                  <SelectItem value="full">{t("engines.access.full")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
