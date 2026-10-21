"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ClipboardCheck, Download, ExternalLink, FileAudio, FileText, History, ImageIcon, Loader2, Save } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { SidePanels } from "@/components/side-panels";
import { FileBody, formatFileSize, useFileContent } from "@/components/file-view";
import { VersionHistory } from "@/components/files/version-history";
import { FileApproval, FileApprovalNotice, useFileApproval } from "@/components/approvals/file-approval";
import { useApprovalsSummary } from "@/components/approvals/use-approvals-summary";
import { useI18n } from "@/i18n/provider";
import { fileDownloadUrl, isOpenableFile } from "@/lib/files/openable";

export default function GenericFileEditorPage() {
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const projectId = searchParams.get("project") || "none";
  const filePath = searchParams.get("path") || "";
  const file = useFileContent(projectId, filePath);
  const { metadata, loading, saving, status, error, save, dirty, title } = file;
  const [showHistory, setShowHistory] = useState(false);
  const [showApproval, setShowApproval] = useState(false);
  const approvalsOn = Boolean(useApprovalsSummary()?.enabled);
  const savedAt = metadata?.updatedAt ? Date.parse(metadata.updatedAt) || 0 : 0;
  const fileApproval = useFileApproval(projectId, filePath, approvalsOn && !showApproval, savedAt);

  const downloadHref = useMemo(() => fileDownloadUrl(projectId, filePath), [projectId, filePath]);

  // A built page could only be downloaded as an unnamed binary, so the one
  // thing its author wanted — to look at it — was the one thing they could not
  // do here. Opening is served sandboxed, in its own tab.
  const openHref = useMemo(
    () => fileDownloadUrl(projectId, filePath, { inline: true }),
    [projectId, filePath]
  );

  const isOpenable = isOpenableFile(filePath);
  const isImagePreview = file.isImage;
  const isAudioPreview = file.isAudio;
  const isMediaPreview = file.isMedia;

  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex flex-col">
        <SiteHeader title={t("files.previewTitle")} />
        <div className="flex flex-1">
          <AppSidebar />
          <SidebarInset>
            <div className="flex flex-1 flex-col gap-4 p-4 md:p-6 max-w-5xl mx-auto w-full">
              <div className="space-y-1">
                <h2 className="text-2xl font-semibold">{title}</h2>
                <p className="break-all text-sm text-muted-foreground">
                  {projectId === "none" ? t("common.orchestrator") : t("common.projectWithId", { id: projectId })} / {filePath}
                </p>
              </div>

              <section className="rounded-xl border bg-card p-4 md:p-5 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-start gap-2 min-w-0">
                    {isImagePreview ? (
                      <ImageIcon className="mt-1 size-4 shrink-0 text-primary" />
                    ) : isAudioPreview ? (
                      <FileAudio className="mt-1 size-4 shrink-0 text-primary" />
                    ) : (
                      <FileText className="mt-1 size-4 shrink-0 text-primary" />
                    )}
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{isMediaPreview ? metadata?.contentType : t("files.textPreview")}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatFileSize(metadata?.size)}{metadata?.updatedAt ? ` · ${t("common.updated", { date: new Date(metadata.updatedAt).toLocaleString() })}` : ""}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {!isMediaPreview ? (
                      <Button
                        variant={showHistory ? "secondary" : "outline"}
                        className="gap-2"
                        onClick={() => {
                          setShowHistory((value) => !value);
                          setShowApproval(false);
                        }}
                        aria-pressed={showHistory}
                      >
                        <History className="size-4" />
                        {t("files.history.title")}
                      </Button>
                    ) : null}
                    {approvalsOn ? (
                      <Button
                        variant={showApproval ? "secondary" : "outline"}
                        className="gap-2"
                        onClick={() => {
                          if (!showApproval && dirty && !window.confirm(t("files.panel.discardChanges"))) return;
                          setShowApproval((value) => !value);
                          setShowHistory(false);
                        }}
                        aria-pressed={showApproval}
                      >
                        <ClipboardCheck className="size-4" />
                        {t("approvals.file.title")}
                      </Button>
                    ) : null}
                    {isOpenable ? (
                      <Button variant="outline" asChild className="gap-2">
                        <a href={openHref} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="size-4" />
                          {t("files.open")}
                        </a>
                      </Button>
                    ) : null}
                    <Button variant="outline" asChild className="gap-2">
                      <a href={downloadHref} download={title}>
                        <Download className="size-4" />
                        {t("common.download")}
                      </a>
                    </Button>
                    {!isMediaPreview && !showHistory && !showApproval ? (
                      <Button onClick={() => void save()} disabled={loading || saving || !dirty} className="gap-2">
                        {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                        {t("common.save")}
                      </Button>
                    ) : null}
                  </div>
                </div>

                {status ? <Badge variant="secondary">{status}</Badge> : null}
                {error && metadata ? (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}

                {!showApproval && !showHistory ? <FileApprovalNotice status={fileApproval.status} /> : null}
                {showHistory ? (
                  <VersionHistory projectId={projectId} path={filePath} onRestored={() => void file.refresh()} />
                ) : showApproval ? (
                  <FileApproval projectId={projectId} path={filePath} version={savedAt} />
                ) : (
                  <FileBody file={file} />
                )}
              </section>
            </div>
          </SidebarInset>
          <SidePanels />
        </div>
      </SidebarProvider>
    </div>
  );
}
