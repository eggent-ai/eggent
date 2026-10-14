"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";

/**
 * The project wizard: name, description, instructions. One form for the
 * Projects page and the sidebar's "+", so the two cannot drift apart.
 */
export function CreateProjectForm({
  onCreated,
  onCancel,
  autoFocus = false,
  idPrefix = "project",
  className,
}: {
  onCreated: (projectId: string) => void | Promise<void>;
  onCancel?: () => void;
  autoFocus?: boolean;
  /** Field ids must be unique when two forms are on one page. */
  idPrefix?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || creating) return;

    try {
      setCreating(true);
      setError(null);
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          description: description.trim(),
          instructions: instructions.trim(),
          memoryMode: "isolated",
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !payload?.id) {
        throw new Error(payload?.error || t("projects.errors.create"));
      }
      setName("");
      setDescription("");
      setInstructions("");
      await onCreated(payload.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("projects.errors.create"));
    } finally {
      setCreating(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className={cn("space-y-4", className)}>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-name`}>{t("projects.projectName")}</Label>
        <Input
          id={`${idPrefix}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("projects.projectNamePlaceholder")}
          autoFocus={autoFocus}
          autoComplete="off"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-desc`}>{t("projects.descriptionLabel")}</Label>
        <Input
          id={`${idPrefix}-desc`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("projects.descriptionPlaceholder")}
          autoComplete="off"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-instructions`}>{t("projects.instructions")}</Label>
        <Textarea
          id={`${idPrefix}-instructions`}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={t("projects.instructionsPlaceholder")}
          className="min-h-24"
        />
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={!name.trim() || creating} className="gap-2">
          {creating ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              {t("common.creating")}
            </>
          ) : (
            t("projects.createTitle")
          )}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("common.close")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
