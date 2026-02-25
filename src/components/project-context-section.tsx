"use client";

import { useEffect, useState } from "react";
import { BookText, Loader2, Puzzle, Wrench } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

interface ProjectSkillItem {
  name: string;
  description: string;
  content: string;
  license?: string;
  compatibility?: string;
}

interface ProjectContextSectionProps {
  projectId: string;
}

export function ProjectContextSection({ projectId }: ProjectContextSectionProps) {
  const [mcpContent, setMcpContent] = useState<string | null>(null);
  const [mcpLoading, setMcpLoading] = useState(true);

  const [skills, setSkills] = useState<ProjectSkillItem[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);

  const [selectedSkill, setSelectedSkill] = useState<ProjectSkillItem | null>(null);
  const [skillSheetOpen, setSkillSheetOpen] = useState(false);

  useEffect(() => {
    async function loadContext() {
      setMcpLoading(true);
      setSkillsLoading(true);

      try {
        const [mcpRes, skillsRes] = await Promise.all([
          fetch(`/api/projects/${projectId}/mcp`),
          fetch(`/api/projects/${projectId}/skills`),
        ]);

        if (mcpRes.ok) {
          const mcpData = await mcpRes.json();
          setMcpContent(typeof mcpData.content === "string" ? mcpData.content : null);
        } else {
          setMcpContent(null);
        }

        if (skillsRes.ok) {
          const skillsData = await skillsRes.json();
          if (Array.isArray(skillsData)) {
            setSkills(
              skillsData.map((skill) => ({
                name: typeof skill.name === "string" ? skill.name : "unknown-skill",
                description: typeof skill.description === "string" ? skill.description : "",
                content: typeof skill.content === "string" ? skill.content : "",
                license: typeof skill.license === "string" ? skill.license : undefined,
                compatibility:
                  typeof skill.compatibility === "string"
                    ? skill.compatibility
                    : undefined,
              }))
            );
          } else {
            setSkills([]);
          }
        } else {
          setSkills([]);
        }
      } catch {
        setMcpContent(null);
        setSkills([]);
      } finally {
        setMcpLoading(false);
        setSkillsLoading(false);
      }
    }

    loadContext();
  }, [projectId]);

  function handleOpenSkill(skill: ProjectSkillItem) {
    setSelectedSkill(skill);
    setSkillSheetOpen(true);
  }

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="border rounded-lg bg-card">
          <div className="flex items-center justify-between px-4 py-3 border-b">
            <div className="flex items-center gap-2">
              <Wrench className="size-4 text-primary" />
              <h4 className="text-sm font-medium">MCP Servers</h4>
            </div>
          </div>

          {mcpLoading ? (
            <div className="p-8 text-center text-muted-foreground flex items-center justify-center gap-2">
              <Loader2 className="size-4 animate-spin" />
              Loading MCP config...
            </div>
          ) : !mcpContent ? (
            <div className="p-4 text-sm text-muted-foreground">
              No `servers.json` found for this project.
            </div>
          ) : (
            <div className="p-4">
              <pre className="max-h-[360px] overflow-auto rounded-lg border bg-muted/30 p-3 text-xs font-mono whitespace-pre-wrap break-words">
                {mcpContent}
              </pre>
            </div>
          )}
        </div>

        <div className="border rounded-lg bg-card">
          <div className="flex items-center justify-between px-4 py-3 border-b">
            <div className="flex items-center gap-2">
              <Puzzle className="size-4 text-primary" />
              <h4 className="text-sm font-medium">Project Skills</h4>
            </div>
            {!skillsLoading && (
              <span className="text-xs text-muted-foreground">
                {skills.length} total
              </span>
            )}
          </div>

          {skillsLoading ? (
            <div className="p-8 text-center text-muted-foreground flex items-center justify-center gap-2">
              <Loader2 className="size-4 animate-spin" />
              Loading skills...
            </div>
          ) : skills.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No skills configured for this project yet.
            </div>
          ) : (
            <div className="divide-y">
              {skills.map((skill) => (
                <button
                  key={skill.name}
                  type="button"
                  className="w-full p-3 flex items-start gap-3 hover:bg-muted/50 transition-colors text-left"
                  onClick={() => handleOpenSkill(skill)}
                >
                  <div className="bg-primary/10 p-2 rounded shrink-0 mt-0.5">
                    <BookText className="size-4 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm truncate">{skill.name}</p>
                    <p className="text-xs text-muted-foreground line-clamp-2 mt-1">
                      {skill.description || "No description"}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <Sheet open={skillSheetOpen} onOpenChange={setSkillSheetOpen}>
        <SheetContent side="right" className="w-full sm:max-w-2xl flex flex-col">
          <SheetHeader>
            <SheetTitle className="truncate pr-8">
              Skill: {selectedSkill?.name ?? ""}
            </SheetTitle>
            <SheetDescription>
              {selectedSkill?.description || "Skill instructions"}
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-4 pb-4">
            <pre className="rounded-lg border bg-muted/30 p-3 text-sm font-mono whitespace-pre-wrap break-words">
              {selectedSkill?.content || "No skill content."}
            </pre>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
