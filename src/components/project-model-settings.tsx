"use client";

/**
 * Which model a project answers with, as a choice rather than a JSON file.
 *
 * The page used to be two explanatory JSON snippets over a textarea, which asks
 * a newcomer to know provider ids, model ids and a flag name before they can do
 * anything at all. The file is unchanged - the form writes the same model.json
 * the runtime reads - and stays reachable under Advanced for anyone who wants it.
 *
 * Two runtime rules decide what the form may promise (project-model-choice.ts):
 * while the workspace runs on the included model every project uses it, and a
 * saved choice the workspace cannot serve quietly answers with the workspace
 * model. Both are said out loud here instead of left to be discovered.
 */

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { Check, ExternalLink, Loader2, Save, Settings2, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SkeletonBlock } from "@/components/ui/skeleton-list";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n/provider";
import {
  parseProjectModelFile,
  projectModelChoiceComplete,
  projectModelChoiceServable,
  projectModelOptions,
  projectProviderOptions,
  sameProjectModelChoice,
  serializeProjectModelFile,
  workspaceModelSummary,
  type ParsedProjectModelFile,
  type ProjectModelChoice,
  type ProjectModelMode,
  type ProjectModelsState,
} from "@/lib/pi/project-model-choice";

interface ModelLockState {
  locked: boolean;
  label: string;
  enforced?: boolean;
  selfHostedUrl?: string;
}

const SETTINGS_HREF = "/dashboard/settings";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ProjectModelSettings({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const fieldId = useId();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [models, setModels] = useState<ProjectModelsState | null>(null);
  const [lock, setLock] = useState<ModelLockState | null>(null);
  const [file, setFile] = useState<ParsedProjectModelFile | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [choice, setChoice] = useState<ProjectModelChoice>({ mode: "workspace", provider: "", model: "" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [rawDraft, setRawDraft] = useState("");
  const [rawSaving, setRawSaving] = useState(false);
  const [rawError, setRawError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/model`;

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const [fileRes, modelsRes] = await Promise.all([
        fetch(endpoint, { cache: "no-store" }),
        fetch("/api/pi/models", { cache: "no-store" }),
      ]);
      if (!fileRes.ok || !modelsRes.ok) throw new Error(`${fileRes.status}/${modelsRes.status}`);
      const fileJson = await fileRes.json();
      const modelsJson = (await modelsRes.json()) as ProjectModelsState & { modelLock?: ModelLockState };
      const content = typeof fileJson.content === "string" ? fileJson.content : "";
      const parsed = parseProjectModelFile(content);
      setModels(modelsJson);
      setLock(fileJson.modelLock ?? modelsJson.modelLock ?? null);
      setFileContent(content);
      setFile(parsed);
      setChoice(parsed.choice);
      setRawDraft(content);
      // A file the form cannot read can only be fixed by hand, so hand it over.
      setAdvancedOpen(!parsed.readable);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  const providerOptions = useMemo(() => (models ? projectProviderOptions(models) : []), [models]);
  const ownOptions = providerOptions.filter((option) => !option.managed);
  const managedOption = providerOptions.find((option) => option.managed);
  const selectedProvider = providerOptions.find((option) => option.id === choice.provider);
  const choosingManaged = Boolean(selectedProvider?.managed);
  const modelOptions = useMemo(
    () => (models && choice.provider ? projectModelOptions(models, choice.provider) : []),
    [models, choice.provider]
  );

  if (status === "loading") {
    return (
      <section className="rounded-xl border bg-card p-5" aria-busy="true">
        <SkeletonBlock />
      </section>
    );
  }

  if (status === "error" || !models || !file) {
    return (
      <section className="space-y-3 rounded-xl border bg-card p-5">
        <Alert variant="destructive">
          <AlertDescription>{t("projectSub.settings.loadFailed")}</AlertDescription>
        </Alert>
        <Button variant="outline" onClick={() => void load()}>
          {t("projectSub.settings.retry")}
        </Button>
      </section>
    );
  }

  // On the included model the runtime ignores model.json entirely, so the form
  // would only let someone save a choice that does nothing.
  if (lock?.locked) {
    return (
      <section className="space-y-3 rounded-xl border bg-card p-5">
        <h2 className="font-medium">{t("projectSub.settings.lockedTitle", { label: lock.label })}</h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          {lock.enforced
            ? t("settings.modelLock.enforcedDescription", { label: lock.label })
            : t("projectSub.settings.lockedDescription", { label: lock.label })}
        </p>
        {lock.enforced ? (
          lock.selfHostedUrl ? (
            <Button variant="outline" className="gap-2" asChild>
              <a href={lock.selfHostedUrl} target="_blank" rel="noreferrer noopener">
                <ExternalLink className="size-4" />
                {t("settings.modelLock.selfHostedCta")}
              </a>
            </Button>
          ) : null
        ) : (
          <Button variant="outline" className="gap-2" asChild>
            <Link href={SETTINGS_HREF}>
              <Settings2 className="size-4" />
              {t("projectSub.settings.openSettings")}
            </Link>
          </Button>
        )}
      </section>
    );
  }

  const workspace = workspaceModelSummary(models);
  const changed = !sameProjectModelChoice(choice, file.choice);
  // An unreadable file is replaced by whatever the form saves, so saving is
  // offered even while the form still shows its starting point.
  const saveable = changed || !file.readable;
  const complete = projectModelChoiceComplete(choice);
  const savedChoiceUnservable =
    file.readable && file.choice.mode === "project" && !projectModelChoiceServable(models, file.choice);
  const staleProvider = choice.mode === "project" && choice.provider && !selectedProvider ? choice.provider : "";
  const staleProviderName = models.providers?.find((provider) => provider.id === staleProvider)?.name || staleProvider;
  const staleModel =
    choice.mode === "project" && choice.model && !choosingManaged && !modelOptions.some((model) => model.id === choice.model)
      ? choice.model
      : "";
  const justSaved = savedAt !== null && !saveable;
  const rawDirty = rawDraft !== fileContent;

  function pickMode(mode: ProjectModelMode) {
    setSavedAt(null);
    setSaveError(null);
    setChoice((current) => ({ ...current, mode }));
  }

  function pickProvider(provider: string) {
    const options = models ? projectModelOptions(models, provider) : [];
    const managed = providerOptions.find((option) => option.id === provider)?.managed;
    const savedModel = file && provider === file.choice.provider && options.some((option) => option.id === file.choice.model)
      ? file.choice.model
      : "";
    // The included model and a provider with a single model have nothing left
    // to choose; coming back to the saved provider brings its saved model back.
    const model = managed || options.length === 1 ? options[0]?.id ?? "" : savedModel;
    setSavedAt(null);
    setSaveError(null);
    setChoice({ mode: "project", provider, model });
  }

  function pickModel(model: string) {
    setSavedAt(null);
    setSaveError(null);
    setChoice((current) => ({ ...current, mode: "project", model }));
  }

  async function writeFile(content: string): Promise<string> {
    const res = await fetch(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : res.statusText);
    return typeof json.content === "string" ? json.content : content;
  }

  async function saveChoice() {
    if (!file || !saveable || !complete) return;
    setSaving(true);
    setSaveError(null);
    try {
      const written = await writeFile(serializeProjectModelFile(choice, file.extra));
      const parsed = parseProjectModelFile(written);
      const previousContent = fileContent;
      setFileContent(written);
      setFile(parsed);
      // Following the workspace writes no provider, but the form keeps the last
      // pick for this visit, so switching back is not a fresh start.
      setChoice(parsed.choice.mode === "workspace" ? { ...choice, mode: "workspace" } : parsed.choice);
      // Advanced shows the same file: follow it, unless it holds edits of its own.
      setRawDraft((draft) => (draft === previousContent ? written : draft));
      setSavedAt(Date.now());
    } catch (error) {
      setSaveError(t("projectSub.settings.saveFailed", { error: errorText(error) }));
    } finally {
      setSaving(false);
    }
  }

  async function saveRaw() {
    setRawSaving(true);
    setRawError(null);
    try {
      const written = await writeFile(rawDraft);
      const parsed = parseProjectModelFile(written);
      setFileContent(written);
      setFile(parsed);
      setChoice(parsed.choice);
      setRawDraft(written);
      setSavedAt(null);
    } catch (error) {
      setRawError(t("projectSub.settings.saveFailed", { error: errorText(error) }));
    } finally {
      setRawSaving(false);
    }
  }

  const providerFieldId = `${fieldId}-provider`;
  const modelFieldId = `${fieldId}-model`;

  return (
    <section className="space-y-5 rounded-xl border bg-card p-5">
      {!file.readable ? (
        // The colour sits on the border and the icon; the words stay in the
        // foreground, because warning text on a warning wash fails contrast.
        <Alert className="border-warning/60 text-warning">
          <TriangleAlert />
          <AlertDescription className="text-foreground">{t("projectSub.settings.unreadable")}</AlertDescription>
        </Alert>
      ) : null}

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">{t("projectSub.settings.legend")}</legend>

        <ChoiceRow
          name={`${fieldId}-mode`}
          checked={choice.mode === "workspace"}
          onSelect={() => pickMode("workspace")}
          title={t("projectSub.settings.workspaceTitle")}
        >
          {workspace ? (
            <span className="block text-sm text-muted-foreground">
              <span className="text-foreground">{workspace.provider}</span>
              {workspace.model ? (
                <>
                  {" · "}
                  <span className="break-all font-mono text-foreground">{workspace.model}</span>
                </>
              ) : null}
            </span>
          ) : (
            <span className="block text-sm text-muted-foreground">{t("projectSub.settings.workspaceNone")}</span>
          )}
          <span className="block text-xs text-muted-foreground">{t("projectSub.settings.workspaceFollows")}</span>
        </ChoiceRow>

        <ChoiceRow
          name={`${fieldId}-mode`}
          checked={choice.mode === "project"}
          onSelect={() => pickMode("project")}
          title={t("projectSub.settings.projectTitle")}
          panel={
            <>
              {savedChoiceUnservable && !changed ? (
                <Alert className="border-warning/60 text-warning">
                  <TriangleAlert />
                  <AlertDescription className="text-foreground">{t("projectSub.settings.unavailable")}</AlertDescription>
                </Alert>
              ) : null}

              {providerOptions.length === 0 && !staleProvider ? (
                <p className="text-sm text-muted-foreground">{t("projectSub.settings.noProviders")}</p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor={providerFieldId} className="text-xs text-muted-foreground">
                      {t("settings.chooseProvider")}
                    </Label>
                    <Select value={choice.provider} onValueChange={pickProvider}>
                      <SelectTrigger id={providerFieldId} className="w-full">
                        <SelectValue placeholder={t("settings.selectProvider")} />
                      </SelectTrigger>
                      <SelectContent>
                        {ownOptions.length > 0 ? (
                          <SelectGroup>
                            {ownOptions.map((option) => (
                              <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>
                            ))}
                          </SelectGroup>
                        ) : null}
                        {managedOption ? (
                          <>
                            {ownOptions.length > 0 ? <SelectSeparator /> : null}
                            <SelectGroup>
                              <SelectItem value={managedOption.id}>{managedOption.name}</SelectItem>
                            </SelectGroup>
                          </>
                        ) : null}
                        {staleProvider ? (
                          <>
                            {providerOptions.length > 0 ? <SelectSeparator /> : null}
                            <SelectGroup>
                              <SelectItem value={staleProvider} disabled>
                                {t("projectSub.settings.notConnected", { name: staleProviderName })}
                              </SelectItem>
                            </SelectGroup>
                          </>
                        ) : null}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    {choosingManaged ? (
                      <>
                        <span className="block text-xs font-medium text-muted-foreground">{t("settings.chooseModelLabel")}</span>
                        <p className="flex min-h-9 items-center text-sm text-muted-foreground">
                          {t("settings.modelLock.includedCredits")}
                        </p>
                      </>
                    ) : (
                      <>
                        <Label htmlFor={modelFieldId} className="text-xs text-muted-foreground">
                          {t("settings.chooseModelLabel")}
                        </Label>
                        <Select value={choice.model} onValueChange={pickModel} disabled={!selectedProvider}>
                          <SelectTrigger id={modelFieldId} className="w-full">
                            <SelectValue
                              placeholder={selectedProvider ? t("settings.selectModel") : t("projectSub.settings.chooseProviderFirst")}
                            />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {modelOptions.map((model) => (
                                <SelectItem key={model.id} value={model.id}>
                                  {model.id}
                                  {model.name && model.name !== model.id ? ` · ${model.name}` : ""}
                                </SelectItem>
                              ))}
                              {staleModel ? (
                                <SelectItem value={staleModel} disabled>
                                  {t("projectSub.settings.modelUnavailable", { model: staleModel })}
                                </SelectItem>
                              ) : null}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </>
                    )}
                  </div>
                </div>
              )}

              <Link
                href={SETTINGS_HREF}
                className="inline-flex items-center text-xs font-medium text-foreground underline decoration-foreground/40 underline-offset-2 transition-colors hover:decoration-foreground"
              >
                {t("projectSub.settings.connectMore")}
              </Link>
            </>
          }
        >
          <span className="block text-sm text-muted-foreground">{t("projectSub.settings.projectDescription")}</span>
        </ChoiceRow>
      </fieldset>

      <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-4">
        {saveError ? (
          <p role="alert" className="mr-auto text-sm text-destructive">{saveError}</p>
        ) : null}
        {changed && !saving ? (
          <Badge variant="outline" className="border-warning/40 text-warning">
            {t("settings.unsavedModel")}
          </Badge>
        ) : null}
        {justSaved ? (
          <span key={savedAt} role="status" data-confirm className="inline-flex items-center gap-1.5 text-sm text-success">
            <Check className="size-4" />
            {t("settings.saved")}
          </span>
        ) : null}
        <Button onClick={() => void saveChoice()} disabled={saving || !saveable || !complete} className="gap-2">
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          {t("settings.saveModel")}
        </Button>
      </div>

      <details
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
        className="rounded-lg border p-4"
      >
        <summary className="cursor-pointer text-sm font-medium">{t("projectSub.settings.advancedSummary")}</summary>
        <div className="mt-4 space-y-3">
          <p className="text-xs text-muted-foreground">{t("projectSub.settings.editorDescription")}</p>
          <Textarea
            aria-label="model.json"
            value={rawDraft}
            onChange={(event) => setRawDraft(event.target.value)}
            rows={8}
            spellCheck={false}
            disabled={rawSaving}
            className="font-mono text-xs"
          />
          {rawError ? (
            <Alert variant="destructive">
              <AlertDescription>{rawError}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={() => void saveRaw()} disabled={rawSaving || !rawDirty} className="gap-2">
              {rawSaving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              {t("common.save")}
            </Button>
          </div>
        </div>
      </details>
    </section>
  );
}

/**
 * One answer to "which model", as a row that selects as a whole.
 *
 * The label holds the radio and its words only; the pickers that belong to an
 * answer sit below it inside the same outline, because a label may contain
 * exactly one control and the selects are controls of their own.
 */
function ChoiceRow({
  name,
  checked,
  onSelect,
  title,
  children,
  panel,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  children: React.ReactNode;
  panel?: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border transition-colors ${checked ? "border-ring bg-muted/30" : "hover:bg-muted/20"}`}>
      <label className="flex cursor-pointer items-start gap-3 p-4">
        <input type="radio" name={name} checked={checked} onChange={onSelect} className="shrink-0 accent-primary" />
        <span className="min-w-0 space-y-1 pt-0.5">
          <span className="block text-sm font-medium">{title}</span>
          {children}
        </span>
      </label>
      {checked && panel ? <div className="space-y-3 px-4 pb-4 sm:pl-13">{panel}</div> : null}
    </div>
  );
}
