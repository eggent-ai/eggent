/**
 * Where a terminal starts.
 *
 * The same place the agent works: the project's folder, or the workspace's own
 * folder for the orchestrator. The chat's current directory may be passed as a
 * relative path and is honoured only inside that root - the shell itself can of
 * course `cd` anywhere, exactly as the agent's can, but the place it *starts*
 * is not an argument to be trusted into pointing somewhere else.
 */
import fs from "node:fs";
import path from "node:path";
import { getWorkDir, isOrchestratorScope } from "@/lib/storage/project-store";

export interface TerminalCwd {
  root: string;
  cwd: string;
}

export class TerminalCwdError extends Error {
  readonly code: "project-not-found" | "invalid-project";

  constructor(code: "project-not-found" | "invalid-project") {
    super(code === "project-not-found" ? "Project not found" : "Invalid project");
    this.code = code;
  }
}

export function resolveTerminalCwd(projectId: unknown, relative?: unknown): TerminalCwd {
  const scope = typeof projectId === "string" && projectId.trim() ? projectId.trim() : null;
  let root: string;
  try {
    root = path.resolve(getWorkDir(scope));
  } catch {
    throw new TerminalCwdError("invalid-project");
  }

  if (isOrchestratorScope(scope)) {
    fs.mkdirSync(root, { recursive: true });
  } else {
    // The store checks this too; a shell is a poor place to rely on one check.
    // A project is a direct child of the projects folder and nothing else is.
    if (path.dirname(root) !== path.resolve(getWorkDir(null))) throw new TerminalCwdError("invalid-project");
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(root).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) throw new TerminalCwdError("project-not-found");
  }

  // The real path, so what the shell reports as its own directory and what it
  // is compared with are the same string. A link in the way (macOS keeps its
  // temporary folders behind one) made a shell that was exactly in the project
  // look as if it were somewhere else.
  const realRoot = fs.realpathSync(root);

  const rel = typeof relative === "string" ? relative.trim().replace(/^[/\\]+/, "") : "";
  if (!rel) return { root: realRoot, cwd: realRoot };
  const candidate = path.resolve(root, rel);
  const inside = candidate === root || candidate.startsWith(root + path.sep);
  if (!inside) return { root: realRoot, cwd: realRoot };
  try {
    // A link inside the project may point anywhere; the real path has to stay
    // inside too, or "start in a folder of the project" is a way out of it.
    const real = fs.realpathSync(candidate);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { root: realRoot, cwd: realRoot };
    if (!fs.statSync(real).isDirectory()) return { root: realRoot, cwd: realRoot };
    return { root: realRoot, cwd: real };
  } catch {
    return { root: realRoot, cwd: realRoot };
  }
}
