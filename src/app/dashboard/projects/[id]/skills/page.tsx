"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { BookText, Loader2, PackagePlus } from "lucide-react";
import { ProjectPageShell } from "@/components/project-page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface SkillItem {
  name: string;
  description: string;
  content?: string;
  installed?: boolean;
}

export default function ProjectSkillsPage() {
  const { id } = useParams();
  const projectId = id as string;
  const [installed, setInstalled] = useState<SkillItem[]>([]);
  const [bundled, setBundled] = useState<SkillItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [selected, setSelected] = useState<SkillItem | null>(null);

  async function load() {
    setLoading(true);
    const [installedRes, bundledRes] = await Promise.all([
      fetch(`/api/projects/${projectId}/skills`, { cache: "no-store" }),
      fetch(`/api/skills?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" }),
    ]);
    const [installedJson, bundledJson] = await Promise.all([installedRes.json(), bundledRes.json()]);
    setInstalled(Array.isArray(installedJson) ? installedJson : []);
    setBundled(Array.isArray(bundledJson) ? bundledJson : []);
    setLoading(false);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function install(skillName: string) {
    setInstalling(skillName);
    setStatus(null);
    const res = await fetch("/api/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, skillName }),
    });
    const json = await res.json().catch(() => null);
    setInstalling(null);
    if (!res.ok) {
      setStatus(json?.error || "Failed to install skill");
      return;
    }
    setStatus(`Installed ${skillName}.`);
    await load();
  }

  const filteredBundled = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return bundled;
    return bundled.filter((skill) => `${skill.name}\n${skill.description}`.toLowerCase().includes(q));
  }, [bundled, search]);

  return (
    <ProjectPageShell projectId={projectId} title="Project Skills" description="Manage the project's skills/ directory. Each skill is available when this project runs.">
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <section className="rounded-xl border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-mono text-muted-foreground">skills/</div>
              <h2 className="font-semibold">Installed skills</h2>
            </div>
            <span className="text-xs text-muted-foreground">{installed.length} total</span>
          </div>
          {loading ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading...</div> : null}
          {!loading && installed.length === 0 ? <p className="text-sm text-muted-foreground">No skills installed.</p> : null}
          <div className="divide-y rounded-lg border">
            {installed.map((skill) => (
              <button key={skill.name} className="flex w-full items-start gap-3 p-3 text-left hover:bg-muted/50" onClick={() => setSelected(skill)}>
                <BookText className="mt-0.5 size-4 text-primary" />
                <div className="min-w-0">
                  <div className="font-medium">{skill.name}</div>
                  <div className="line-clamp-2 text-xs text-muted-foreground">{skill.description || "No description"}</div>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-xl border bg-card p-4 space-y-3">
          <div>
            <div className="text-xs font-mono text-muted-foreground">bundled-skills/</div>
            <h2 className="font-semibold">Install bundled skill</h2>
          </div>
          <Input placeholder="Search skills..." value={search} onChange={(event) => setSearch(event.target.value)} />
          {status ? <div className="rounded-md border bg-muted px-3 py-2 text-sm">{status}</div> : null}
          <div className="max-h-[520px] divide-y overflow-auto rounded-lg border">
            {filteredBundled.map((skill) => (
              <div key={skill.name} className="flex items-start justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="font-medium">{skill.name}</div>
                  <div className="line-clamp-2 text-xs text-muted-foreground">{skill.description || "No description"}</div>
                </div>
                <Button size="sm" variant={skill.installed ? "outline" : "default"} disabled={skill.installed || installing === skill.name} onClick={() => install(skill.name)} className="gap-2">
                  {installing === skill.name ? <Loader2 className="size-4 animate-spin" /> : <PackagePlus className="size-4" />}
                  {skill.installed ? "Installed" : "Install"}
                </Button>
              </div>
            ))}
          </div>
        </section>
      </div>

      {selected ? (
        <section className="rounded-xl border bg-card p-4 space-y-3">
          <h2 className="font-semibold">{selected.name}/SKILL.md</h2>
          <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-3 text-sm font-mono">{selected.content || "No content."}</pre>
        </section>
      ) : null}
    </ProjectPageShell>
  );
}
