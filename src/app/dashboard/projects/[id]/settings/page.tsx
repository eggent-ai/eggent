"use client";

import { useParams } from "next/navigation";
import { ProjectFileEditor } from "@/components/project-file-editor";
import { ProjectPageShell } from "@/components/project-page-shell";

const INHERIT_EXAMPLE = `{
  "inheritsGlobal": true
}`;

const OVERRIDE_EXAMPLE = `{
  "inheritsGlobal": false,
  "provider": "openai",
  "model": "gpt-4.1"
}`;

export default function ProjectSettingsPage() {
  const { id } = useParams();
  const projectId = id as string;
  return (
    <ProjectPageShell projectId={projectId} title="Project Model Settings" description="Edit model.json for this project agent.">
      <div className="rounded-xl border bg-card p-4 md:p-5 space-y-3">
        <div>
          <h2 className="text-xl font-semibold">How project model override works</h2>
          <p className="text-sm text-muted-foreground">
            By default a project inherits the global model from Settings. To pin this project to a specific model,
            set <span className="font-mono">inheritsGlobal</span> to <span className="font-mono">false</span> and provide
            the exact <span className="font-mono">provider</span> and <span className="font-mono">model</span> id.
            Credentials still come from Eggent model settings, so add API keys or OAuth in global Settings first.
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="mb-2 text-xs font-medium text-muted-foreground">Inherit global model</div>
            <pre className="overflow-x-auto text-xs font-mono whitespace-pre-wrap">{INHERIT_EXAMPLE}</pre>
          </div>
          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="mb-2 text-xs font-medium text-muted-foreground">Override for this project</div>
            <pre className="overflow-x-auto text-xs font-mono whitespace-pre-wrap">{OVERRIDE_EXAMPLE}</pre>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Common providers: <span className="font-mono">openai</span>, <span className="font-mono">anthropic</span>,
          <span className="font-mono"> google</span>, <span className="font-mono">openrouter</span>,
          <span className="font-mono"> codex-cli</span>, <span className="font-mono">gemini-cli</span>.
          Use model ids exactly as shown in Settings → Models.
        </p>
      </div>

      <ProjectFileEditor
        projectId={projectId}
        endpoint="model"
        filename="model.json"
        title="model.json"
        description="Edit raw JSON. Use inheritsGlobal=true, or set inheritsGlobal=false with provider/model to override this project."
        rows={16}
      />
    </ProjectPageShell>
  );
}
