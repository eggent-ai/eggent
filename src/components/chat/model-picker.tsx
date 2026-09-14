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
import { Check, ChevronDown, Loader2, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useI18n } from "@/i18n/provider";
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
  managedModels?: Array<{ id: string; name: string; family?: string }>;
  settings?: { defaultProvider?: string; defaultModel?: string; defaultThinkingLevel?: string };
}

export interface ModelPickerProps {
  /** Null for the orchestrator, where the choice is the workspace default. */
  projectId?: string | null;
}

interface ModelOption {
  provider: string;
  id: string;
  label: string;
  group: string;
}

export function ModelPicker({ projectId }: ModelPickerProps) {
  const { t } = useI18n();
  const [state, setState] = useState<PickerState | null>(null);
  const [chosen, setChosen] = useState<{ provider: string; model: string } | null>(null);
  const [projectFile, setProjectFile] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

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
    return (state?.availableModels ?? []).map((model) => {
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
        group: managed
          ? catalog?.family || state?.modelLock?.label || state?.managed?.label || "Eggent AI"
          : providerNames.get(model.provider) || model.provider,
      };
    });
  }, [state, managedId]);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = needle
      ? options.filter((option) =>
          option.label.toLowerCase().includes(needle)
          || option.id.toLowerCase().includes(needle)
          || option.group.toLowerCase().includes(needle))
      : options;
    const ordered: Array<{ group: string; models: ModelOption[] }> = [];
    for (const option of matching) {
      const last = ordered[ordered.length - 1];
      if (last && last.group === option.group) last.models.push(option);
      else ordered.push({ group: option.group, models: [option] });
    }
    return ordered;
  }, [options, query]);

  const currentLabel = useMemo(() => {
    if (!chosen) return null;
    const match = options.find((option) => option.id === chosen.model && (option.provider === chosen.provider
      || chosen.provider === "eggent-ai" || option.provider === "eggent-ai"));
    return match?.label || chosen.model;
  }, [chosen, options]);

  const thinking = state?.settings?.defaultThinkingLevel;

  async function choose(option: ModelOption) {
    if (saving) return;
    setSaving(option.id);
    setError(null);
    const previous = chosen;
    setChosen({ provider: option.provider, model: option.id });
    try {
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

  if (options.length === 0) {
    // Nothing to choose between - a workspace with one model, or none loaded.
    return <span className="font-mono">{currentLabel || t("chat.modelPicker.none")}</span>;
  }

  return (
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
          className="inline-flex items-center gap-1 rounded font-mono transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          aria-label={t("chat.modelPicker.trigger")}
        >
          <span>{currentLabel || t("chat.modelPicker.none")}</span>
          {thinking ? <span className="text-muted-foreground">· {thinking}</span> : null}
          <ChevronDown className="size-3" />
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
                  const active = chosen?.model === option.id;
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
        {error ? (
          <p className="border-t px-3 py-2 text-xs text-destructive">{error}</p>
        ) : (
          <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
            {projectId ? t("chat.modelPicker.scopeProject") : t("chat.modelPicker.scopeWorkspace")}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
