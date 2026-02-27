import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_CAP = 120_000;

export type InstallKind = "auto" | "node" | "python" | "go" | "uv" | "apt";

export type InstallAttempt = {
  command: string;
  manager: string;
  code: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  success: boolean;
  skipped: boolean;
  reason?: string;
};

export type InstallPackagesParams = {
  kind: InstallKind;
  packages: string[];
  preferManager?: string;
  global?: boolean;
  cwd: string;
  timeoutMs?: number;
};

export type InstallPackagesResult = {
  success: boolean;
  kind: InstallKind;
  resolvedKind: Exclude<InstallKind, "auto">;
  manager: string | null;
  message: string;
  attempts: InstallAttempt[];
};

type InstallStep = {
  argv: string[];
  manager: string;
  cwd?: string;
};

type InstallPlan = {
  manager: string;
  steps: InstallStep[];
};

type CommandRunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

export async function installPackages(params: InstallPackagesParams): Promise<InstallPackagesResult> {
  const packages = uniqueNonEmpty(params.packages);
  if (packages.length === 0) {
    return {
      success: false,
      kind: params.kind,
      resolvedKind: resolveAutoKind(params.kind, params.preferManager),
      manager: null,
      message: "No packages specified.",
      attempts: [],
    };
  }

  const timeoutMs = clampTimeout(params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const resolvedKind = resolveAutoKind(params.kind, params.preferManager);
  const attempts: InstallAttempt[] = [];
  const plans = await buildInstallPlans({
    kind: resolvedKind,
    packages,
    preferManager: params.preferManager,
    global: params.global === true,
    cwd: params.cwd,
    timeoutMs,
  });

  if (plans.length === 0) {
    return {
      success: false,
      kind: params.kind,
      resolvedKind,
      manager: null,
      message: `No compatible installer found for kind=${resolvedKind}.`,
      attempts,
    };
  }

  for (const plan of plans) {
    const planResult = await executePlan(plan, timeoutMs);
    attempts.push(...planResult.attempts);

    if (planResult.success) {
      return {
        success: true,
        kind: params.kind,
        resolvedKind,
        manager: plan.manager,
        message: `Installed successfully using ${plan.manager}.`,
        attempts,
      };
    }
  }

  const last = attempts.at(-1);
  const message =
    last?.stderr?.trim() ||
    `Failed to install package(s) with available ${resolvedKind} installers.`;

  return {
    success: false,
    kind: params.kind,
    resolvedKind,
    manager: null,
    message,
    attempts,
  };
}

async function buildInstallPlans(params: {
  kind: Exclude<InstallKind, "auto">;
  packages: string[];
  preferManager?: string;
  global: boolean;
  cwd: string;
  timeoutMs: number;
}): Promise<InstallPlan[]> {
  switch (params.kind) {
    case "node":
      return buildNodePlans(params);
    case "python":
      return buildPythonPlans(params);
    case "uv":
      return buildUvPlans(params);
    case "go":
      return buildGoPlans(params);
    case "apt":
      return await buildAptPlans(params);
  }
}

function buildNodePlans(params: {
  packages: string[];
  preferManager?: string;
  global: boolean;
  cwd: string;
}): InstallPlan[] {
  const order = orderedManagers(
    ["pnpm", "npm", "yarn", "bun"],
    normalizeManager(params.preferManager)
  );

  const plans: InstallPlan[] = [];
  for (const manager of order) {
    if (!commandExists(manager)) {
      plans.push({
        manager,
        steps: [],
      });
      continue;
    }

    let argv: string[];
    if (manager === "pnpm") {
      argv = params.global
        ? ["pnpm", "add", "-g", "--ignore-scripts", ...params.packages]
        : ["pnpm", "add", ...params.packages];
    } else if (manager === "npm") {
      argv = params.global
        ? ["npm", "install", "-g", "--ignore-scripts", ...params.packages]
        : ["npm", "install", ...params.packages];
    } else if (manager === "yarn") {
      argv = params.global
        ? ["yarn", "global", "add", ...params.packages]
        : ["yarn", "add", ...params.packages];
    } else {
      argv = params.global
        ? ["bun", "add", "-g", "--ignore-scripts", ...params.packages]
        : ["bun", "add", ...params.packages];
    }

    plans.push({
      manager,
      steps: [
        {
          manager,
          argv,
          cwd: params.cwd,
        },
      ],
    });
  }

  return plans;
}

function buildPythonPlans(params: {
  packages: string[];
  preferManager?: string;
  cwd: string;
}): InstallPlan[] {
  const normalized = normalizeManager(params.preferManager);
  const plans: InstallPlan[] = [];

  const uvPreferred = normalized === "uv";
  if (uvPreferred && commandExists("uv")) {
    plans.push({
      manager: "uv",
      steps: [
        {
          manager: "uv",
          argv: ["uv", "pip", "install", ...params.packages],
          cwd: params.cwd,
        },
      ],
    });
  }

  if (commandExists("python3")) {
    plans.push({
      manager: "pip",
      steps: [
        {
          manager: "pip",
          argv: ["python3", "-m", "pip", "install", ...params.packages],
          cwd: params.cwd,
        },
      ],
    });
  } else if (commandExists("python")) {
    plans.push({
      manager: "pip",
      steps: [
        {
          manager: "pip",
          argv: ["python", "-m", "pip", "install", ...params.packages],
          cwd: params.cwd,
        },
      ],
    });
  }

  if (!uvPreferred && commandExists("uv")) {
    plans.push({
      manager: "uv",
      steps: [
        {
          manager: "uv",
          argv: ["uv", "pip", "install", ...params.packages],
          cwd: params.cwd,
        },
      ],
    });
  }

  return plans;
}

function buildUvPlans(params: { packages: string[]; cwd: string }): InstallPlan[] {
  if (!commandExists("uv")) {
    return [];
  }
  return [
    {
      manager: "uv",
      steps: [
        {
          manager: "uv",
          argv: ["uv", "tool", "install", ...params.packages],
          cwd: params.cwd,
        },
      ],
    },
  ];
}

function buildGoPlans(params: { packages: string[]; cwd: string }): InstallPlan[] {
  if (!commandExists("go")) {
    return [];
  }

  const argv = ["go", "install", ...params.packages];
  return [
    {
      manager: "go",
      steps: [
        {
          manager: "go",
          argv,
          cwd: params.cwd,
        },
      ],
    },
  ];
}

async function buildAptPlans(params: {
  packages: string[];
  cwd: string;
  timeoutMs: number;
}): Promise<InstallPlan[]> {
  if (!commandExists("apt-get")) {
    return [];
  }

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (isRoot) {
    return [
      {
        manager: "apt-get",
        steps: [
          { manager: "apt-get", argv: ["apt-get", "update", "-qq"], cwd: params.cwd },
          {
            manager: "apt-get",
            argv: ["apt-get", "install", "-y", ...params.packages],
            cwd: params.cwd,
          },
        ],
      },
    ];
  }

  if (!commandExists("sudo")) {
    return [];
  }

  const sudoCheck = await runCommand(["sudo", "-n", "true"], {
    timeoutMs: Math.min(params.timeoutMs, 10_000),
    cwd: params.cwd,
  });
  if (sudoCheck.code !== 0) {
    return [];
  }

  return [
    {
      manager: "sudo-apt-get",
      steps: [
        {
          manager: "sudo-apt-get",
          argv: ["sudo", "apt-get", "update", "-qq"],
          cwd: params.cwd,
        },
        {
          manager: "sudo-apt-get",
          argv: ["sudo", "apt-get", "install", "-y", ...params.packages],
          cwd: params.cwd,
        },
      ],
    },
  ];
}

async function executePlan(
  plan: InstallPlan,
  timeoutMs: number
): Promise<{ success: boolean; attempts: InstallAttempt[] }> {
  if (plan.steps.length === 0) {
    return {
      success: false,
      attempts: [
        {
          command: plan.manager,
          manager: plan.manager,
          code: null,
          durationMs: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          success: false,
          skipped: true,
          reason: `Manager \"${plan.manager}\" is not available in PATH.`,
        },
      ],
    };
  }

  const attempts: InstallAttempt[] = [];
  for (const step of plan.steps) {
    const run = await runCommand(step.argv, {
      timeoutMs,
      cwd: step.cwd,
    });

    const attempt: InstallAttempt = {
      command: formatCommand(step.argv),
      manager: step.manager,
      code: run.code,
      durationMs: run.durationMs,
      stdout: run.stdout,
      stderr: run.stderr,
      timedOut: run.timedOut,
      success: run.code === 0,
      skipped: false,
    };

    attempts.push(attempt);
    if (run.code !== 0) {
      return { success: false, attempts };
    }
  }

  return { success: true, attempts };
}

async function runCommand(
  argv: string[],
  options: {
    timeoutMs: number;
    cwd?: string;
  }
): Promise<CommandRunResult> {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const command = argv[0];
    const args = argv.slice(1);
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendWithCap(stdout, chunk.toString(), OUTPUT_CAP);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendWithCap(stderr, chunk.toString(), OUTPUT_CAP);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 2000);
    }, options.timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        code: null,
        stdout,
        stderr: appendWithCap(stderr, error.message, OUTPUT_CAP),
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function appendWithCap(current: string, chunk: string, cap: number): string {
  if (current.length >= cap) {
    return current;
  }
  const remaining = cap - current.length;
  if (chunk.length <= remaining) {
    return current + chunk;
  }
  return current + chunk.slice(0, Math.max(0, remaining));
}

function resolveAutoKind(kind: InstallKind, preferManager?: string): Exclude<InstallKind, "auto"> {
  if (kind !== "auto") {
    return kind;
  }

  const manager = normalizeManager(preferManager);
  if (manager === "go") return "go";
  if (manager === "uv") return "uv";
  if (manager === "pip" || manager === "python") return "python";
  if (manager === "apt" || manager === "apt-get") return "apt";
  return "node";
}

function orderedManagers(base: string[], preferred?: string): string[] {
  if (!preferred) {
    return base;
  }
  const normalized = preferred.toLowerCase();
  const filtered = base.filter((value) => value !== normalized);
  return base.includes(normalized) ? [normalized, ...filtered] : base;
}

function commandExists(command: string, envPath?: string): boolean {
  const rawPath = envPath ?? process.env.PATH;
  if (!rawPath) {
    return false;
  }

  for (const dir of rawPath.split(path.delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) {
      continue;
    }
    const candidate = path.join(trimmed, command);
    if (fs.existsSync(candidate)) {
      return true;
    }
    if (process.platform === "win32") {
      const winCandidate = path.join(trimmed, `${command}.cmd`);
      if (fs.existsSync(winCandidate)) {
        return true;
      }
    }
  }

  return false;
}

function uniqueNonEmpty(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function normalizeManager(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function formatCommand(argv: string[]): string {
  return argv.map(quoteArg).join(" ");
}

function quoteArg(arg: string): string {
  if (/^[a-zA-Z0-9_./:@%+-]+$/.test(arg)) {
    return arg;
  }
  return JSON.stringify(arg);
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.floor(value), 1_000), 30 * 60_000);
}
