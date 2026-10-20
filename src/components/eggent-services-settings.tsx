"use client";

/**
 * Who draws, turns voice into text and looks back on chats, for a workspace on
 * its own model.
 *
 * The included model does all three while the workspace answers on it, and
 * none of them once it leaves - so leaving never quietly keeps spending its
 * balance. This is where one of them is turned back on, or pointed at a
 * provider of the workspace's own. One choice per row, saved as it is made;
 * a provider waits for its model id and a Save.
 */

import { useEffect, useId, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "@/i18n/provider";

type ServiceName = "images" | "speech" | "learning";

/** The slice of GET /api/pi/models this block reads. */
export interface ServicesState {
  managed: { label: string; images: boolean; speech: boolean; learning: boolean };
  images: { use: "eggent" | "provider" | "off"; automatic?: boolean; providerId?: string; model?: string; reason?: string };
  speech: { use: "eggent" | "provider" | "local"; automatic?: boolean; providerId?: string; model?: string; reason?: string };
  learning: { use: "eggent" | "chat"; automatic?: boolean };
  imageProviders: Array<{ id: string; name: string }>;
  speechProviders: Array<{ id: string; name: string }>;
}

interface Props {
  services: ServicesState;
  /** The models state the server answered with after a save. */
  onSaved: (state: unknown) => void | Promise<void>;
  onError: (message: string | null) => void;
}

export function EggentServicesSettings({ services, onSaved, onError }: Props) {
  const { t } = useI18n();
  const label = services.managed.label || "Eggent AI";
  const anyManaged = services.managed.images || services.managed.speech || services.managed.learning;
  const [saving, setSaving] = useState<ServiceName | null>(null);

  async function save(service: ServiceName, use: string, provider?: { provider: string; model: string }): Promise<void> {
    try {
      setSaving(service);
      onError(null);
      const res = await fetch("/api/pi/services", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service, use, ...(provider ?? {}) }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || t("settings.services.saveFailed"));
      await onSaved(json);
    } catch (error) {
      onError(error instanceof Error ? error.message : t("settings.services.saveFailed"));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="space-y-5 border-t pt-5">
      <div className="space-y-1">
        <h4 className="text-sm font-medium">{t("settings.services.title")}</h4>
        <p className="text-xs text-muted-foreground">
          {anyManaged ? t("settings.services.description", { label }) : t("settings.services.descriptionOwnOnly")}
        </p>
      </div>

      <ServiceRow
        service="images"
        title={t("settings.services.images.title")}
        current={services.images.use}
        options={[
          { value: "off", label: t("settings.services.images.off") },
          ...(services.managed.images || services.images.use === "eggent"
            ? [{ value: "eggent", label, note: t("settings.services.managedNote", { label }) }]
            : []),
          { value: "provider", label: t("settings.services.ownProvider") },
        ]}
        providers={services.imageProviders}
        providerId={services.images.providerId}
        model={services.images.model}
        modelPlaceholder={t("settings.services.images.modelPlaceholder")}
        problem={imagesProblem(services, label, t)}
        saving={saving === "images"}
        onSave={(use, provider) => save("images", use, provider)}
      />

      <ServiceRow
        service="speech"
        title={t("settings.services.speech.title")}
        current={services.speech.use}
        options={[
          { value: "local", label: t("settings.services.speech.local") },
          ...(services.managed.speech || services.speech.use === "eggent"
            ? [{ value: "eggent", label, note: t("settings.services.managedNote", { label }) }]
            : []),
          { value: "provider", label: t("settings.services.ownProvider") },
        ]}
        providers={services.speechProviders}
        providerId={services.speech.providerId}
        model={services.speech.model}
        modelPlaceholder={t("settings.services.speech.modelPlaceholder")}
        problem={speechProblem(services, label, t)}
        saving={saving === "speech"}
        onSave={(use, provider) => save("speech", use, provider)}
      />

      {services.managed.learning || services.learning.use === "eggent" ? (
        <ServiceRow
          service="learning"
          title={t("settings.services.learning.title")}
          description={t("settings.services.learning.description")}
          current={services.learning.use}
          options={[
            { value: "chat", label: t("settings.services.learning.chat") },
            { value: "eggent", label, note: t("settings.services.managedNote", { label }) },
          ]}
          saving={saving === "learning"}
          onSave={(use) => save("learning", use)}
        />
      ) : null}
    </div>
  );
}

type Translate = ReturnType<typeof useI18n>["t"];

function imagesProblem(services: ServicesState, label: string, t: Translate): string | null {
  const { use, reason, providerId } = services.images;
  if (!reason) return null;
  if (use === "eggent") return t("settings.services.images.managedUnavailable", { label });
  if (use === "provider") return t("settings.services.images.providerUnusable", { provider: providerId || "" });
  return null;
}

function speechProblem(services: ServicesState, label: string, t: Translate): string | null {
  const { use, reason, providerId } = services.speech;
  if (!reason) return null;
  if (use === "eggent") return t("settings.services.speech.managedUnavailable", { label });
  if (use === "provider") return t("settings.services.speech.providerUnusable", { provider: providerId || "" });
  return null;
}

interface RowProps {
  service: ServiceName;
  title: string;
  description?: string;
  current: string;
  options: Array<{ value: string; label: string; note?: string }>;
  providers?: Array<{ id: string; name: string }>;
  providerId?: string;
  model?: string;
  modelPlaceholder?: string;
  problem?: string | null;
  saving: boolean;
  onSave: (use: string, provider?: { provider: string; model: string }) => Promise<void>;
}

function ServiceRow(props: RowProps) {
  const { t } = useI18n();
  const fieldId = useId();
  // A provider row waits for its id and model before anything is saved, so the
  // pick is held here until then; every other choice is saved as it is made.
  const { current, providerId: savedProvider = "", model: savedModel = "" } = props;
  const [choice, setChoice] = useState(current);
  const [provider, setProvider] = useState(savedProvider);
  const [model, setModel] = useState(savedModel);

  // What the server saved wins over what is on screen once it answers.
  useEffect(() => {
    setChoice(current);
    setProvider(savedProvider);
    setModel(savedModel);
  }, [current, savedProvider, savedModel]);

  const providers = props.providers ?? [];
  const selectedNote = props.options.find((option) => option.value === choice)?.note;
  const providerDirty = choice === "provider" && (
    current !== "provider" || provider !== savedProvider || model.trim() !== savedModel
  );

  function pick(value: string) {
    setChoice(value);
    if (value !== "provider") void props.onSave(value);
  }

  return (
    <div className="space-y-2">
      {/* Label above the choice on a phone, beside it from sm up: one shape for
          every row, whether or not it carries a description. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0 space-y-0.5">
          <Label htmlFor={`${fieldId}-use`}>{props.title}</Label>
          {props.description ? <p className="text-xs text-muted-foreground">{props.description}</p> : null}
        </div>
        <div className="flex items-center gap-2">
          {props.saving ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" /> : null}
          <Select value={choice} onValueChange={pick} disabled={props.saving}>
            <SelectTrigger id={`${fieldId}-use`} className="w-full sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {props.options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>
      {selectedNote ? <p className="text-xs text-muted-foreground">{selectedNote}</p> : null}

      {choice === "provider" ? (
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
          <Select value={provider} onValueChange={setProvider} disabled={providers.length === 0 || props.saving}>
            <SelectTrigger className="w-full" aria-label={t("settings.services.selectProvider")}>
              <SelectValue placeholder={providers.length === 0 ? t("settings.services.noProviders") : t("settings.services.selectProvider")} />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {providers.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            aria-label={props.modelPlaceholder}
            placeholder={props.modelPlaceholder}
            disabled={!provider || props.saving}
          />
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => void props.onSave("provider", { provider, model: model.trim() })}
            disabled={props.saving || !provider || !model.trim() || !providerDirty}
          >
            {props.saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            {t("common.save")}
          </Button>
          {providers.length === 0 ? (
            <p className="text-xs text-muted-foreground md:col-span-3">{t("settings.services.noProvidersHint")}</p>
          ) : null}
        </div>
      ) : null}

      {props.problem ? <p className="text-xs text-warning">{props.problem}</p> : null}
    </div>
  );
}
