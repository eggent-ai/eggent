"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SettingsNavigation } from "@/components/settings-navigation";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Check,
  FolderOpen,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAppStore } from "@/store/app-store";
import { useI18n } from "@/i18n/provider";

type OnboardingStep = -1 | 0;

interface AuthStatusResponse {
  authenticated: boolean;
  username: string | null;
  mustChangeCredentials: boolean;
}

function ProjectsLoadingFallback() {
  const { t } = useI18n();
  return <div className="p-4 text-sm text-muted-foreground">{t("common.loading")}</div>;
}

function OnboardingStepIndicator({
  step,
  currentStep,
  label,
}: {
  step: 0;
  currentStep: OnboardingStep;
  label: string;
}) {
  const completed = currentStep > step;
  const active = currentStep === step;

  return (
    <div className="flex items-center gap-2">
      <div
        className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
          completed
            ? "bg-emerald-500 text-white"
            : active
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground"
        }`}
      >
        {completed ? <Check className="size-3.5" /> : step}
      </div>
      <span
        className={`text-xs ${
          active ? "text-foreground font-medium" : "text-muted-foreground"
        }`}
      >
        {label}
      </span>
    </div>
  );
}

function ProjectsPageClient() {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { projects, setProjects, setActiveProjectId } = useAppStore();

  const isOnboardingQuery = searchParams.get("onboarding") === "1";
  const shouldOpenCreate = searchParams.get("create") === "1";

  const [projectsLoading, setProjectsLoading] = useState(true);
  const [authStatusLoading, setAuthStatusLoading] = useState(true);
  const [mustChangeCredentials, setMustChangeCredentials] = useState(false);
  const [credentialUsername, setCredentialUsername] = useState("");
  const [credentialPassword, setCredentialPassword] = useState("");
  const [credentialPasswordConfirm, setCredentialPasswordConfirm] = useState("");
  const [credentialsSaving, setCredentialsSaving] = useState(false);
  const [credentialsError, setCredentialsError] = useState<string | null>(null);
  const [credentialsStatus, setCredentialsStatus] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newInstructions, setNewInstructions] = useState("");

  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>(-1);
  const forceCreateVisible = false;
  const isCreateOpen = showCreate;

  const loadProjects = useCallback(async () => {
    try {
      setProjectsLoading(true);
      const res = await fetch("/api/projects");
      const data = await res.json();
      if (Array.isArray(data)) {
        setProjects(data);
      } else {
        setProjects([]);
      }
    } catch {
      setProjects([]);
    } finally {
      setProjectsLoading(false);
    }
  }, [setProjects]);

  const loadAuthStatus = useCallback(async () => {
    try {
      setAuthStatusLoading(true);
      const res = await fetch("/api/auth/status", { cache: "no-store" });
      const data = (await res.json()) as Partial<AuthStatusResponse>;
      if (!res.ok) {
        throw new Error(t("projects.errors.loadAuth"));
      }

      const currentUsername =
        typeof data.username === "string" ? data.username : "";
      if (currentUsername) {
        setCredentialUsername(currentUsername);
      }
      setMustChangeCredentials(Boolean(data.mustChangeCredentials));
    } catch {
      setMustChangeCredentials(false);
    } finally {
      setAuthStatusLoading(false);
    }
  }, []);


  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    void loadAuthStatus();
  }, [loadAuthStatus]);

  useEffect(() => {
    if (forceCreateVisible) {
      setShowCreate(true);
      return;
    }
    if (shouldOpenCreate) {
      setShowCreate(true);
    }
  }, [forceCreateVisible, shouldOpenCreate]);

  useEffect(() => {
    if (onboardingStep === 0) {
      setShowCreate(false);
    }
  }, [onboardingStep]);

  useEffect(() => {
    if (authStatusLoading || projectsLoading) return;

    if (mustChangeCredentials) {
      if (onboardingStep !== 0) {
        setOnboardingStep(0);
      }
      return;
    }

    if (isOnboardingQuery) {
      router.replace("/dashboard/settings");
      return;
    }

    if (onboardingStep !== -1) {
      setOnboardingStep(-1);
    }
  }, [
    authStatusLoading,
    projectsLoading,
    mustChangeCredentials,
    onboardingStep,
    isOnboardingQuery,
    router,
  ]);

  async function handleCreate() {
    const trimmedName = newName.trim();
    if (!trimmedName) return;

    try {
      setCreatingProject(true);
      setCreateError(null);

      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          description: newDescription.trim(),
          instructions: newInstructions.trim(),
          memoryMode: "isolated",
        }),
      });

      const payload = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !payload?.id) {
        throw new Error(payload?.error || t("projects.errors.create"));
      }

      setNewName("");
      setNewDescription("");
      setNewInstructions("");
      setActiveProjectId(payload.id);
      setShowCreate(false);

      await loadProjects();
    } catch (error) {
      setCreateError(
        error instanceof Error ? error.message : t("projects.errors.create")
      );
    } finally {
      setCreatingProject(false);
    }
  }

  async function handleUpdateCredentials() {
    const username = credentialUsername.trim();
    const password = credentialPassword.trim();
    const passwordConfirm = credentialPasswordConfirm.trim();

    if (!username) {
      setCredentialsError(t("projects.errors.usernameRequired"));
      return;
    }
    if (password.length < 8) {
      setCredentialsError(t("projects.errors.passwordMin"));
      return;
    }
    if (password !== passwordConfirm) {
      setCredentialsError(t("projects.errors.passwordMismatch"));
      return;
    }

    try {
      setCredentialsSaving(true);
      setCredentialsError(null);
      setCredentialsStatus(null);

      const res = await fetch("/api/auth/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      const payload = (await res.json().catch(() => null)) as
        | { error?: string; success?: boolean }
        | null;
      if (!res.ok) {
        throw new Error(payload?.error || t("projects.errors.updateCredentials"));
      }

      setMustChangeCredentials(false);
      setCredentialsStatus(t("projects.credentialsUpdated"));
      setCredentialPassword("");
      setCredentialPasswordConfirm("");

      setOnboardingStep(-1);
      router.push("/dashboard/settings");
      router.refresh();
    } catch (error) {
      setCredentialsError(
        error instanceof Error ? error.message : t("projects.errors.updateCredentials")
      );
    } finally {
      setCredentialsSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t("projects.deleteConfirm"))) return;
    await fetch(`/api/projects/${id}`, { method: "DELETE" });
    await loadProjects();
  }

  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title={t("projects.title")} />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="flex flex-1 flex-col gap-4 p-4 md:p-6 max-w-5xl mx-auto w-full">
              <SettingsNavigation />

              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-semibold">{t("projects.title")}</h2>
                  <p className="text-sm text-muted-foreground">
                    {t("projects.description")}
                  </p>
                </div>
                <Button
                  onClick={() => {
                    if (forceCreateVisible || onboardingStep === 0) return;
                    setShowCreate(!showCreate);
                  }}
                  className="gap-2"
                  disabled={forceCreateVisible || onboardingStep === 0}
                >
                  {showCreate ? (
                    <>
                      <X className="size-4" />
                      {t("common.cancel")}
                    </>
                  ) : (
                    <>
                      <Plus className="size-4" />
                      {t("projects.new")}
                    </>
                  )}
                </Button>
              </div>

              {onboardingStep >= 0 && (
                <section className="rounded-lg border bg-card p-4 space-y-4">
                  <div className="space-y-2">
                    <h3 className="font-medium">{t("projects.onboarding.title")}</h3>
                    <div className="flex flex-wrap gap-4">
                      <OnboardingStepIndicator
                        step={0}
                        currentStep={onboardingStep}
                        label={t("projects.onboarding.credentials")}
                      />
                      <div className="text-xs text-muted-foreground">{t("projects.onboarding.nextModel")}</div>
                    </div>
                  </div>

                  {onboardingStep === 0 && (
                    <div className="rounded-lg border p-4 space-y-4">
                      <div className="space-y-1">
                        <h4 className="font-medium">{t("projects.onboarding.replaceLogin")}</h4>
                        <p className="text-sm text-muted-foreground">
                          {t("projects.onboarding.replaceLoginDescription")}
                        </p>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="credential-username">{t("projects.username")}</Label>
                        <Input
                          id="credential-username"
                          value={credentialUsername}
                          onChange={(event) => setCredentialUsername(event.target.value)}
                          placeholder="admin"
                          autoComplete="username"
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="credential-password">{t("projects.newPassword")}</Label>
                        <Input
                          id="credential-password"
                          type="password"
                          value={credentialPassword}
                          onChange={(event) => setCredentialPassword(event.target.value)}
                          placeholder={t("projects.passwordMinPlaceholder")}
                          autoComplete="new-password"
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="credential-password-confirm">
                          {t("projects.confirmPassword")}
                        </Label>
                        <Input
                          id="credential-password-confirm"
                          type="password"
                          value={credentialPasswordConfirm}
                          onChange={(event) =>
                            setCredentialPasswordConfirm(event.target.value)
                          }
                          placeholder={t("projects.repeatPasswordPlaceholder")}
                          autoComplete="new-password"
                        />
                      </div>

                      {credentialsError ? (
                        <Alert variant="destructive">
                          <AlertDescription>{credentialsError}</AlertDescription>
                        </Alert>
                      ) : null}
                      {credentialsStatus ? <Badge variant="secondary">{credentialsStatus}</Badge> : null}

                      <div className="flex items-center gap-2">
                        <Button
                          onClick={handleUpdateCredentials}
                          disabled={credentialsSaving || authStatusLoading}
                          className="gap-2"
                        >
                          {credentialsSaving ? (
                            <>
                              <Loader2 className="size-4 animate-spin" />
                              {t("common.saving")}
                            </>
                          ) : (
                            t("projects.saveAndOpenSettings")
                          )}
                        </Button>
                      </div>
                    </div>
                  )}
                </section>
              )}

              {isCreateOpen && (
                <div className="border rounded-lg p-4 bg-card space-y-4">
                  <div className="space-y-1">
                    <h3 className="font-medium">{t("projects.createTitle")}</h3>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="name">{t("projects.projectName")}</Label>
                    <Input
                      id="name"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder={t("projects.projectNamePlaceholder")}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="desc">{t("projects.descriptionLabel")}</Label>
                    <Input
                      id="desc"
                      value={newDescription}
                      onChange={(e) => setNewDescription(e.target.value)}
                      placeholder={t("projects.descriptionPlaceholder")}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="instructions">{t("projects.instructions")}</Label>
                    <Textarea
                      id="instructions"
                      value={newInstructions}
                      onChange={(e) => setNewInstructions(e.target.value)}
                      placeholder={t("projects.instructionsPlaceholder")}
                      className="min-h-24"
                    />
                  </div>

                  {createError ? (
                    <Alert variant="destructive">
                      <AlertDescription>{createError}</AlertDescription>
                    </Alert>
                  ) : null}

                  <div className="flex items-center gap-2">
                    <Button
                      onClick={handleCreate}
                      disabled={!newName.trim() || creatingProject}
                      className="gap-2"
                    >
                      {creatingProject ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          {t("common.creating")}
                        </>
                      ) : (
                        t("projects.createTitle")
                      )}
                    </Button>
                    {!forceCreateVisible && (
                      <Button variant="ghost" onClick={() => setShowCreate(false)}>
                        {t("common.close")}
                      </Button>
                    )}
                  </div>
                </div>
              )}

              <div className="space-y-3">
                {!projectsLoading && projects.length === 0 && (
                  <Empty className="border">
                    <EmptyHeader>
                      <EmptyMedia variant="icon"><FolderOpen /></EmptyMedia>
                      <EmptyTitle>{t("projects.noProjectsTitle")}</EmptyTitle>
                      <EmptyDescription>{t("projects.noProjectsDescription")}</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}

                {projects.map((project) => (
                  <div
                    key={project.id}
                    className="border rounded-lg p-4 bg-card hover:shadow-sm transition-shadow cursor-pointer"
                    onClick={() => router.push(`/dashboard/projects/${project.id}`)}
                  >
                    <div className="flex items-start justify-between">
                      <div className="space-y-1 flex-1">
                        <div className="flex items-center gap-2">
                          <FolderOpen className="size-5 text-primary" />
                          <h3 className="font-semibold">{project.name}</h3>
                        </div>
                        {project.description && (
                          <p className="text-sm text-muted-foreground">
                            {project.description}
                          </p>
                        )}
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          {["context.md", "memory.md", "skills/", ".mcp.json", "model.json"].map((file) => (
                            <Badge key={file} variant="outline" className="font-mono">{file}</Badge>
                          ))}
                          <span>
                            {t("common.created", { date: new Date(project.createdAt).toLocaleDateString() })}
                          </span>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDelete(project.id);
                        }}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
    </div>
  );
}

export default function ProjectsPage() {
  return (
    <Suspense fallback={<ProjectsLoadingFallback />}>
      <ProjectsPageClient />
    </Suspense>
  );
}
