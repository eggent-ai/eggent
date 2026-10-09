"use client";

import { useState } from "react";
import { Check, Copy, Loader2, Play, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { copyTextToClipboard } from "@/lib/utils";
import { ShellRunView } from "@/components/chat/shell-run";
import { useAppStore } from "@/store/app-store";
import { useShellRuns } from "@/store/shell-runs";

interface CodeBlockProps {
  code: string;
  language?: string;
  /**
   * What running this block would run, when somebody clearly meant it to be run
   * (see `runnableCommand`). Absent for output, config files and examples in
   * other languages: those get no button.
   */
  command?: string | null;
  /** Names this block's run, so the card is still there when the chat redraws. */
  runKey?: string;
}

export function CodeBlock({ code, language, command, runKey }: CodeBlockProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const run = useShellRuns((state) => (runKey ? state.runs[runKey] : undefined));
  const projectId = useAppStore((state) => state.activeProjectId);
  const currentPath = useAppStore((state) => state.currentPath);

  const handleCopy = async () => {
    const copiedOk = await copyTextToClipboard(code);
    if (!copiedOk) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const running = run?.status === "running" || run?.status === "starting";
  const runnable = Boolean(command && runKey);

  const handleRun = () => {
    if (!command || !runKey || running) return;
    // Where the agent works: the project, and the folder open in the tree.
    void useShellRuns.getState().start({ key: runKey, command, projectId, cwd: currentPath });
  };

  return (
    <div className="my-2">
      <div className="relative group rounded-lg border bg-muted/50 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/80">
          <span className="text-xs text-muted-foreground font-mono">
            {language || "code"}
          </span>
          <div className="flex items-center gap-1">
            {runnable ? (
              <Button
                variant="ghost"
                size="xs"
                onClick={handleRun}
                disabled={running}
                className="h-6 gap-1 text-xs"
                title={t("terminal.run.runHint")}
              >
                {running ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : run ? (
                  <RotateCw className="size-3" />
                ) : (
                  <Play className="size-3" />
                )}
                {run && !running ? t("terminal.run.runAgain") : t("terminal.run.run")}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="xs"
              onClick={handleCopy}
              className="h-6 gap-1 text-xs"
            >
              {copied ? (
                <>
                  <Check className="size-3" />
                  {t("chat.code.copied")}
                </>
              ) : (
                <>
                  <Copy className="size-3" />
                  {t("chat.code.copy")}
                </>
              )}
            </Button>
          </div>
        </div>
        <pre className="p-3 overflow-x-auto text-sm">
          <code className={language ? `language-${language}` : ""}>
            {code}
          </code>
        </pre>
      </div>
      {run && runKey ? <ShellRunView runKey={runKey} className="mt-1.5" /> : null}
    </div>
  );
}
