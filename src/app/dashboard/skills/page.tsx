"use client";

import { useEffect, useMemo, useState } from "react";
import { BookText, Loader2, PackagePlus, Puzzle } from "lucide-react";
import { SettingsScopeSelect, useSettingsScope } from "@/components/settings-scope";
import { SettingsPageHeader, SettingsShell } from "@/components/settings-shell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SkeletonList } from "@/components/ui/skeleton-list";
import { useI18n } from "@/i18n/provider";

interface BundledSkillItem {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  installed: boolean;
}

interface InstalledSkillItem {
  name: string;
  description: string;
  content: string;
  license?: string;
  compatibility?: string;
}

type RawSkill = Record<string, unknown>;

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function loadBundledSkills(scopeId: string): Promise<BundledSkillItem[]> {
  const res = await fetch(`/api/skills?projectId=${encodeURIComponent(scopeId)}`);
  if (!res.ok) return [];
  const data: unknown = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map((item: RawSkill) => ({
    name: optionalText(item.name) ?? "unknown",
    description: optionalText(item.description) ?? "",
    license: optionalText(item.license),
    compatibility: optionalText(item.compatibility),
    installed: Boolean(item.installed),
  }));
}

async function loadInstalledSkills(scopeId: string): Promise<InstalledSkillItem[]> {
  const res = await fetch(`/api/projects/${encodeURIComponent(scopeId)}/skills`);
  if (!res.ok) return [];
  const data: unknown = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map((item: RawSkill) => ({
    name: optionalText(item.name) ?? "unknown",
    description: optionalText(item.description) ?? "",
    content: optionalText(item.content) ?? "",
    license: optionalText(item.license),
    compatibility: optionalText(item.compatibility),
  }));
}

export default function SkillsPage() {
  const { t } = useI18n();
  const scope = useSettingsScope();
  const { scopeId } = scope;
  const [bundledSkills, setBundledSkills] = useState<BundledSkillItem[]>([]);
  const [installedSkills, setInstalledSkills] = useState<InstalledSkillItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);
  const [installingSkill, setInstallingSkill] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<InstalledSkillItem | null>(null);
  const [isSkillSheetOpen, setIsSkillSheetOpen] = useState(false);

  useEffect(() => {
    // Answers can arrive out of order when the switcher moves quickly, and
    // only the scope still selected may fill the page.
    let current = true;
    setLoading(true);
    Promise.all([loadBundledSkills(scopeId), loadInstalledSkills(scopeId)])
      .then(([bundled, installed]) => {
        if (!current) return;
        setBundledSkills(bundled);
        setInstalledSkills(installed);
      })
      .catch(() => {
        if (!current) return;
        setBundledSkills([]);
        setInstalledSkills([]);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [scopeId, reloadTick]);

  useEffect(() => {
    setStatusMessage(null);
  }, [scopeId]);

  async function handleInstall(skillName: string) {
    setStatusMessage(null);
    setInstallingSkill(skillName);

    try {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: scopeId, skillName }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setStatusMessage(typeof payload?.error === "string" ? payload.error : t("skills.errors.install"));
        return;
      }
      setReloadTick((tick) => tick + 1);
      setStatusMessage(t("skills.installedMessage", { skill: skillName, project: scope.scopeName }));
    } catch {
      setStatusMessage(t("skills.errors.install"));
    } finally {
      setInstallingSkill(null);
    }
  }

  const filteredBundledSkills = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return bundledSkills;
    return bundledSkills.filter((skill) => `${skill.name}\n${skill.description}`.toLowerCase().includes(query));
  }, [bundledSkills, search]);

  const filteredInstalledSkills = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return installedSkills;
    return installedSkills.filter((skill) => `${skill.name}\n${skill.description}`.toLowerCase().includes(query));
  }, [installedSkills, search]);

  function handleOpenSkill(skill: InstalledSkillItem) {
    setSelectedSkill(skill);
    setIsSkillSheetOpen(true);
  }

  return (
    <SettingsShell title={t("skills.title")}>
      <SettingsPageHeader
        title={t("skills.title")}
        description={t("skills.description", { path: "skills/" })}
        scope={<SettingsScopeSelect scope={scope} />}
      />

      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={t("skills.searchPlaceholder")}
        aria-label={t("skills.searchPlaceholder")}
        className="sm:max-w-sm"
      />

      {statusMessage ? (
        <Alert>
          <AlertDescription>{statusMessage}</AlertDescription>
        </Alert>
      ) : null}

      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <BookText className="size-4 text-primary" />
            <h3 className="text-sm font-medium">{t("skills.installedInWorkspace")}</h3>
          </div>
          {!loading ? (
            <span className="text-xs text-muted-foreground">
              {t("skills.total", { count: installedSkills.length })}
            </span>
          ) : null}
        </div>
        {loading ? (
          <SkeletonList rows={3} className="p-4" />
        ) : filteredInstalledSkills.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon"><BookText /></EmptyMedia>
              <EmptyTitle>{t("skills.noInstalledTitle")}</EmptyTitle>
              <EmptyDescription>{t("skills.noInstalledDescription")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="divide-y">
            {filteredInstalledSkills.map((skill) => (
              <button
                key={skill.name}
                type="button"
                className="flex w-full items-start gap-3 p-3 text-left transition-colors hover:bg-muted/40"
                onClick={() => handleOpenSkill(skill)}
              >
                <div className="mt-0.5 shrink-0 rounded bg-primary/10 p-2">
                  <BookText className="size-4 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{skill.name}</p>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {skill.description || t("skills.noDescription")}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {skill.license ? (
                      <Badge variant="outline">{t("skills.license", { license: skill.license })}</Badge>
                    ) : null}
                    {skill.compatibility ? (
                      <Badge variant="outline">{t("skills.compatibility", { compatibility: skill.compatibility })}</Badge>
                    ) : null}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-1">
        <h3 className="text-lg font-medium">{t("skills.catalogTitle")}</h3>
        <p className="text-sm text-muted-foreground">
          {t("skills.catalogDescription", { path: "skills/" })}
        </p>
      </div>
      {loading ? (
        <SkeletonList rows={4} className="p-4" />
      ) : filteredBundledSkills.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Puzzle /></EmptyMedia>
            <EmptyTitle>{t("skills.noBundledTitle")}</EmptyTitle>
            <EmptyDescription>{t("skills.noBundledDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-3">
          {filteredBundledSkills.map((skill) => (
            <div
              key={skill.name}
              className="flex items-start justify-between gap-4 rounded-lg border bg-card p-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Puzzle className="size-4 text-primary" />
                  <h3 className="truncate font-medium">{skill.name}</h3>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {skill.description || t("skills.noDescription")}
                </p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {skill.license ? (
                    <Badge variant="outline">{t("skills.license", { license: skill.license })}</Badge>
                  ) : null}
                  {skill.compatibility ? (
                    <Badge variant="outline">{t("skills.compatibility", { compatibility: skill.compatibility })}</Badge>
                  ) : null}
                </div>
              </div>

              <Button
                onClick={() => handleInstall(skill.name)}
                disabled={skill.installed || installingSkill === skill.name}
                variant={skill.installed ? "secondary" : "default"}
                className="shrink-0 gap-2"
              >
                {installingSkill === skill.name ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t("skills.installing")}
                  </>
                ) : skill.installed ? (
                  t("skills.installed")
                ) : (
                  <>
                    <PackagePlus className="size-4" />
                    {t("skills.install")}
                  </>
                )}
              </Button>
            </div>
          ))}
        </div>
      )}

      <Sheet open={isSkillSheetOpen} onOpenChange={setIsSkillSheetOpen}>
        <SheetContent side="right" className="flex w-full flex-col sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle className="truncate pr-8">
              {t("skills.sheetTitle", { name: selectedSkill?.name ?? "" })}
            </SheetTitle>
            <SheetDescription>
              {selectedSkill?.description || t("skills.instructions")}
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-4 pb-4">
            <pre className="whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 font-mono text-sm">
              {selectedSkill?.content || t("skills.noContent")}
            </pre>
          </div>
        </SheetContent>
      </Sheet>
    </SettingsShell>
  );
}
