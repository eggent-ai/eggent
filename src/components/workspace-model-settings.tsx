"use client";

/**
 * The workspace's own model: which provider answers, and with which model.
 *
 * This is the first screen after sign-up, and it used to put six things at the
 * same weight: the model, a thinking level, image generation, the raw
 * models.json, the way back to the included model and a Save button for the
 * whole page. Provider and model are the one decision a newcomer came here to
 * make, so they are the card. Everything else is still here, but quietly -
 * under Advanced, or as a link inside a sentence.
 */

import { useEffect, useId, useMemo, useState } from "react";
import { Check, ExternalLink, KeyRound, Loader2, PlugZap, Save, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonBlock } from "@/components/ui/skeleton-list";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n/provider";
import type { MessageKey, MessageValues } from "@/i18n/messages";

interface ModelSelectionResult {
  switched: boolean;
  provider?: string;
  model?: string;
  reason?: "model_locked" | "no_available_model";
}

/**
 * What to tell someone whose key was accepted.
 *
 * Saving a key and answering with it are separate steps. When the second one
 * does not happen the workspace carries on with the model it had, so silence
 * would read as success and the next hour of work bills to the old model.
 */
function modelSelectionNotice(
  selection: ModelSelectionResult | undefined,
  providerId: string,
  t: (key: MessageKey, values?: MessageValues) => string
): string | null {
  if (!selection) return null;
  if (selection.switched) {
    return t("settings.models.keySavedSwitched", { model: selection.model || "" });
  }
  return selection.reason === "model_locked"
    ? t("settings.models.keySavedStillOnIncluded")
    : t("settings.models.keySavedNoModel", { provider: providerId });
}

interface PiProviderState {
  id: string;
  name?: string;
  stored: boolean;
  credentialType?: "api_key" | "oauth";
  modelCount: number;
  availableModelCount: number;
  auth?: { configured?: boolean; source?: string; label?: string };
}

interface PiOAuthProviderState {
  id: string;
  name: string;
  usesCallbackServer?: boolean;
}

interface PiApiKeyProviderState {
  id: string;
  name?: string;
  auth?: { configured?: boolean; source?: string; label?: string };
}

interface PiCredentialState {
  provider: string;
  providerName?: string;
  type: "api_key" | "oauth";
  auth?: { configured?: boolean; source?: string; label?: string };
}

interface PiModelState {
  provider: string;
  id: string;
  name?: string;
  available: boolean;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

interface PiState {
  agentDir: string;
  authFile: string;
  modelsFile: string;
  settings?: {
    settingsFile: string;
    defaultProvider?: string;
    defaultModel?: string;
    defaultThinkingLevel?: string;
  };
  current?: {
    provider?: string;
    providerName?: string;
    model?: PiModelState;
    auth?: { configured?: boolean; source?: string; label?: string };
    credentialType?: "api_key" | "oauth";
    stored?: boolean;
  } | null;
  oauthProviders: PiOAuthProviderState[];
  apiKeyProviders: PiApiKeyProviderState[];
  credentials: PiCredentialState[];
  providers: PiProviderState[];
  models: PiModelState[];
  availableModels: PiModelState[];
  modelLock?: {
    locked: boolean;
    label: string;
    enforced?: boolean;
    selfHostedUrl?: string;
  };
  managed?: {
    available: boolean;
    providerId?: string | null;
    label?: string;
  };
  imageGeneration?: {
    enabled: boolean;
    provider: "eggent" | "custom" | "none";
    label: string;
    providerId?: string;
    model?: string;
    reason?: string;
  };
  imageProviders?: Array<{ id: string; name: string }>;
  /** What the workspace is set to, whether or not the provider still lists it. */
  savedModel?: { provider: string; providerName?: string; model: string; available: boolean } | null;
  /** What actually answers: the saved model while it is servable, the fallback otherwise. */
  runtimeModel?: { provider: string; providerName?: string; model: PiModelState } | null;
}

type LoginEvent =
  | { id: string; type: "auth_url"; url: string; instructions?: string }
  | { id: string; type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { id: string; type: "progress"; message: string }
  | { id: string; type: "prompt"; promptId: string; message: string; placeholder?: string; allowEmpty?: boolean; manualCode?: boolean }
  | { id: string; type: "select"; promptId: string; message: string; options: Array<{ id: string; label: string }> }
  | { id: string; type: "completed"; modelSelection?: ModelSelectionResult }
  | { id: string; type: "error"; message: string };

interface LoginJobState {
  id: string;
  provider: string;
  status: "running" | "completed" | "error" | "cancelled";
  error?: string;
  events: LoginEvent[];
}

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** How long to wait for a provider login before treating it as abandoned. */
const OAUTH_POLL_TIMEOUT_MS = 10 * 60 * 1000;
/** Consecutive failed polls tolerated before giving up on the login. */
const OAUTH_POLL_MAX_FAILURES = 5;

/** A secondary action that reads as part of the sentence it sits in. */
const QUIET_LINK =
  "font-medium text-foreground underline decoration-foreground/30 underline-offset-2 transition-colors hover:decoration-foreground disabled:pointer-events-none disabled:opacity-50";
/** One step further back: offered, never suggested. */
const QUIETER_LINK =
  "text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground";

export function WorkspaceModelSettings() {
  const { t } = useI18n();
  const fieldId = useId();
  const [piState, setPiState] = useState<PiState | null>(null);
  const [modelsJson, setModelsJson] = useState("");
  const [modelsJsonSaved, setModelsJsonSaved] = useState("");
  const [piLoading, setPiLoading] = useState(true);
  const [piError, setPiError] = useState<string | null>(null);
  const [piNotice, setPiNotice] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [apiKeyEnv, setApiKeyEnv] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);
  const [returningToManaged, setReturningToManaged] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const [oauthSaving, setOauthSaving] = useState(false);
  const [oauthJob, setOauthJob] = useState<LoginJobState | null>(null);
  const [promptInputs, setPromptInputs] = useState<Record<string, string>>({});
  const [answeredPrompts, setAnsweredPrompts] = useState<Record<string, true>>({});
  const [savingModelsJson, setSavingModelsJson] = useState(false);
  const [savingDefaultModel, setSavingDefaultModel] = useState(false);
  const [modelSavedAt, setModelSavedAt] = useState<number | null>(null);
  const [defaultProviderSelection, setDefaultProviderSelection] = useState("");
  const [defaultModelSelection, setDefaultModelSelection] = useState("");
  const [defaultThinkingLevel, setDefaultThinkingLevel] = useState("high");
  const [imageProviderSelection, setImageProviderSelection] = useState("");
  const [imageModelSelection, setImageModelSelection] = useState("");
  const [savingImageBackend, setSavingImageBackend] = useState(false);

  useEffect(() => {
    void loadPiState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const oauthJobId = oauthJob?.id;
  const oauthJobStatus = oauthJob?.status;

  useEffect(() => {
    if (!oauthJobId || oauthJobStatus !== "running") return;

    // This runs once a second, so every way out of "running" has to stop it.
    // Reporting an error and carrying on left the tab polling for as long as it
    // stayed open — one workspace sent 950 of these in a day — and a provider
    // login the person abandoned halfway never resolves at all.
    const startedAt = Date.now();
    let failures = 0;
    let timer: number | null = null;

    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    const giveUp = (message?: string) => {
      stop();
      setPiError(message || t("settings.errors.pollProviderLogin"));
    };

    timer = window.setInterval(async () => {
      if (Date.now() - startedAt > OAUTH_POLL_TIMEOUT_MS) {
        giveUp();
        return;
      }
      try {
        const res = await fetch(`/api/pi/auth/login?id=${encodeURIComponent(oauthJobId)}`, { cache: "no-store" });
        const json = await res.json().catch(() => null) as LoginJobState | { error?: string } | null;
        if (!res.ok || !json || ("error" in json && !("status" in json))) {
          failures += 1;
          // A single blip mid-login is not worth losing the flow over.
          if (failures >= OAUTH_POLL_MAX_FAILURES) giveUp(json?.error);
          return;
        }
        failures = 0;
        const next = json as LoginJobState;
        setOauthJob(next);
        if (next.status !== "running") {
          stop();
          // A finished sign-in does not mean the workspace moved onto it.
          const completed = next.events.find((event) => event.type === "completed");
          if (completed?.type === "completed") {
            setPiNotice(modelSelectionNotice(completed.modelSelection, next.provider, t));
          }
          await loadPiState();
        }
      } catch {
        failures += 1;
        if (failures >= OAUTH_POLL_MAX_FAILURES) giveUp();
      }
    }, 1000);

    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oauthJobId, oauthJobStatus]);

  async function loadPiState() {
    try {
      setPiLoading(true);
      setPiError(null);
      const [stateRes, rawRes] = await Promise.all([
        fetch("/api/pi/models", { cache: "no-store" }),
        fetch("/api/pi/models?raw=1", { cache: "no-store" }),
      ]);
      const [stateJson, rawJson] = await Promise.all([stateRes.json(), rawRes.json()]);
      if (!stateRes.ok) throw new Error(stateJson.error || t("settings.errors.loadModels"));
      setPiState(stateJson);
      const defaultProvider = typeof stateJson?.settings?.defaultProvider === "string" ? stateJson.settings.defaultProvider : "";
      const defaultModel = typeof stateJson?.settings?.defaultModel === "string" ? stateJson.settings.defaultModel : "";
      const availablePiModels = Array.isArray(stateJson?.availableModels) ? stateJson.availableModels as PiModelState[] : [];
      const defaultProviderHasModels = Boolean(defaultProvider && availablePiModels.some((model) => model.provider === defaultProvider));
      // Nothing is preselected when the workspace has no default provider.
      // Falling back to the first available one put the included model back in
      // the box right after someone had deliberately disconnected it, which read
      // as "it is still on" and made the screen look like it ignored the click.
      const providerSelection = defaultProviderHasModels ? defaultProvider : "";
      const firstProviderModel = availablePiModels.find((model) => model.provider === providerSelection);
      setDefaultProviderSelection(providerSelection);
      setDefaultModelSelection(defaultProviderHasModels && defaultModel ? defaultModel : firstProviderModel?.id || "");
      const imageBackend = stateJson?.imageGeneration as { providerId?: string; model?: string; provider?: string } | undefined;
      setImageProviderSelection(imageBackend?.provider === "custom" ? imageBackend.providerId || "" : "");
      setImageModelSelection(imageBackend?.provider === "custom" ? imageBackend.model || "" : "");
      setDefaultThinkingLevel(typeof stateJson?.settings?.defaultThinkingLevel === "string" ? stateJson.settings.defaultThinkingLevel : "high");
      const raw = typeof rawJson.content === "string" ? rawJson.content : "";
      setModelsJson(raw);
      setModelsJsonSaved(raw);
    } catch (error) {
      setPiError(error instanceof Error ? error.message : t("settings.errors.loadModelConnections"));
    } finally {
      setPiLoading(false);
    }
  }

  async function saveProviderKey() {
    const providerId = defaultProviderSelection.trim();
    if (!providerId || !apiKey.trim()) return;
    let env: Record<string, string> | undefined;
    if (apiKeyEnv.trim()) {
      try {
        const parsed = JSON.parse(apiKeyEnv) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        env = Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string")) as Record<string, string>;
      } catch {
        setPiError(t("settings.errors.providerEnvJson"));
        return;
      }
    }
    try {
      setSavingProvider(true);
      setPiError(null);
      const res = await fetch("/api/pi/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, apiKey: apiKey.trim(), env }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("settings.errors.saveProviderKey"));
      setApiKey("");
      setApiKeyEnv("");
      setReplacingKey(false);
      setPiState(json);
      // Saving the key and moving onto it are two steps, and the second one can
      // fail on its own. Silence here is what let a workspace keep answering on
      // the included model, and spending its credits, after its owner thought
      // he had switched away.
      setPiNotice(modelSelectionNotice(json?.modelSelection, providerId, t));
      await loadPiState();
    } catch (error) {
      setPiError(error instanceof Error ? error.message : t("settings.errors.saveProviderKey"));
    } finally {
      setSavingProvider(false);
    }
  }

  /**
   * Save which provider and model answer image requests.
   *
   * Only reachable on a workspace running its own model: while the included
   * model is active it serves images too, so there is nothing to choose.
   */
  async function saveImageBackend(clear = false) {
    try {
      setSavingImageBackend(true);
      setPiError(null);
      const res = await fetch("/api/pi/images", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(clear ? {} : { provider: imageProviderSelection, model: imageModelSelection }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || t("settings.errors.saveImageBackend"));
      setPiState(json);
      await loadPiState();
    } catch (error) {
      setPiError(error instanceof Error ? error.message : t("settings.errors.saveImageBackend"));
    } finally {
      setSavingImageBackend(false);
    }
  }

  async function returnToEggentAi() {
    try {
      setReturningToManaged(true);
      setPiError(null);
      setPiNotice(null);
      const res = await fetch("/api/pi/auth/eggent", { method: "POST" });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || t("settings.errors.returnToManaged"));
      setPiState(json);
      // Say so when the included model had to be written back into models.json:
      // the file is one click away under Advanced, and a silent rewrite of what
      // someone may be editing is worse than a sentence about it.
      const repair = json?.repair as { repaired?: boolean; backupPath?: string } | undefined;
      if (repair?.backupPath) {
        setPiNotice(t("settings.managedRepairedFromBroken", { path: repair.backupPath }));
      } else if (repair?.repaired) {
        setPiNotice(t("settings.managedRepaired"));
      }
      await loadPiState();
    } catch (error) {
      setPiError(error instanceof Error ? error.message : t("settings.errors.returnToManaged"));
    } finally {
      setReturningToManaged(false);
    }
  }

  async function logoutProvider(providerId: string, providerName: string) {
    const managedId = piState?.managed?.providerId || "eggent-ai";
    const message = providerId === managedId || providerId === "eggent-ai"
      ? t("settings.logoutEggentAiConfirm")
      : t("settings.logoutConfirm", { provider: providerName });
    if (!confirm(message)) return;
    const res = await fetch(`/api/pi/auth?provider=${encodeURIComponent(providerId)}`, { method: "DELETE" });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      setPiError(json?.error || t("settings.errors.logoutProvider"));
      return;
    }
    setPiState(json);
    await loadPiState();
  }

  async function startOAuthLogin() {
    const providerId = defaultProviderSelection.trim();
    if (!providerId) return;
    try {
      setOauthSaving(true);
      setPiError(null);
      setOauthJob(null);
      setPromptInputs({});
      setAnsweredPrompts({});
      const res = await fetch("/api/pi/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("settings.errors.startProviderLogin"));
      setOauthJob(json);
    } catch (error) {
      setPiError(error instanceof Error ? error.message : t("settings.errors.startProviderLogin"));
    } finally {
      setOauthSaving(false);
    }
  }

  async function answerLoginPrompt(promptId: string, value: string) {
    if (!oauthJob) return;
    const res = await fetch("/api/pi/auth/login", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: oauthJob.id, promptId, value }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      setPiError(json?.error || t("settings.errors.answerLoginPrompt"));
      return;
    }
    setAnsweredPrompts((prev) => ({ ...prev, [promptId]: true }));
    setOauthJob(json);
  }

  async function cancelOAuthLogin() {
    if (!oauthJob) return;
    await fetch(`/api/pi/auth/login?id=${encodeURIComponent(oauthJob.id)}`, { method: "DELETE" }).catch(() => null);
    setOauthJob((prev) => prev ? { ...prev, status: "cancelled", error: t("common.cancel") } : prev);
  }

  function handleDefaultProviderChange(providerId: string) {
    setDefaultProviderSelection(providerId);
    const firstModel = (piState?.availableModels ?? [])
      .filter((model) => model.provider === providerId)
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    setDefaultModelSelection(firstModel?.id || "");
    // A key pasted while one provider was selected must never be saved to the
    // next one.
    setApiKey("");
    setApiKeyEnv("");
    setReplacingKey(false);
    setModelSavedAt(null);
  }

  function handleDefaultModelChange(modelId: string) {
    setDefaultModelSelection(modelId);
    setModelSavedAt(null);
  }

  function handleThinkingLevelChange(level: string) {
    setDefaultThinkingLevel(level);
    setModelSavedAt(null);
  }

  async function saveDefaultModel() {
    const providerId = defaultProviderSelection.trim();
    const modelId = defaultModelSelection.trim();
    if (!providerId || !modelId) return;
    try {
      setSavingDefaultModel(true);
      setPiError(null);
      const res = await fetch("/api/pi/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, model: modelId, thinkingLevel: defaultThinkingLevel }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("settings.errors.saveDefaultModel"));
      await loadPiState();
      setModelSavedAt(Date.now());
    } catch (error) {
      setPiError(error instanceof Error ? error.message : t("settings.errors.saveDefaultModel"));
    } finally {
      setSavingDefaultModel(false);
    }
  }

  async function saveModelsJson() {
    try {
      setSavingModelsJson(true);
      setPiError(null);
      const res = await fetch("/api/pi/models", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: modelsJson }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t("settings.errors.saveModelsJson"));
      const next = typeof json.content === "string" ? json.content : modelsJson;
      setModelsJson(next);
      setModelsJsonSaved(next);
      await loadPiState();
    } catch (error) {
      setPiError(error instanceof Error ? error.message : t("settings.errors.saveModelsJson"));
    } finally {
      setSavingModelsJson(false);
    }
  }

  // The included model is deliberately absent from this list. It is not a
  // provider you connect - coming back to it is a link of its own under the
  // card - and leaving it in meant the same action appeared twice on one
  // screen, in a list the user had just used to walk away from it.
  const providerChoices = useMemo(() => {
    const managedId = piState?.managed?.providerId || "eggent-ai";
    return (piState?.providers ?? [])
      .filter((item) => piState?.modelLock?.locked || item.id !== managedId)
      .map((item) => ({ id: item.id, name: item.name || item.id, availableModelCount: item.availableModelCount }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [piState]);

  const imageProviderChoices = useMemo(() => piState?.imageProviders ?? [], [piState]);

  const modelChoices = useMemo(() => {
    return (piState?.availableModels ?? [])
      .filter((model) => model.provider === defaultProviderSelection)
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [defaultProviderSelection, piState]);

  if (!piState) {
    if (piError && !piLoading) {
      return (
        <section className="space-y-3 rounded-xl border bg-card p-5">
          <Alert variant="destructive">
            <AlertDescription>{piError}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={() => void loadPiState()}>
            {t("settings.retry")}
          </Button>
        </section>
      );
    }
    return (
      <section className="rounded-xl border bg-card p-5" aria-busy="true">
        <SkeletonBlock />
      </section>
    );
  }

  const modelsJsonDirty = modelsJson !== modelsJsonSaved;
  const selectedProviderState = piState.providers.find((item) => item.id === defaultProviderSelection);
  const selectedOauthProvider = piState.oauthProviders.find((item) => item.id === defaultProviderSelection);
  const selectedApiKeyProvider = piState.apiKeyProviders.find((item) => item.id === defaultProviderSelection);
  const selectedProviderName = selectedProviderState?.name || selectedOauthProvider?.name || selectedApiKeyProvider?.name || defaultProviderSelection;
  const selectedProviderConnected = Boolean(defaultProviderSelection && modelChoices.length > 0);
  const selectedProviderHasStoredCredential = piState.credentials.some((item) => item.provider === defaultProviderSelection);
  const managedProviderId = piState.managed?.providerId || "";
  const managedLabel = piState.managed?.label || piState.modelLock?.label || "Eggent AI";
  // Offered only when the credential is actually there and is not already in use.
  const managedAvailable = Boolean(piState.managed?.available) && piState.settings?.defaultProvider !== managedProviderId;
  // True while the page holds a model choice the server does not have yet.
  const modelSelectionDirty = Boolean(defaultProviderSelection && defaultModelSelection) && (
    piState.settings?.defaultProvider !== defaultProviderSelection ||
    piState.settings?.defaultModel !== defaultModelSelection ||
    piState.settings?.defaultThinkingLevel !== defaultThinkingLevel
  );
  const modelJustSaved = modelSavedAt !== null && !modelSelectionDirty;
  const modelLocked = Boolean(piState.modelLock?.locked);
  const modelLockLabel = piState.modelLock?.label || "Eggent AI";
  const modelLockEnforced = Boolean(piState.modelLock?.enforced);
  const modelLockSelfHostedUrl = piState.modelLock?.selfHostedUrl || "https://github.com/eggent-ai/eggent";
  const eggentImagesEnabled = Boolean(piState.imageGeneration?.enabled);
  // The pickers show what is saved; these say what actually answers, which is
  // something else whenever the saved model is not one the workspace can serve.
  const savedModel = piState.savedModel ?? null;
  const runtime = piState.runtimeModel ?? null;
  const savedUnavailable = Boolean(savedModel && !savedModel.available);
  const runtimeProviderName = runtime?.providerName || runtime?.provider || "";
  const runtimeModelId = runtime?.model?.id || "";
  const answeringElsewhere = Boolean(
    runtimeModelId &&
    (runtime?.provider !== piState.settings?.defaultProvider || runtimeModelId !== piState.settings?.defaultModel)
  );
  // A saved model the provider no longer lists still belongs in the picker,
  // disabled: an empty box over a workspace that has a model reads as a fault.
  const staleModel = defaultModelSelection && !modelChoices.some((model) => model.id === defaultModelSelection)
    ? defaultModelSelection
    : "";
  const showConnect = Boolean(defaultProviderSelection) && (!selectedProviderConnected || replacingKey);

  const providerFieldId = `${fieldId}-provider`;
  const modelFieldId = `${fieldId}-model`;
  const keyFieldId = `${fieldId}-key`;
  const thinkingFieldId = `${fieldId}-thinking`;

  return (
    <div className="space-y-4">
      <section className="space-y-5 rounded-xl border bg-card p-5">
        <div className="space-y-1">
          <h3 className="font-medium">{t("settings.workspaceModel.title")}</h3>
          <p className="text-sm text-muted-foreground">{t("settings.workspaceModel.description")}</p>
        </div>

        {piError ? (
          <Alert variant="destructive">
            <AlertDescription>{piError}</AlertDescription>
          </Alert>
        ) : null}
        {piNotice ? (
          <Alert>
            <AlertDescription>{piNotice}</AlertDescription>
          </Alert>
        ) : null}

        {modelLocked ? (
          <div className="space-y-3">
            <div>
              <div className="text-xs text-muted-foreground">{t("settings.activeNow")}</div>
              <p className="font-medium">{modelLockLabel}</p>
              <p className="text-sm text-muted-foreground">{t("settings.modelLock.includedCredits")}</p>
            </div>
            {modelLockEnforced ? (
              <>
                <p className="max-w-prose text-sm text-muted-foreground">
                  {t("settings.modelLock.enforcedDescription", { label: modelLockLabel })}
                </p>
                <Button variant="outline" className="gap-2" asChild>
                  <a href={modelLockSelfHostedUrl} target="_blank" rel="noreferrer noopener">
                    <ExternalLink className="size-4" />
                    {t("settings.modelLock.selfHostedCta")}
                  </a>
                </Button>
              </>
            ) : (
              <Button variant="outline" className="gap-2" onClick={() => logoutProvider("eggent-ai", modelLockLabel)}>
                <KeyRound className="size-4" />
                {t("settings.modelLock.useOwnProvider")}
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-5">
            {savedUnavailable ? (
              // The colour sits on the border and the icon; the words stay in
              // the foreground, because warning text on a warning wash fails
              // contrast.
              <Alert className="border-warning/60 text-warning">
                <TriangleAlert />
                <AlertDescription className="text-foreground">
                  {runtimeModelId
                    ? t("settings.savedModelUnavailableAnswering", {
                        model: savedModel?.model || "",
                        provider: runtimeProviderName,
                        runtime: runtimeModelId,
                      })
                    : t("settings.savedModelUnavailable", { model: savedModel?.model || "" })}
                </AlertDescription>
              </Alert>
            ) : answeringElsewhere ? (
              <p className="text-sm text-muted-foreground">
                {t("settings.activeNow")}:{" "}
                <span className="text-foreground">{runtimeProviderName}</span>
                {" · "}
                <span className="break-all font-mono text-foreground">{runtimeModelId}</span>
              </p>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor={providerFieldId} className="text-xs text-muted-foreground">
                {t("settings.chooseProvider")}
              </Label>
              <Select
                value={defaultProviderSelection}
                onValueChange={handleDefaultProviderChange}
                disabled={providerChoices.length === 0}
              >
                <SelectTrigger id={providerFieldId} className="w-full">
                  <SelectValue placeholder={t("settings.selectProvider")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {providerChoices.map((item) => (
                      <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>

              {/* Connected is a line, not a card: the provider is done with,
                  and the next thing to do is below. */}
              {selectedProviderConnected ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-sm">
                  <span className="inline-flex items-center gap-1.5 text-success">
                    <Check className="size-4" />
                    {t("settings.providerConnected")}
                  </span>
                  {selectedApiKeyProvider ? (
                    <button
                      type="button"
                      className={QUIETER_LINK}
                      aria-expanded={replacingKey}
                      onClick={() => setReplacingKey((open) => !open)}
                    >
                      {t("settings.replaceKey")}
                    </button>
                  ) : null}
                  {selectedProviderState?.stored ? (
                    <button
                      type="button"
                      className={`${QUIETER_LINK} hover:text-destructive`}
                      onClick={() => logoutProvider(defaultProviderSelection, selectedProviderName)}
                    >
                      {t("settings.disconnect")}
                    </button>
                  ) : null}
                </div>
              ) : null}

              {/* Exactly one way to connect is shown: the sign-in button for
                  an OAuth provider, the key field for an API one. */}
              {showConnect ? (
                <div className="space-y-3 pt-1">
                  {selectedOauthProvider && !selectedProviderConnected ? (
                    <Button onClick={startOAuthLogin} disabled={oauthSaving} className="gap-2">
                      {oauthSaving ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
                      {t("settings.loginWithSubscription")}
                    </Button>
                  ) : null}

                  {selectedApiKeyProvider ? (
                    <div className="space-y-2">
                      <Label htmlFor={keyFieldId} className="text-xs text-muted-foreground">
                        {selectedProviderHasStoredCredential
                          ? t("settings.replaceKeyLabel")
                          : t("settings.apiKeyLabel", { provider: selectedProviderName })}
                      </Label>
                      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                        <Input
                          id={keyFieldId}
                          value={apiKey}
                          onChange={(event) => setApiKey(event.target.value)}
                          type="password"
                          autoComplete="off"
                          placeholder={t("settings.apiKeyPlaceholder", { provider: selectedProviderName })}
                        />
                        <Button onClick={saveProviderKey} disabled={savingProvider || !apiKey.trim()} className="gap-2">
                          {savingProvider ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
                          {selectedProviderHasStoredCredential ? t("settings.replaceKey") : t("settings.saveKey")}
                        </Button>
                      </div>
                      <details>
                        <summary className="cursor-pointer text-xs text-muted-foreground">{t("settings.providerEnvSummary")}</summary>
                        <Textarea
                          value={apiKeyEnv}
                          onChange={(event) => setApiKeyEnv(event.target.value)}
                          rows={4}
                          spellCheck={false}
                          className="mt-2 font-mono text-xs"
                          placeholder={t("settings.providerEnvPlaceholder")}
                        />
                      </details>
                    </div>
                  ) : null}

                  {!selectedOauthProvider && !selectedApiKeyProvider ? (
                    <p className="text-sm text-muted-foreground">{t("settings.noLoginMethod")}</p>
                  ) : null}

                  {!selectedProviderConnected ? (
                    <p className="text-xs text-muted-foreground">{t("settings.providerDisconnectedDescription")}</p>
                  ) : null}
                </div>
              ) : null}

              {oauthJob ? (
                <div className="space-y-3 rounded-md border bg-muted/20 p-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      {t("settings.status")} <span className="font-medium">{oauthJob.status}</span>
                      {oauthJob.error ? <span className="text-destructive"> · {oauthJob.error}</span> : null}
                    </div>
                    {oauthJob.status === "running" ? (
                      <Button size="sm" variant="outline" onClick={cancelOAuthLogin}>{t("common.cancel")}</Button>
                    ) : null}
                  </div>
                  {oauthJob.events.map((event) => {
                    if (event.type === "auth_url") {
                      return (
                        <div key={event.id} className="space-y-1">
                          <p>{event.instructions || t("settings.openAuthUrlInstruction")}</p>
                          <a href={event.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline">
                            <ExternalLink className="size-3" />
                            {t("settings.openAuthUrl")}
                          </a>
                          <p className="break-all text-xs text-muted-foreground">{event.url}</p>
                        </div>
                      );
                    }
                    if (event.type === "device_code") {
                      return (
                        <div key={event.id} className="rounded-md bg-background p-3">
                          <p>{t("settings.deviceCodeInstruction", { url: event.verificationUri })}</p>
                          <div className="mt-2 font-mono text-lg font-semibold tracking-widest">{event.userCode}</div>
                        </div>
                      );
                    }
                    if (event.type === "progress") return <p key={event.id} className="text-muted-foreground">{event.message}</p>;
                    if (event.type === "select" && oauthJob.status === "running" && !answeredPrompts[event.promptId]) {
                      return (
                        <div key={event.id} className="space-y-2">
                          <p className="font-medium">{event.message}</p>
                          <div className="flex flex-wrap gap-2">
                            {event.options.map((option) => (
                              <Button key={option.id} size="sm" variant="outline" onClick={() => answerLoginPrompt(event.promptId, option.id)}>
                                {option.label}
                              </Button>
                            ))}
                          </div>
                        </div>
                      );
                    }
                    if (event.type === "prompt" && oauthJob.status === "running" && !answeredPrompts[event.promptId]) {
                      return (
                        <div key={event.id} className="space-y-2">
                          <Label>{event.message}</Label>
                          <div className="grid gap-2 md:grid-cols-[1fr_auto]">
                            <Input
                              value={promptInputs[event.promptId] || ""}
                              placeholder={event.placeholder || ""}
                              onChange={(inputEvent) => setPromptInputs((prev) => ({ ...prev, [event.promptId]: inputEvent.target.value }))}
                            />
                            <Button
                              onClick={() => answerLoginPrompt(event.promptId, promptInputs[event.promptId] || "")}
                              disabled={!event.allowEmpty && !promptInputs[event.promptId]?.trim()}
                            >
                              {t("settings.send")}
                            </Button>
                          </div>
                        </div>
                      );
                    }
                    if (event.type === "completed") return <p key={event.id} className="text-success">{t("settings.loginCompleted")}</p>;
                    if (event.type === "error") return <p key={event.id} className="text-destructive">{event.message}</p>;
                    return null;
                  })}
                </div>
              ) : null}
            </div>

            {/* Stays visible but inert until the provider above can serve a
                model, so the last step is never a surprise. */}
            <div className="space-y-2">
              <Label htmlFor={modelFieldId} className="text-xs text-muted-foreground">
                {t("settings.chooseModelLabel")}
              </Label>
              <Select value={defaultModelSelection} onValueChange={handleDefaultModelChange} disabled={!selectedProviderConnected}>
                <SelectTrigger id={modelFieldId} className="w-full">
                  <SelectValue placeholder={selectedProviderConnected ? t("settings.selectModel") : t("settings.selectProviderFirst")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {modelChoices.map((model) => (
                      <SelectItem key={`${model.provider}/${model.id}`} value={model.id}>
                        {model.id}{model.name && model.name !== model.id ? ` · ${model.name}` : ""}
                      </SelectItem>
                    ))}
                    {staleModel ? (
                      <SelectItem value={staleModel} disabled>
                        {t("settings.modelUnavailable", { model: staleModel })}
                      </SelectItem>
                    ) : null}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-3">
              {modelSelectionDirty && !savingDefaultModel ? (
                <Badge variant="outline" className="border-warning/40 text-warning">
                  {t("settings.unsavedModel")}
                </Badge>
              ) : null}
              {modelJustSaved ? (
                <span key={modelSavedAt} role="status" data-confirm className="inline-flex items-center gap-1.5 text-sm text-success">
                  <Check className="size-4" />
                  {t("settings.saved")}
                </span>
              ) : null}
              <Button
                onClick={() => void saveDefaultModel()}
                disabled={savingDefaultModel || !defaultModelSelection || !selectedProviderConnected}
                className="gap-2"
              >
                {savingDefaultModel ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                {t("settings.saveModel")}
              </Button>
            </div>
          </div>
        )}

        {/* The way back to the included model undoes everything above at
            once, so it is offered in a sentence rather than as a card of its
            own. The managed credential survives leaving, so this is a state
            change, not a new sign-in. */}
        {!modelLocked && managedAvailable ? (
          <p className="border-t pt-4 text-sm text-muted-foreground">
            {t("settings.managedReturn.description", { label: managedLabel })}{" "}
            <button type="button" className={QUIET_LINK} onClick={returnToEggentAi} disabled={returningToManaged}>
              {returningToManaged ? <Loader2 className="mr-1 inline size-3.5 animate-spin" /> : null}
              {t("settings.managedReturn.cta", { label: managedLabel })}
            </button>
          </p>
        ) : null}
      </section>

      {!modelLocked ? (
        <details className="rounded-xl border bg-card px-5 py-4">
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
            {t("settings.advanced.summary")}
          </summary>
          <div className="mt-5 space-y-5">
            <div className="space-y-2">
              <Label htmlFor={thinkingFieldId}>{t("settings.thinking")}</Label>
              <p className="text-xs text-muted-foreground">{t("settings.thinkingDescription")}</p>
              <Select value={defaultThinkingLevel} onValueChange={handleThinkingLevelChange} disabled={!selectedProviderConnected}>
                <SelectTrigger id={thinkingFieldId} className="w-full sm:w-48">
                  <SelectValue placeholder={t("settings.thinking")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {thinkingLevels.map((level) => <SelectItem key={level} value={level}>{level}</SelectItem>)}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            {/* Images follow the text model. The included model covers both;
                a workspace on its own provider brings its own image model or
                has none. */}
            <div className="space-y-3 border-t pt-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-sm font-medium">{t("settings.imageGeneration.title")}</h4>
                <Badge variant={eggentImagesEnabled ? "secondary" : "outline"}>
                  {eggentImagesEnabled ? t("settings.imageGeneration.enabled") : t("settings.imageGeneration.unavailable")}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">{t("settings.imageGeneration.ownDescription")}</p>
              <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
                <Select value={imageProviderSelection} onValueChange={setImageProviderSelection} disabled={imageProviderChoices.length === 0}>
                  <SelectTrigger className="w-full" aria-label={t("settings.imageGeneration.selectProvider")}>
                    <SelectValue placeholder={imageProviderChoices.length === 0 ? t("settings.imageGeneration.noProviders") : t("settings.imageGeneration.selectProvider")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {imageProviderChoices.map((item) => (
                        <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Input
                  value={imageModelSelection}
                  onChange={(event) => setImageModelSelection(event.target.value)}
                  aria-label={t("settings.imageGeneration.modelPlaceholder")}
                  placeholder={t("settings.imageGeneration.modelPlaceholder")}
                  disabled={!imageProviderSelection}
                />
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => saveImageBackend()}
                    disabled={savingImageBackend || !imageProviderSelection || !imageModelSelection.trim()}
                    className="gap-2"
                  >
                    {savingImageBackend ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                    {t("common.save")}
                  </Button>
                  {piState.imageGeneration?.provider === "custom" ? (
                    <Button variant="ghost" size="sm" className="text-destructive" onClick={() => saveImageBackend(true)} disabled={savingImageBackend}>
                      {t("settings.imageGeneration.clear")}
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="space-y-2 border-t pt-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <h4 className="text-sm font-medium">{t("settings.customProvidersTitle")}</h4>
                  <p className="text-xs text-muted-foreground">{t("settings.customProvidersDescription")}</p>
                </div>
                <Button size="sm" variant="outline" onClick={saveModelsJson} disabled={savingModelsJson || !modelsJsonDirty} className="gap-2">
                  {savingModelsJson ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                  {t("settings.saveModelsJson")}
                </Button>
              </div>
              <Textarea
                aria-label="models.json"
                value={modelsJson}
                onChange={(event) => setModelsJson(event.target.value)}
                rows={14}
                spellCheck={false}
                className="min-h-80 font-mono text-xs"
              />
            </div>
          </div>
        </details>
      ) : null}
    </div>
  );
}
