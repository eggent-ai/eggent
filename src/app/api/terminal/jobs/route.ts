import path from "node:path";
import { NextRequest } from "next/server";
import { getServerTranslator } from "@/i18n/server";
import { checkTerminalRequest, jsonError } from "@/lib/terminal/guard";
import { failureResponse } from "@/lib/terminal/respond";
import { resolveTerminalCwd, TerminalCwdError } from "@/lib/terminal/cwd";
import { resolvePtyAvailability } from "@/lib/terminal/pty-helper";
import { prepareInteractiveShell } from "@/lib/terminal/interactive-shell";
import { resolveRunShell } from "@/lib/terminal/run-shell";
import { getTerminalRegistry, TerminalLimitError } from "@/lib/terminal/registry";
import { TERMINAL_LIMITS } from "@/lib/terminal/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CreateBody {
  kind?: unknown;
  projectId?: unknown;
  cwd?: unknown;
  command?: unknown;
  cols?: unknown;
  rows?: unknown;
}

/**
 * POST /api/terminal/jobs
 *
 * Starts a command (`kind: "run"`, with its output kept for whoever reads it)
 * or a shell for the side panel (`kind: "pty"`, one per project: asking again
 * returns the one that is still running instead of starting another).
 */
export async function POST(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: true });
  if (failure) return failureResponse(req, failure);

  const t = await getServerTranslator(req.headers.get("accept-language"));
  const body = (await req.json().catch(() => null)) as CreateBody | null;
  if (!body || typeof body !== "object") return jsonError(t("api.error.terminalJsonRequired"), 400);

  let place;
  try {
    place = resolveTerminalCwd(body.projectId, body.cwd);
  } catch (error) {
    if (error instanceof TerminalCwdError && error.code === "project-not-found") {
      return jsonError(t("api.error.terminalProjectNotFound"), 404);
    }
    return jsonError(t("api.error.terminalProjectNotFound"), 400);
  }

  const registry = getTerminalRegistry();
  try {
    if (body.kind === "run") {
      const command = typeof body.command === "string" ? body.command : "";
      if (!command.trim()) return jsonError(t("api.error.terminalCommandRequired"), 400);
      if (command.length > TERMINAL_LIMITS.maxCommandChars) {
        return jsonError(t("api.error.terminalCommandTooLong"), 413);
      }
      const { shell, commandPrefix } = resolveRunShell(place.cwd);
      const id = registry.startRun({ command, cwd: place.cwd, shell, commandPrefix });
      return Response.json({ id, kind: "run", reused: false }, { status: 201, headers: { "Cache-Control": "no-store" } });
    }

    if (body.kind === "pty") {
      const availability = resolvePtyAvailability();
      if (!availability.python) {
        return Response.json(
          { error: t("api.error.terminalNoPty"), code: "pty-unavailable", reason: availability.reason },
          { status: 501, headers: { "Cache-Control": "no-store" } }
        );
      }
      const { shell } = resolveRunShell(place.cwd);
      const interactive = prepareInteractiveShell(shell.path, place.root, path.join(process.cwd(), "data"));
      const scope = typeof body.projectId === "string" && body.projectId.trim() ? body.projectId.trim() : "none";
      const started = registry.startPty({
        cwd: place.cwd,
        python: availability.python,
        shellPath: interactive.path,
        shellArgs: interactive.args,
        cols: Number(body.cols),
        rows: Number(body.rows),
        env: interactive.env,
        key: `project:${scope}`,
      });
      return Response.json(
        { id: started.id, kind: "pty", reused: started.reused },
        { status: started.reused ? 200 : 201, headers: { "Cache-Control": "no-store" } }
      );
    }

    return jsonError(t("api.error.terminalKindInvalid"), 400);
  } catch (error) {
    if (error instanceof TerminalLimitError) return jsonError(t("api.error.terminalTooMany"), 429);
    console.error("Failed to start a terminal job:", error);
    return jsonError(t("api.error.terminalStartFailed"), 500);
  }
}
