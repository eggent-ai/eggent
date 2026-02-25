import { spawn, type ChildProcess } from "child_process";
import type { AppSettings } from "@/lib/types";

// Persistent shell sessions
const sessions: Map<number, { process: ChildProcess; output: string; busy: boolean }> = new Map();

/**
 * Execute code in a specified runtime
 */
export async function executeCode(
  runtime: "python" | "nodejs" | "terminal",
  code: string,
  _sessionId: number,
  config: AppSettings["codeExecution"],
  cwd?: string
): Promise<string> {
  const timeout = (config.timeout || 180) * 1000;
  const maxOutput = config.maxOutputLength || 50000;

  try {
    let command: string;
    let args: string[];

    switch (runtime) {
      case "python":
        command = "python3";
        args = ["-c", code];
        break;
      case "nodejs":
        command = "node";
        args = ["-e", code];
        break;
      case "terminal":
        command = process.env.SHELL?.trim() || "sh";
        args = ["-c", rewriteAptCommandsWithSudo(code)];
        break;
      default:
        return `Error: Unknown runtime '${runtime}'`;
    }

    const result = await runCommand(command, args, timeout, maxOutput, cwd);
    return result;
  } catch (error) {
    return `Execution error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function rewriteAptCommandsWithSudo(code: string): string {
  const lines = code.split("\n");
  let changed = false;

  const rewritten = lines.map((line) => {
    // Preserve comments and empty lines.
    if (!line.trim() || line.trim().startsWith("#")) {
      return line;
    }

    let next = line.replace(/(^|&&|\|\||;)\s*apt-get\b/g, "$1 sudo apt-get");
    next = next.replace(/(^|&&|\|\||;)\s*apt\b/g, "$1 sudo apt");
    if (next !== line) {
      changed = true;
    }
    return next;
  });

  if (!changed) {
    return code;
  }

  return [
    'echo "[eggent] Auto-added sudo for apt/apt-get command(s)"',
    ...rewritten,
  ].join("\n");
}

/**
 * Run a shell command with timeout and output limits
 */
function runCommand(
  command: string,
  args: string[],
  timeout: number,
  maxOutput: number,
  cwd?: string
): Promise<string> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;

    const proc = spawn(command, args, {
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      cwd: cwd || process.cwd(),
    });

    proc.stdout?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      if (stdout.length + chunk.length < maxOutput) {
        stdout += chunk;
      } else if (!stdout.endsWith("\n[output truncated]")) {
        stdout += "\n[output truncated]";
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      if (stderr.length + chunk.length < maxOutput) {
        stderr += chunk;
      }
    });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 2000);
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);

      const parts: string[] = [];
      if (stdout.trim()) {
        parts.push(`STDOUT:\n${stdout.trim()}`);
      }
      if (stderr.trim()) {
        parts.push(`STDERR:\n${stderr.trim()}`);
      }
      if (killed) {
        parts.push(`[Process killed after timeout]`);
      }
      if (code !== null && code !== 0) {
        parts.push(`Exit code: ${code}`);
      }

      resolve(
        parts.length > 0
          ? parts.join("\n\n")
          : "(no output)"
      );
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve(`Process error: ${err.message}`);
    });
  });
}

/**
 * Clean up all sessions
 */
export function cleanupSessions(): void {
  for (const [id, session] of sessions) {
    try {
      session.process.kill("SIGTERM");
    } catch {
      // ignore
    }
    sessions.delete(id);
  }
}
