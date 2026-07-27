"use client";

import { useParams } from "next/navigation";
import { ProjectFileEditor } from "@/components/project-file-editor";
import { ProjectPageShell } from "@/components/project-page-shell";
import { useI18n } from "@/i18n/provider";

const INHERIT_EXAMPLE = `{
  "inheritsGlobal": true
}`;

const OVERRIDE_EXAMPLE = `{
  "inheritsGlobal": false,
  "provider": "openai",
  "model": "gpt-4.1"
}`;

export default function ProjectSettingsPage() {
  const { t } = useI18n();
  const { id } = useParams();
  const projectId = id as string;
  return (
    <ProjectPageShell projectId={projectId} title={t("projectSub.settings.title")} description={t("projectSub.settings.description")}>
      <div className="rounded-xl border bg-card p-4 md:p-5 space-y-3">
        <div>
          <h2 className="text-xl font-semibold">{t("projectSub.settings.howTitle")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("projectSub.settings.howDescription")}
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="mb-2 text-xs font-medium text-muted-foreground">{t("projectSub.settings.inherit")}</div>
            <pre className="overflow-x-auto text-xs font-mono whitespace-pre-wrap">{INHERIT_EXAMPLE}</pre>
          </div>
          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="mb-2 text-xs font-medium text-muted-foreground">{t("projectSub.settings.override")}</div>
            <pre className="overflow-x-auto text-xs font-mono whitespace-pre-wrap">{OVERRIDE_EXAMPLE}</pre>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          {t("projectSub.settings.providers")}
        </p>
      </div>

      <ProjectFileEditor
        projectId={projectId}
        endpoint="model"
        filename="model.json"
        title="model.json"
        description={t("projectSub.settings.editorDescription")}
        rows={16}
      />
    </ProjectPageShell>
  );
}
