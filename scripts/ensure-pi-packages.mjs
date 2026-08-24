#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// EGGENT_PI_PACKAGES replaces this list rather than extending it, so anything
// set there must repeat every entry it still wants.
const DEFAULT_PACKAGES = [
  "npm:pi-web-access",
  "npm:pi-mcp-adapter",
  "npm:@tintinweb/pi-subagents",
  // Spreadsheets. Reads and edits .xlsx/.xlsm through a pure-JS OOXML backend,
  // so it needs neither Excel nor LibreOffice. It declares node>=24 and npm
  // warns about it; the source uses nothing newer than Node 18, and reading a
  // real workbook on our Node 22 was verified before this was added.
  "npm:@firstpick/pi-extension-workbook",
];

const MAX_ATTEMPTS = Number(process.env.EGGENT_PI_PACKAGE_INSTALL_ATTEMPTS || 3) || 3;
const LOCK_STALE_MS = Number(process.env.EGGENT_PI_PACKAGE_INSTALL_LOCK_STALE_MS || 10 * 60 * 1000) || 10 * 60 * 1000;

// Keep per-workspace cold-start installs less aggressive. A signup burst can otherwise
// make many npm processes compete for CPU/RAM and leave partial node_modules trees.
process.env.npm_config_audit ??= "false";
process.env.npm_config_fund ??= "false";
process.env.npm_config_update_notifier ??= "false";
process.env.npm_config_progress ??= "false";
process.env.npm_config_jobs ??= "1";

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readEnvFile(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function resolveAgentDir() {
  const envFile = readEnvFile(path.join(process.cwd(), ".env"));
  const explicit = process.env.PI_CODING_AGENT_DIR?.trim() || envFile.PI_CODING_AGENT_DIR?.trim();
  if (explicit) return path.resolve(explicit);

  const globalPiAgentDir = path.join(os.homedir(), ".pi", "agent");
  if (fs.existsSync(globalPiAgentDir)) return globalPiAgentDir;
  return path.join(process.cwd(), "data", "pi-agent");
}

function resolvePackages() {
  const raw = process.env.EGGENT_PI_PACKAGES?.trim();
  if (!raw) return DEFAULT_PACKAGES;
  return raw
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getConfiguredPackageSources(settings) {
  const packages = Array.isArray(settings?.packages) ? settings.packages : [];
  return packages
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object" && typeof entry.source === "string") return entry.source;
      return null;
    })
    .filter(Boolean);
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
}

function cleanupNpmTempDirs(nodeModulesDir) {
  if (!fs.existsSync(nodeModulesDir)) return 0;
  let removed = 0;
  const walk = (dir, depth = 0) => {
    if (depth > 2) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(dir, entry.name);
      if (/^\.[^/]+-[A-Za-z0-9_-]{6,}$/.test(entry.name)) {
        rmrf(fullPath);
        removed += 1;
        continue;
      }
      // Scoped packages can contain npm temp dirs, e.g. @mistralai/.mistralai-xxxx.
      if (entry.name.startsWith("@")) walk(fullPath, depth + 1);
    }
  };
  walk(nodeModulesDir);
  return removed;
}

function cleanupPartialNpmInstall(agentDir, { full = false } = {}) {
  const npmDir = path.join(agentDir, "npm");
  const nodeModulesDir = path.join(npmDir, "node_modules");
  const removedTempDirs = cleanupNpmTempDirs(nodeModulesDir);
  if (removedTempDirs) console.warn(`Removed ${removedTempDirs} npm temp dir(s) from ${nodeModulesDir}`);
  if (full) {
    console.warn(`Removing partial npm install tree: ${nodeModulesDir}`);
    rmrf(nodeModulesDir);
    rmrf(path.join(npmDir, "package-lock.json"));
  }
}

async function withInstallLock(agentDir, fn) {
  const lockPath = path.join(agentDir, ".ensure-pi-packages.lock");
  const lockPayload = () => JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + "\n";
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, lockPayload());
      fs.closeSync(fd);
      try {
        return await fn();
      } finally {
        rmrf(lockPath);
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const stat = fs.statSync(lockPath);
        stale = Date.now() - stat.mtimeMs > LOCK_STALE_MS;
      } catch {
        stale = true;
      }
      if (stale) {
        console.warn(`Removing stale pi package install lock: ${lockPath}`);
        rmrf(lockPath);
        continue;
      }
      console.log(`Waiting for pi package install lock: ${lockPath}`);
      await sleep(2000);
    }
  }
}

async function ensureOnce({ agentDir, packages, DefaultPackageManager, SettingsManager }) {
  const settingsManager = SettingsManager.create(process.cwd(), agentDir);
  const packageManager = new DefaultPackageManager({
    cwd: process.cwd(),
    agentDir,
    settingsManager,
  });
  packageManager.setProgressCallback?.((event) => {
    const message = event?.message || event?.source || "";
    if (message) console.log(`[pi-package] ${message}`);
  });

  const globalSettings = settingsManager.getGlobalSettings();
  const configuredSources = getConfiguredPackageSources(globalSettings);
  let changed = false;

  for (const source of packages) {
    const configured = configuredSources.some((existing) =>
      packageManager.packageSourcesMatch(existing, source, "user")
    );

    const installedPath = packageManager.getInstalledPath(source, "user");
    const installed = installedPath && fs.existsSync(installedPath);

    if (configured && installed) {
      console.log(`Pi package already ready: ${source}`);
      continue;
    }

    if (configured && !installed) {
      console.log(`Installing missing pi package files: ${source}`);
      await packageManager.install(source, { local: false });
      changed = true;
      continue;
    }

    console.log(`Installing pi package: ${source}`);
    await packageManager.installAndPersist(source, { local: false });
    configuredSources.push(source);
    changed = true;
  }

  if (changed) {
    await settingsManager.flush();
    console.log(`Pi packages ensured in ${agentDir}`);
  } else {
    console.log(`Pi packages already ensured in ${agentDir}`);
  }
}

async function ensureWithRetries({ agentDir, packages }) {
  const { DefaultPackageManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      cleanupPartialNpmInstall(agentDir, { full: false });
      await ensureOnce({ agentDir, packages, DefaultPackageManager, SettingsManager });
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Pi package ensure attempt ${attempt}/${MAX_ATTEMPTS} failed: ${message}`);
      cleanupPartialNpmInstall(agentDir, { full: attempt < MAX_ATTEMPTS });
      if (attempt < MAX_ATTEMPTS) {
        await sleep(1500 * attempt);
      }
    }
  }
  throw lastError;
}

if (truthy(process.env.EGGENT_SKIP_PI_PACKAGE_INSTALL)) {
  console.log("Skipping pi package install (EGGENT_SKIP_PI_PACKAGE_INSTALL is set).");
  process.exit(0);
}

const packages = resolvePackages();
if (packages.length === 0) {
  console.log("No Eggent-managed pi packages requested.");
  process.exit(0);
}

const agentDir = resolveAgentDir();
process.env.PI_CODING_AGENT_DIR = agentDir;
fs.mkdirSync(agentDir, { recursive: true });

await withInstallLock(agentDir, () => ensureWithRetries({ agentDir, packages }));
