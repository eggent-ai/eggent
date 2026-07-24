import { spawn } from "child_process";
import { createBashToolDefinition, getShellConfig, type BashOperations, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiPendingInteraction } from "@/lib/pi/interaction-types";
import { createPendingInteraction } from "@/lib/pi/pending-interactions";

interface InteractiveBashToolOptions {
  cwd: string;
  runId: string;
  abortSignal?: AbortSignal;
  commandPrefix?: string;
  shellPath?: string;
  onInteraction?: (interaction: PiPendingInteraction) => void;
}

const MAX_TIMEOUT_MS = 2_147_483_647;
const PROMPT_DEBOUNCE_MS = 250;

function resolveTimeoutMs(timeout?: number): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  return Math.min(timeout * 1000, MAX_TIMEOUT_MS);
}

function stripAnsi(input: string): string {
  return input.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function getPromptCandidate(outputTail: string): string | null {
  const cleaned = stripAnsi(outputTail).replace(/\r/g, "");
  const lines = cleaned.split("\n");
  const lastLine = (lines[lines.length - 1] || "").trim();
  if (!lastLine || lastLine.length > 300) return null;

  const lower = lastLine.toLowerCase();
  const looksInteractive =
    /password|passphrase|username|login|token|api key|verification code|one-time code|device code/.test(lower) ||
    /\b(y\/n|yes\/no|\[y\/n\]|\[y\/N\]|\[Y\/n\])\b/.test(lastLine) ||
    /(continue|proceed|confirm|overwrite|replace|delete|install|authenticate|authorize).*[?:]$/i.test(lastLine) ||
    /[:?]$/.test(lastLine) && /(enter|type|paste|select|choose|input|name|email|url|code|otp)/i.test(lastLine);

  return looksInteractive ? lastLine : null;
}

function isSecretPrompt(prompt: string): boolean {
  return /password|passphrase|token|api key|secret/i.test(prompt);
}

function writeStdin(childStdin: NodeJS.WritableStream | null | undefined, value: string) {
  const writable = childStdin as (NodeJS.WritableStream & { destroyed?: boolean }) | null | undefined;
  if (!writable || writable.destroyed) return;
  writable.write(value.endsWith("\n") ? value : `${value}\n`);
}

function createInteractiveBashOperations(options: InteractiveBashToolOptions): BashOperations {
  return {
    exec: async (command, cwd, execOptions) => {
      const timeoutMs = resolveTimeoutMs(execOptions.timeout);
      if (execOptions.signal?.aborted || options.abortSignal?.aborted) {
        throw new Error("aborted");
      }

      const shellConfig = getShellConfig(options.shellPath);
      const commandFromStdin = shellConfig.commandTransport === "stdin";
      const args = commandFromStdin ? shellConfig.args : [...shellConfig.args, command];
      const child = spawn(shellConfig.shell, args, {
        cwd,
        detached: process.platform !== "win32",
        env: execOptions.env ?? process.env,
        stdio: "pipe",
        windowsHide: true,
      });

      if (commandFromStdin) {
        child.stdin?.write(`${command}\n`);
      }

      let timedOut = false;
      let settled = false;
      let outputTail = "";
      let promptTimer: NodeJS.Timeout | undefined;
      let promptInFlight: Promise<void> | null = null;

      const killChild = () => {
        if (child.killed) return;
        if (process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, "SIGTERM");
            return;
          } catch {
            // Fall back to killing the child directly.
          }
        }
        child.kill("SIGTERM");
      };

      const askForInput = async (prompt: string) => {
        if (settled || promptInFlight) return;
        promptInFlight = (async () => {
          const answer = await createPendingInteraction({
            runId: options.runId,
            kind: isSecretPrompt(prompt) ? "secret" : "terminal_input",
            title: "Terminal command is waiting for input",
            message: prompt,
            placeholder: isSecretPrompt(prompt) ? "Enter secret input…" : "Type input and press Enter…",
            signal: options.abortSignal ?? execOptions.signal,
            onUpdate: options.onInteraction,
          });
          if (typeof answer === "string") {
            writeStdin(child.stdin, answer);
            outputTail = "";
          }
        })().finally(() => {
          promptInFlight = null;
        });
        await promptInFlight;
      };

      const schedulePromptCheck = () => {
        if (promptTimer) clearTimeout(promptTimer);
        promptTimer = setTimeout(() => {
          promptTimer = undefined;
          const prompt = getPromptCandidate(outputTail);
          if (prompt) void askForInput(prompt);
        }, PROMPT_DEBOUNCE_MS);
      };

      const onData = (data: Buffer) => {
        execOptions.onData(data);
        outputTail = (outputTail + data.toString("utf8")).slice(-2000);
        schedulePromptCheck();
      };

      let timeoutHandle: NodeJS.Timeout | undefined;
      const onAbort = () => killChild();

      try {
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.stdin?.on("error", () => {});

        if (timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            killChild();
          }, timeoutMs);
        }

        execOptions.signal?.addEventListener("abort", onAbort, { once: true });
        options.abortSignal?.addEventListener("abort", onAbort, { once: true });

        const exitCode = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code) => resolve(code));
        });
        settled = true;

        if (execOptions.signal?.aborted || options.abortSignal?.aborted) {
          throw new Error("aborted");
        }
        if (timedOut) {
          throw new Error(`timeout:${execOptions.timeout}`);
        }

        return { exitCode };
      } finally {
        settled = true;
        if (promptTimer) clearTimeout(promptTimer);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        execOptions.signal?.removeEventListener("abort", onAbort);
        options.abortSignal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

export function createEggentInteractiveBashTool(options: InteractiveBashToolOptions): ToolDefinition {
  return createBashToolDefinition(options.cwd, {
    operations: createInteractiveBashOperations(options),
    commandPrefix: options.commandPrefix,
    shellPath: options.shellPath,
  }) as ToolDefinition;
}
