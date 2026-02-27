"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TelegramIntegrationManager } from "@/components/telegram-integration-manager";
import { ChatModelWizard, UtilityModelWizard, MultimediaModelWizard, EmbeddingsModelWizard } from "@/components/settings/model-wizards";
import type { AppSettings } from "@/lib/types";
import { updateSettingsByPath } from "@/lib/settings/update-settings-path";
import {
  AlertTriangle,
  Check,
  FolderOpen,
  Loader2,
  Plus,
  Puzzle,
  Trash2,
  X,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAppStore } from "@/store/app-store";

type OnboardingStep = -1 | 0 | 1 | 2 | 3 | 4;

interface BundledSkillItem {
  name: string;
  description: string;
  installed: boolean;
  license?: string;
  compatibility?: string;
}

interface AuthStatusResponse {
  authenticated: boolean;
  username: string | null;
  mustChangeCredentials: boolean;
}

function OnboardingStepIndicator({
  step,
  currentStep,
  label,
}: {
  step: 0 | 1 | 2 | 3 | 4;
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const { projects, setProjects, setActiveProjectId } = useAppStore();

  const isOnboardingQuery = searchParams.get("onboarding") === "1";
  const shouldOpenCreate = searchParams.get("create") === "1" || isOnboardingQuery;

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
  const [onboardingProjectId, setOnboardingProjectId] = useState("");

  const [settingsDraft, setSettingsDraft] = useState<AppSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const [bundledSkills, setBundledSkills] = useState<BundledSkillItem[]>([]);
  const [bundledSkillsLoading, setBundledSkillsLoading] = useState(false);
  const [installingSkill, setInstallingSkill] = useState<string | null>(null);
  const [skillsStatus, setSkillsStatus] = useState<string | null>(null);

  const forceCreateVisible = projects.length === 0 && onboardingStep !== 0;
  const isCreateOpen = forceCreateVisible || showCreate;
  const onboardingTargetProjectId = useMemo(
    () => onboardingProjectId || projects[0]?.id || "",
    [onboardingProjectId, projects]
  );

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
        throw new Error("Failed to load auth status");
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

  const loadOnboardingSettings = useCallback(async () => {
    try {
      setSettingsLoading(true);
      setSettingsError(null);
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = (await res.json()) as AppSettings;
      if (!res.ok) {
        throw new Error("Failed to load settings");
      }
      setSettingsDraft(data);
    } catch (error) {
      setSettingsError(
        error instanceof Error ? error.message : "Failed to load settings"
      );
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  const loadBundledSkills = useCallback(async (projectId: string) => {
    if (!projectId) {
      setBundledSkills([]);
      return;
    }

    try {
      setBundledSkillsLoading(true);
      setSkillsStatus(null);
      const res = await fetch(
        `/api/skills?projectId=${encodeURIComponent(projectId)}`
      );
      const data = (await res.json()) as unknown;
      if (!res.ok || !Array.isArray(data)) {
        throw new Error("Failed to load skills");
      }

      setBundledSkills(
        data.map((item) => ({
          name: typeof item.name === "string" ? item.name : "unknown",
          description:
            typeof item.description === "string" ? item.description : "",
          installed: Boolean(item.installed),
          license: typeof item.license === "string" ? item.license : undefined,
          compatibility:
            typeof item.compatibility === "string"
              ? item.compatibility
              : undefined,
        }))
      );
    } catch {
      setBundledSkills([]);
      setSkillsStatus("Failed to load bundled skills.");
    } finally {
      setBundledSkillsLoading(false);
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
    if (shouldOpenCreate && onboardingStep === 1) {
      setShowCreate(true);
    }
  }, [forceCreateVisible, shouldOpenCreate, onboardingStep]);

  useEffect(() => {
    if (onboardingStep === 0) {
      setShowCreate(false);
    }
  }, [onboardingStep]);

  useEffect(() => {
    if (!forceCreateVisible && onboardingStep >= 2) {
      setShowCreate(false);
    }
  }, [forceCreateVisible, onboardingStep]);

  useEffect(() => {
    if (authStatusLoading || projectsLoading) return;

    if (mustChangeCredentials) {
      if (onboardingStep !== 0) {
        setOnboardingStep(0);
      }
      return;
    }

    if (projects.length === 0) {
      if (onboardingStep === -1 || onboardingStep === 0) {
        setOnboardingStep(1);
      }
      setOnboardingProjectId("");
      return;
    }

    if (onboardingStep === 1) {
      setOnboardingStep(2);
      return;
    }

    if (onboardingStep === -1 && isOnboardingQuery) {
      setOnboardingStep(2);
    }
  }, [
    authStatusLoading,
    projectsLoading,
    mustChangeCredentials,
    projects.length,
    onboardingStep,
    isOnboardingQuery,
  ]);

  useEffect(() => {
    if (onboardingStep !== 2 || settingsDraft) return;
    void loadOnboardingSettings();
  }, [onboardingStep, settingsDraft, loadOnboardingSettings]);

  useEffect(() => {
    if (onboardingStep !== 4 || !onboardingTargetProjectId) return;
    void loadBundledSkills(onboardingTargetProjectId);
  }, [onboardingStep, onboardingTargetProjectId, loadBundledSkills]);

  async function handleCreate() {
    const trimmedName = newName.trim();
    if (!trimmedName) return;

    const hadNoProjects = projects.length === 0;
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
        throw new Error(payload?.error || "Failed to create project");
      }

      setNewName("");
      setNewDescription("");
      setNewInstructions("");
      setActiveProjectId(payload.id);
      setOnboardingProjectId(payload.id);

      if (hadNoProjects) {
        setOnboardingStep(2);
        setSettingsDraft(null);
        setShowCreate(false);
      } else {
        setShowCreate(false);
      }

      await loadProjects();
    } catch (error) {
      setCreateError(
        error instanceof Error ? error.message : "Failed to create project"
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
      setCredentialsError("Username is required.");
      return;
    }
    if (password.length < 8) {
      setCredentialsError("Password must be at least 8 characters.");
      return;
    }
    if (password !== passwordConfirm) {
      setCredentialsError("Password confirmation does not match.");
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
        throw new Error(payload?.error || "Failed to update credentials");
      }

      setMustChangeCredentials(false);
      setCredentialsStatus("Credentials updated.");
      setCredentialPassword("");
      setCredentialPasswordConfirm("");

      if (projects.length === 0) {
        setOnboardingStep(1);
      } else {
        setOnboardingStep(2);
      }

      const params = new URLSearchParams(searchParams.toString());
      params.delete("credentials");
      const nextQuery = params.toString();
      router.replace(
        nextQuery ? `/dashboard/projects?${nextQuery}` : "/dashboard/projects"
      );
      router.refresh();
    } catch (error) {
      setCredentialsError(
        error instanceof Error ? error.message : "Failed to update credentials"
      );
    } finally {
      setCredentialsSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this project? This cannot be undone.")) return;
    await fetch(`/api/projects/${id}`, { method: "DELETE" });
    await loadProjects();
  }

  async function handleSaveSettingsStep() {
    if (!settingsDraft) return;

    try {
      setSettingsSaving(true);
      setSettingsError(null);

      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settingsDraft),
      });

      const data = (await res.json()) as AppSettings | { error?: string };
      if (!res.ok) {
        throw new Error(
          "error" in data && typeof data.error === "string"
            ? data.error
            : "Failed to save settings"
        );
      }

      setSettingsDraft(data as AppSettings);
      setOnboardingStep(3);
    } catch (error) {
      setSettingsError(
        error instanceof Error ? error.message : "Failed to save settings"
      );
    } finally {
      setSettingsSaving(false);
    }
  }

  async function handleInstallSkill(skillName: string) {
    if (!onboardingTargetProjectId) return;

    try {
      setInstallingSkill(skillName);
      setSkillsStatus(null);

      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: onboardingTargetProjectId,
          skillName,
        }),
      });
      const payload = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(payload.error || "Failed to install skill");
      }

      await loadBundledSkills(onboardingTargetProjectId);
      setSkillsStatus(`Installed "${skillName}"`);
    } catch (error) {
      setSkillsStatus(
        error instanceof Error ? error.message : "Failed to install skill"
      );
    } finally {
      setInstallingSkill(null);
    }
  }

  function finishOnboarding() {
    setOnboardingStep(-1);
    router.push("/dashboard");
  }

  function updateOnboardingSettings(path: string, value: unknown) {
    setSettingsDraft((prev) => {
      if (!prev) return null;
      return updateSettingsByPath(prev, path, value);
    });
  }

  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title="Projects" />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="flex flex-1 flex-col gap-4 p-4 md:p-6 max-w-5xl mx-auto w-full">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-semibold">Projects</h2>
                  <p className="text-sm text-muted-foreground">
                    Manage project workspaces and run onboarding for first setup.
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
                      Cancel
                    </>
                  ) : (
                    <>
                      <Plus className="size-4" />
                      New Project
                    </>
                  )}
                </Button>
              </div>

              {onboardingStep >= 0 && (
                <section className="rounded-lg border bg-card p-4 space-y-4">
                  <div className="space-y-2">
                    <h3 className="font-medium">Project Onboarding</h3>
                    <div className="flex flex-wrap gap-4">
                      <OnboardingStepIndicator
                        step={0}
                        currentStep={onboardingStep}
                        label="Credentials"
                      />
                      <OnboardingStepIndicator
                        step={1}
                        currentStep={onboardingStep}
                        label="Create project"
                      />
                      <OnboardingStepIndicator
                        step={2}
                        currentStep={onboardingStep}
                        label="Model API keys"
                      />
                      <OnboardingStepIndicator
                        step={3}
                        currentStep={onboardingStep}
                        label="Telegram"
                      />
                      <OnboardingStepIndicator
                        step={4}
                        currentStep={onboardingStep}
                        label="Skills"
                      />
                    </div>
                  </div>

                  {onboardingStep === 0 && (
                    <div className="rounded-lg border p-4 space-y-4">
                      <div className="space-y-1">
                        <h4 className="font-medium">Step 0: Replace default login</h4>
                        <p className="text-sm text-muted-foreground">
                          Set a new username and password before continuing.
                        </p>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="credential-username">Username</Label>
                        <Input
                          id="credential-username"
                          value={credentialUsername}
                          onChange={(event) => setCredentialUsername(event.target.value)}
                          placeholder="admin"
                          autoComplete="username"
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="credential-password">New password</Label>
                        <Input
                          id="credential-password"
                          type="password"
                          value={credentialPassword}
                          onChange={(event) => setCredentialPassword(event.target.value)}
                          placeholder="At least 8 characters"
                          autoComplete="new-password"
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="credential-password-confirm">
                          Confirm password
                        </Label>
                        <Input
                          id="credential-password-confirm"
                          type="password"
                          value={credentialPasswordConfirm}
                          onChange={(event) =>
                            setCredentialPasswordConfirm(event.target.value)
                          }
                          placeholder="Repeat password"
                          autoComplete="new-password"
                        />
                      </div>

                      {credentialsError && (
                        <p className="text-sm text-destructive">{credentialsError}</p>
                      )}
                      {credentialsStatus && (
                        <p className="text-sm text-emerald-600">{credentialsStatus}</p>
                      )}

                      <div className="flex items-center gap-2">
                        <Button
                          onClick={handleUpdateCredentials}
                          disabled={credentialsSaving || authStatusLoading}
                          className="gap-2"
                        >
                          {credentialsSaving ? (
                            <>
                              <Loader2 className="size-4 animate-spin" />
                              Saving...
                            </>
                          ) : (
                            "Save and Continue"
                          )}
                        </Button>
                      </div>
                    </div>
                  )}

                  {onboardingStep === 1 && (
                    <div className="rounded-lg border p-4">
                      <p className="text-sm text-muted-foreground">
                        Step 1: Create your first project to continue onboarding.
                      </p>
                    </div>
                  )}

                  {onboardingStep === 2 && (
                    <div className="rounded-lg border p-4 space-y-4">
                      <h4 className="font-medium">Step 2: Model and Vector API Settings</h4>
                      <p className="text-sm text-muted-foreground">
                        Same model setup UI as in Settings, including model loading by API key.
                      </p>

                      {settingsLoading || !settingsDraft ? (
                        <div className="py-8 flex items-center justify-center text-muted-foreground">
                          <Loader2 className="size-4 animate-spin mr-2" />
                          Loading settings...
                        </div>
                      ) : (
                        <>
                          <ChatModelWizard
                            settings={settingsDraft}
                            updateSettings={updateOnboardingSettings}
                          />
                          <UtilityModelWizard
                            settings={settingsDraft}
                            updateSettings={updateOnboardingSettings}
                          />
                          <MultimediaModelWizard
                            settings={settingsDraft}
                            updateSettings={updateOnboardingSettings}
                          />
                          <EmbeddingsModelWizard
                            settings={settingsDraft}
                            updateSettings={updateOnboardingSettings}
                          />

                          {settingsError && (
                            <p className="text-sm text-destructive">{settingsError}</p>
                          )}

                          <div className="flex items-center gap-2">
                            <Button
                              onClick={handleSaveSettingsStep}
                              disabled={settingsSaving}
                              className="gap-2"
                            >
                              {settingsSaving ? (
                                <>
                                  <Loader2 className="size-4 animate-spin" />
                                  Saving...
                                </>
                              ) : (
                                "Save and Continue"
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={() => setOnboardingStep(3)}
                            >
                              Skip
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {onboardingStep === 3 && (
                    <div className="rounded-lg border p-4 space-y-4">
                      <div className="space-y-1">
                        <h4 className="font-medium">Step 3: Connect Telegram</h4>
                        <p className="text-sm text-muted-foreground">
                          Configure bot token and webhook to receive messages in Telegram.
                        </p>
                      </div>

                      <TelegramIntegrationManager />

                      <div className="flex items-center gap-2">
                        <Button variant="outline" onClick={() => setOnboardingStep(2)}>
                          Back
                        </Button>
                        <Button onClick={() => setOnboardingStep(4)}>
                          Continue to Skills
                        </Button>
                      </div>
                    </div>
                  )}

                  {onboardingStep === 4 && (
                    <div className="rounded-lg border p-4 space-y-4">
                      <div className="space-y-1">
                        <h4 className="font-medium">Step 4: Add Skills to Project</h4>
                        <p className="text-sm text-muted-foreground">
                          Install bundled skills into the project to extend agent capabilities.
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Target project:{" "}
                          <span className="font-mono">
                            {onboardingTargetProjectId || "not selected"}
                          </span>
                        </p>
                      </div>

                      {skillsStatus && (
                        <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                          {skillsStatus}
                        </div>
                      )}

                      {bundledSkillsLoading ? (
                        <div className="py-8 flex items-center justify-center text-muted-foreground">
                          <Loader2 className="size-4 animate-spin mr-2" />
                          Loading skills...
                        </div>
                      ) : bundledSkills.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No bundled skills available.
                        </p>
                      ) : (
                        <div className="grid gap-3">
                          {bundledSkills.map((skill) => (
                            <div
                              key={skill.name}
                              className="rounded-lg border p-3 bg-card flex items-start justify-between gap-3"
                            >
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <Puzzle className="size-4 text-primary shrink-0" />
                                  <p className="font-medium truncate">{skill.name}</p>
                                </div>
                                <p className="text-sm text-muted-foreground mt-1">
                                  {skill.description || "No description"}
                                </p>
                              </div>
                              <Button
                                onClick={() => handleInstallSkill(skill.name)}
                                disabled={
                                  !onboardingTargetProjectId ||
                                  skill.installed ||
                                  installingSkill === skill.name
                                }
                                variant={skill.installed ? "secondary" : "default"}
                                className="shrink-0"
                              >
                                {installingSkill === skill.name ? (
                                  <>
                                    <Loader2 className="size-4 animate-spin mr-2" />
                                    Installing
                                  </>
                                ) : skill.installed ? (
                                  "Installed"
                                ) : (
                                  "Install"
                                )}
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="flex items-center gap-2">
                        <Button variant="outline" onClick={() => setOnboardingStep(3)}>
                          Back
                        </Button>
                        <Button onClick={finishOnboarding}>Finish Onboarding</Button>
                      </div>
                    </div>
                  )}
                </section>
              )}

              {isCreateOpen && (
                <div className="border rounded-lg p-4 bg-card space-y-4">
                  <div className="space-y-1">
                    <h3 className="font-medium">
                      {forceCreateVisible
                        ? "Step 1: Create your first project"
                        : "Create Project"}
                    </h3>
                    {forceCreateVisible && (
                      <p className="text-sm text-muted-foreground">
                        This window stays open until a project is created.
                      </p>
                    )}
                  </div>

                  {forceCreateVisible && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                        <p>
                          Warning: This app can execute scripts and shell commands via AI
                          agents. Some actions may be irreversible (for example, deleting or
                          overwriting files).
                        </p>
                      </div>
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor="name">Project Name</Label>
                    <Input
                      id="name"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="My Project"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="desc">Description</Label>
                    <Input
                      id="desc"
                      value={newDescription}
                      onChange={(e) => setNewDescription(e.target.value)}
                      placeholder="Brief description of the project"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="instructions">Instructions for AI Agent</Label>
                    <textarea
                      id="instructions"
                      value={newInstructions}
                      onChange={(e) => setNewInstructions(e.target.value)}
                      placeholder="Special instructions for the AI when working on this project..."
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-[80px] resize-y focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>

                  {createError && (
                    <p className="text-sm text-destructive">{createError}</p>
                  )}

                  <div className="flex items-center gap-2">
                    <Button
                      onClick={handleCreate}
                      disabled={!newName.trim() || creatingProject}
                      className="gap-2"
                    >
                      {creatingProject ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          Creating...
                        </>
                      ) : (
                        "Create Project"
                      )}
                    </Button>
                    {!forceCreateVisible && (
                      <Button variant="ghost" onClick={() => setShowCreate(false)}>
                        Close
                      </Button>
                    )}
                  </div>
                </div>
              )}

              <div className="space-y-3">
                {!projectsLoading && projects.length === 0 && (
                  <div className="text-center py-12 text-muted-foreground">
                    <FolderOpen className="size-12 mx-auto mb-4 opacity-50" />
                    <p>No projects yet. Create one to get started.</p>
                  </div>
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
                        <div className="flex items-center gap-4 text-xs text-muted-foreground mt-2">
                          <span>
                            Memory:{" "}
                            {project.memoryMode === "isolated" ? "Isolated" : "Global"}
                          </span>
                          <span>
                            Created:{" "}
                            {new Date(project.createdAt).toLocaleDateString()}
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
    <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading...</div>}>
      <ProjectsPageClient />
    </Suspense>
  );
}
