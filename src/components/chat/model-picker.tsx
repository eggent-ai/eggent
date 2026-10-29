"use client";

/**
 * Which model answers, changed from the composer.
 *
 * The setting already existed on the Models tab; what it lacked was a place to
 * change it at the moment anyone actually thinks about it - mid-conversation,
 * when the last answer was too slow, too shallow, or too expensive. So this is
 * not a second setting: it writes the same project model.json, or the same
 * workspace default when the chat is the orchestrator's, and the Models tab
 * shows whatever was chosen here.
 *
 * The line under the composer reports what *will* answer, not what last did.
 * Those differ for exactly one turn after a change, and reporting the old one
 * there would make the control look like it had not worked.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ExternalLink, Loader2, Lock, Search, Sparkles } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EngineConsentSheet } from "@/components/engines/engine-consent-sheet";
import { useBackgroundSync } from "@/hooks/use-background-sync";
import { useEngines } from "@/hooks/use-engines";
import { useI18n } from "@/i18n/provider";
import { engineChoiceLabel, saveEngineChoice, visibleEngines } from "@/lib/engines/client";
import type { EngineInfo } from "@/lib/engines/types";
import { parseProjectModelFile, serializeProjectModelFile } from "@/lib/pi/project-model-choice";

interface PickerModel {
  provider: string;
  id: string;
  name?: string;
}

interface PickerState {
  providers?: Array<{ id: string; name?: string }>;
  availableModels?: PickerModel[];
  managed?: { providerId?: string | null; label?: string };
  modelLock?: { locked?: boolean; label?: string };
  managedModels?: Array<{
    id: string;
    name: string;
    family?: string;
    kind?: string;
    available?: boolean;
    note?: string;
    manage?: { url: string; label: string };
  }>;
  settings?: { defaultProvider?: string; defaultModel?: string; defaultThinkingLevel?: string };
}

export interface ModelPickerProps {
  /** Null for the orchestrator, where the choice is the workspace default. */
  projectId?: string | null;
  /** Set by the composer, which gives the trigger its own size and spacing. */
  triggerClassName?: string;
  /** In the composer, where the row is shared with the text field. */
  compact?: boolean;
}

interface ModelOption {
  provider: string;
  id: string;
  label: string;
  group: string;
  /** Listed so it can be seen, but this workspace cannot use it right now. */
  locked?: boolean;
  /** A program of this computer and one of its models, not a model of this workspace. */
  engine?: { id: string; modelId: string };
  /** Why a locked row is locked, when it is not the deployment's own sentence. */
  note?: string;
}

/** The provider id the rows of programs carry here; it never reaches a file. */
const ENGINE_OPTION_PROVIDER = "engine";

export function ModelPicker({ projectId, triggerClassName, compact }: ModelPickerProps) {
  const { t } = useI18n();
  const [state, setState] = useState<PickerState | null>(null);
  const [chosen, setChosen] = useState<{ provider: string; model: string } | null>(null);
  const [projectFile, setProjectFile] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const { state: engines, refresh: refreshEngines } = useEngines(projectId ?? null);
  // A program put down or taken up elsewhere (the chat's own "carry on with a model" button, the
  // Models tab, another window) is announced as a change to the project: the label follows it.
  const syncTick = useBackgroundSync({ topics: ["projects"], fallbackIntervalMs: 0 });
  useEffect(() => {
    if (syncTick > 0 && engines?.available !== false) void refreshEngines();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new event should look again
  }, [syncTick, refreshEngines]);
  // A program asked for before the person has confirmed it for this project: the sheet comes first.
  const [asking, setAsking] = useState<{ info: EngineInfo; model: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const modelsRes = await fetch("/api/pi/models");
      if (!modelsRes.ok) return;
      const models = (await modelsRes.json()) as PickerState;
      setState(models);

      // A project's own choice wins over the workspace default, exactly as the
      // runtime resolves it; reading only the workspace default would show the
      // wrong model in every project that has one.
      if (projectId) {
        const fileRes = await fetch(`/api/projects/${encodeURIComponent(projectId)}/model`);
        if (fileRes.ok) {
          const file = (await fileRes.json()) as { content?: string };
          const content = typeof file.content === "string" ? file.content : "";
          setProjectFile(content);
          const parsed = parseProjectModelFile(content);
          if (parsed.choice.mode === "project" && parsed.choice.provider && parsed.choice.model) {
            setChosen({ provider: parsed.choice.provider, model: parsed.choice.model });
            return;
          }
        }
      }
      const provider = models.settings?.defaultProvider || "";
      const model = models.settings?.defaultModel || "";
      setChosen(provider && model ? { provider, model } : null);
    } catch {
      // Leave whatever was on screen; this line is not worth an error state.
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const managedId = state?.managed?.providerId || "eggent-ai";
  const options = useMemo<ModelOption[]>(() => {
    const families = new Map((state?.managedModels ?? []).map((model) => [model.id, model]));
    const providerNames = new Map((state?.providers ?? []).map((provider) => [provider.id, provider.name || provider.id]));
    const managedGroup = (family?: string) => family || state?.modelLock?.label || state?.managed?.label || "Eggent AI";
    const usable: ModelOption[] = (state?.availableModels ?? []).map((model) => {
      const managed = model.provider === managedId || model.provider === "eggent-ai";
      const catalog = families.get(model.id);
      return {
        provider: model.provider,
        id: model.id,
        label: catalog?.name || model.name || model.id,
        // Under the plan the models come from several vendors and the provider
        // id says nothing, so the family is the useful heading. On your own
        // providers the provider is the heading, because that is the thing you
        // connected.
        group: managed ? managedGroup(catalog?.family) : providerNames.get(model.provider) || model.provider,
      };
    });
    // The included models this workspace cannot use right now are still shown,
    // after the ones it can, so the list says what else exists and the line at
    // the bottom says what opens it. Only where the included provider answers
    // at all: otherwise there is nothing here they would belong to.
    const managedOffered = usable.some((option) => option.provider === managedId || option.provider === "eggent-ai");
    const locked: ModelOption[] = managedOffered
      ? (state?.managedModels ?? [])
          .filter((model) => model.available === false && (!model.kind || model.kind === "text"))
          .map((model) => ({ provider: managedId, id: model.id, label: model.name || model.id, group: managedGroup(model.family), locked: true }))
      : [];
    // Programs of this computer: one row per model of each that is ready, and
    // one locked row for each that is installed but cannot answer yet. Programs
    // that are not on the computer are not mentioned.
    const group = t("engines.picker.group");
    const programs: ModelOption[] = visibleEngines(engines).flatMap((info) =>
      info.status.state === "ready"
        ? info.models.map((model) => ({
            provider: ENGINE_OPTION_PROVIDER,
            id: `${info.id}/${model.id}`,
            label: engineChoiceLabel(info, { model: model.id }),
            group,
            engine: { id: info.id, modelId: model.id },
          }))
        : [{
            provider: ENGINE_OPTION_PROVIDER,
            id: `${info.id}/`,
            label: info.label,
            group,
            locked: true,
            note: t("engines.picker.signInNote"),
            engine: { id: info.id, modelId: "" },
          }]
    );
    return [...usable, ...locked, ...programs];
  }, [state, managedId, engines, t]);

  /** The program this project is set to, if any, with the model it was told to use. */
  const engineInUse = useMemo(() => {
    const choice = engines?.choice;
    if (!choice) return null;
    const info = visibleEngines(engines).find((candidate) => candidate.id === choice.engine);
    return info ? { info, choice } : null;
  }, [engines]);

  /** The deployment's own sentence about the unavailable ones, and where to go. */
  const lockedHint = useMemo(() => {
    const first = (state?.managedModels ?? []).find((model) => model.available === false && model.note);
    return first && options.some((option) => option.locked && !option.engine) ? { note: first.note as string, manage: first.manage } : null;
  }, [state, options]);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = needle
      ? options.filter((option) =>
          option.label.toLowerCase().includes(needle)
          || option.id.toLowerCase().includes(needle)
          || option.group.toLowerCase().includes(needle))
      : options;
    // Grouped by heading in the order headings first appear, so a family whose
    // models are unavailable follows the ones that answer rather than breaking
    // them up.
    const ordered: Array<{ group: string; models: ModelOption[] }> = [];
    const byGroup = new Map<string, { group: string; models: ModelOption[] }>();
    for (const option of matching) {
      const existing = byGroup.get(option.group);
      if (existing) existing.models.push(option);
      else {
        const created = { group: option.group, models: [option] };
        byGroup.set(option.group, created);
        ordered.push(created);
      }
    }
    return ordered;
  }, [options, query]);

  const currentLabel = useMemo(() => {
    if (engineInUse) return engineChoiceLabel(engineInUse.info, engineInUse.choice);
    if (!chosen) return null;
    const find = (provider: string, model: string) => options.find((option) => option.id === model && (option.provider === provider
      || provider === "eggent-ai" || option.provider === "eggent-ai"));
    const match = find(chosen.provider, chosen.model);
    // A saved choice this workspace cannot use is not what answers: the run
    // falls through to the workspace model, so that is what the line names.
    if (match?.locked) {
      const fallback = find(state?.settings?.defaultProvider || "", state?.settings?.defaultModel || "");
      if (fallback && !fallback.locked) return fallback.label;
    }
    return match?.label || chosen.model;
  }, [chosen, engineInUse, options, state]);

  const thinking = state?.settings?.defaultThinkingLevel;

  async function chooseProgram(option: ModelOption) {
    const target = option.engine && visibleEngines(engines).find((info) => info.id === option.engine!.id);
    if (!option.engine || !target) return;
    // The first time for this project the person is told what it means; after that it is a switch.
    if (!engines?.consents[target.id]) {
      setOpen(false);
      setQuery("");
      setAsking({ info: target, model: option.engine.modelId });
      return;
    }
    setSaving(option.id);
    setError(null);
    const saved = await saveEngineChoice(projectId ?? null, { engine: target.id, model: option.engine.modelId });
    setSaving(null);
    if (!saved.ok) {
      setError(t("chat.modelPicker.saveFailed"));
      return;
    }
    setOpen(false);
    setQuery("");
    await refreshEngines();
  }

  async function choose(option: ModelOption) {
    if (saving || option.locked) return;
    if (option.engine) {
      await chooseProgram(option);
      return;
    }
    setSaving(option.id);
    setError(null);
    const previous = chosen;
    setChosen({ provider: option.provider, model: option.id });
    try {
      // A model picked while a program is doing the work puts the program down first.
      if (engineInUse) {
        const released = await saveEngineChoice(projectId ?? null, { engine: null });
        if (!released.ok) throw new Error(t("chat.modelPicker.saveFailed"));
        await refreshEngines();
      }
      if (projectId) {
        // Carry the file's other keys across: this form owns three of them.
        const parsed = parseProjectModelFile(projectFile ?? "");
        const content = serializeProjectModelFile(
          { mode: "project", provider: option.provider, model: option.id },
          parsed.extra
        );
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/model`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
        const json = (await res.json()) as { content?: string; error?: string };
        if (!res.ok) throw new Error(json.error || t("chat.modelPicker.saveFailed"));
        setProjectFile(typeof json.content === "string" ? json.content : content);
      } else {
        const res = await fetch("/api/pi/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: option.provider, model: option.id }),
        });
        const json = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(json.error || t("chat.modelPicker.saveFailed"));
      }
      setOpen(false);
      setQuery("");
      await load();
    } catch (saveError) {
      // Put the label back to what is actually in force. A control that keeps
      // showing a refused choice is how somebody ends up believing they moved.
      setChosen(previous);
      setError(saveError instanceof Error ? saveError.message : t("chat.modelPicker.saveFailed"));
    } finally {
      setSaving(null);
    }
  }

  if (!options.some((option) => !option.locked)) {
    // Nothing to choose between - a workspace with one model, or none loaded.
    return (
      <span className={triggerClassName ?? "font-mono"}>
        <span className="block min-w-0 truncate" title={currentLabel || t("chat.modelPicker.none")}>
          {currentLabel || t("chat.modelPicker.none")}
        </span>
      </span>
    );
  }

  return (
    <>
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) { setQuery(""); setError(null); return; }
        // Re-read on open rather than polling: the agent can switch the project
        // mid-conversation, and this line would otherwise name the old model
        // until the page was reloaded.
        void load();
        window.setTimeout(() => searchRef.current?.focus(), 0);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={
            triggerClassName
            ?? "inline-flex items-center gap-1 rounded font-mono transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          }
          aria-label={t("chat.modelPicker.trigger")}
        >
          {/* Inside the composer the name shares the row with the text field.
              On a phone that field was down to 78px, so below `sm` the name
              gives way to the icon and only the chevron stays - the control is
              still there, and there is somewhere to type. */}
          {compact ? <Sparkles className="size-3.5 shrink-0 sm:hidden" /> : null}
          <span className={compact ? "hidden truncate sm:inline" : "truncate"}>
            {currentLabel || t("chat.modelPicker.none")}
          </span>
          {thinking ? (
            <span className={`shrink-0 text-muted-foreground${compact ? " hidden sm:inline" : ""}`}>· {thinking}</span>
          ) : null}
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-80 p-0" sideOffset={6}>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("chat.modelPicker.search")}
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          {groups.length === 0 ? (
            <p className="px-3 py-4 text-center text-sm text-muted-foreground">{t("chat.modelPicker.noMatch")}</p>
          ) : (
            groups.map((group) => (
              <div key={group.group}>
                <div className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  {group.group}
                </div>
                {group.models.map((option) => {
                  if (option.locked) {
                    // Focusable and announced, so a screen reader meets it too,
                    // and pointing at the line below that says why.
                    return (
                      <button
                        key={`${option.provider}/${option.id}`}
                        type="button"
                        aria-disabled="true"
                        aria-describedby={option.engine ? undefined : lockedHint ? "model-picker-locked-hint" : undefined}
                        className="flex w-full cursor-default items-center gap-2 px-3 py-1.5 text-left text-sm text-muted-foreground"
                      >
                        <span className="flex-1 truncate">{option.label}</span>
                        {option.note ? <span className="shrink-0 text-xs">{option.note}</span> : null}
                        <Lock className="size-3 shrink-0" aria-hidden="true" />
                      </button>
                    );
                  }
                  const active = option.engine
                    ? engineInUse?.info.id === option.engine.id && (engineInUse.choice.model || "") === option.engine.modelId
                    : !engineInUse && chosen?.model === option.id;
                  return (
                    <button
                      key={`${option.provider}/${option.id}`}
                      type="button"
                      onClick={() => void choose(option)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                    >
                      <span className="flex-1 truncate">{option.label}</span>
                      {saving === option.id ? (
                        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                      ) : active ? (
                        <Check className="size-3.5 shrink-0" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        {lockedHint ? (
          <p id="model-picker-locked-hint" className="flex items-start gap-1.5 border-t px-3 py-2 text-xs text-muted-foreground">
            <Lock className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            <span>
              {lockedHint.note}
              {lockedHint.manage ? (
                <>
                  {" "}
                  <a
                    href={lockedHint.manage.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-2 hover:underline"
                  >
                    {lockedHint.manage.label}
                    <ExternalLink className="size-3" aria-hidden="true" />
                  </a>
                </>
              ) : null}
            </span>
          </p>
        ) : null}
        {error ? (
          <p className="border-t px-3 py-2 text-xs text-destructive">{error}</p>
        ) : (
          <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
            {projectId ? t("chat.modelPicker.scopeProject") : t("chat.modelPicker.scopeWorkspace")}
          </p>
        )}
      </PopoverContent>
    </Popover>
    <EngineConsentSheet
      engine={asking?.info ?? null}
      initialModel={asking?.model ?? ""}
      projectId={projectId ?? null}
      open={asking !== null}
      onOpenChange={(next) => {
        if (!next) setAsking(null);
      }}
      onConfirmed={() => void refreshEngines(true)}
    />
    </>
  );
}
