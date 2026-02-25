"use client";

import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Brain, Search, Trash2 } from "lucide-react";
import { KnowledgeSection } from "@/components/knowledge-section";

interface MemoryItem {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  score?: number;
}

interface ProjectOption {
  id: string;
  name: string;
}

export default function MemoryPage() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [subdir, setSubdir] = useState("main");
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);

  useEffect(() => {
    loadMemories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subdir]);

  useEffect(() => {
    loadProjects();
  }, []);

  async function loadProjects() {
    try {
      setIsLoadingProjects(true);
      const res = await fetch("/api/projects");
      const data = await res.json();
      if (Array.isArray(data)) {
        const mapped: ProjectOption[] = data.map((p) => ({
          id: p.id,
          name: typeof p.name === "string" && p.name.trim() ? p.name : p.id,
        }));
        setProjects(mapped);
      }
    } catch {
      setProjects([]);
    } finally {
      setIsLoadingProjects(false);
    }
  }

  async function loadMemories() {
    try {
      const res = await fetch(`/api/memory?subdir=${subdir}`);
      const data = await res.json();
      if (Array.isArray(data)) setMemories(data);
    } catch {
      setMemories([]);
    }
  }

  async function handleSearch() {
    if (!searchQuery.trim()) {
      loadMemories();
      return;
    }
    setIsSearching(true);
    try {
      const res = await fetch(
        `/api/memory?query=${encodeURIComponent(searchQuery)}&subdir=${subdir}&limit=20`
      );
      const data = await res.json();
      if (Array.isArray(data)) setMemories(data);
    } catch {
      // ignore
    }
    setIsSearching(false);
  }

  async function handleDelete(id: string) {
    await fetch(`/api/memory?id=${id}&subdir=${subdir}`, {
      method: "DELETE",
    });
    loadMemories();
  }

  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title="Memory Dashboard" />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="flex flex-1 flex-col gap-4 p-4 md:p-6 max-w-4xl mx-auto w-full">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-2xl font-semibold">Memory Dashboard</h2>
                  <p className="text-sm text-muted-foreground">
                    Browse and search the agent&apos;s persistent vector memory.
                  </p>
                </div>
                <select
                  value={subdir}
                  onChange={(e) => setSubdir(e.target.value)}
                  className="rounded-md border bg-background px-3 py-2 text-sm max-w-xs"
                >
                  {isLoadingProjects && (
                    <option disabled>Loading projects...</option>
                  )}
                  {!isLoadingProjects &&
                    projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        Project: {project.name} ({project.id})
                      </option>
                    ))}
                </select>
              </div>

              {/* Controls */}
              <div className="flex items-center gap-3">
                {subdir === "main" || subdir === "projects" ? (
                  <div className="flex-1 flex gap-2">
                    <Input
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search memories..."
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSearch();
                      }}
                    />
                    <Button
                      onClick={handleSearch}
                      disabled={isSearching}
                      variant="secondary"
                      className="gap-2"
                    >
                      <Search className="size-4" />
                      Search
                    </Button>
                  </div>
                ) : (
                  <div className="flex-1" />
                )}
              </div>

              {/* Memory content */}
              {subdir === "main" || subdir === "projects" ? (
                <div className="space-y-2">
                  {memories.length === 0 && (
                    <div className="text-center py-12 text-muted-foreground">
                      <Brain className="size-12 mx-auto mb-4 opacity-50" />
                      <p>No memories found.</p>
                      <p className="text-xs mt-1">
                        The agent will save memories as it learns from conversations.
                      </p>
                    </div>
                  )}
                  {memories.map((mem) => (
                    <div
                      key={mem.id}
                      className="border rounded-lg p-3 bg-card group"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm whitespace-pre-wrap">
                            {mem.text}
                          </p>
                          <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                            {mem.metadata?.area ? (
                              <span className="bg-muted px-1.5 py-0.5 rounded">
                                {String(mem.metadata.area)}
                              </span>
                            ) : null}
                            {mem.score !== undefined && (
                              <span>
                                Score: {(mem.score * 100).toFixed(1)}%
                              </span>
                            )}
                            {mem.metadata?.createdAt ? (
                              <span>
                                {new Date(
                                  String(mem.metadata.createdAt)
                                ).toLocaleDateString()}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(mem.id)}
                          className="opacity-0 group-hover:opacity-100 shrink-0 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <KnowledgeSection projectId={subdir} />
              )}
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  );
}
