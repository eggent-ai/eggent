import type { Dirent } from "fs";
import fs from "fs/promises";
import path from "path";

export const EGGENT_SYNCTHING_FOLDER_ID = "eggent-data";
export const EGGENT_SYNCTHING_FOLDER_LABEL = "Eggent data";

const SYNCTHING_URL = process.env.SYNCTHING_URL?.trim().replace(/\/$/, "") || "";
const SYNCTHING_API_KEY = process.env.SYNCTHING_API_KEY?.trim() || "";
const SYNCTHING_DATA_PATH = process.env.SYNCTHING_DATA_PATH?.trim() || "/sync/data";
const LOCAL_DATA_PATH = path.join(process.cwd(), "data");

export const EGGENT_SYNCTHING_IGNORES = [
  "(?d).DS_Store",
  "(?d)tmp",
  "(?d)npm-cache",
  "(?d)ms-playwright",
  "(?d).cache",
  "(?d).codex",
  "(?d).gemini",
  "(?d)pi-agent",
  "(?d)settings",
  "(?d)integrations/telegram",
  "(?d)external-sessions",
  "(?d)projects/.pi/subagent-schedules",
  "(?d)projects/**/.pi/subagent-schedules",
  "(?d)projects/**/.mcp.json",
  "(?d)**/.env",
  "(?d)**/.env.*",
  "(?d)**/node_modules",
  "(?d)**/.venv",
  "(?d)**/venv",
  "(?d)**/__pycache__",
];

interface SyncthingSystemStatus {
  myID?: string;
  uptime?: number;
}

interface SyncthingConnection {
  connected?: boolean;
  address?: string;
  type?: string;
  clientVersion?: string;
}

interface SyncthingConnections {
  connections?: Record<string, SyncthingConnection>;
}

interface SyncthingDevice {
  deviceID?: string;
  name?: string;
  addresses?: string[];
  paused?: boolean;
  [key: string]: unknown;
}

interface SyncthingFolderDevice {
  deviceID?: string;
  [key: string]: unknown;
}

interface SyncthingFolder {
  id?: string;
  label?: string;
  path?: string;
  type?: string;
  paused?: boolean;
  devices?: SyncthingFolderDevice[];
  [key: string]: unknown;
}

interface SyncthingFolderStatus {
  state?: string;
  stateChanged?: string;
  error?: string;
  localFiles?: number;
  globalFiles?: number;
  needFiles?: number;
  localBytes?: number;
  globalBytes?: number;
  needBytes?: number;
  inSyncFiles?: number;
  inSyncBytes?: number;
}

interface SyncthingPendingDevice {
  name?: string;
  address?: string;
  time?: string;
}

interface SyncthingPendingDevices {
  [deviceId: string]: SyncthingPendingDevice;
}

export interface EggentSyncthingPeer {
  deviceId: string;
  name: string;
  connected: boolean;
  address?: string;
  connectionType?: string;
  clientVersion?: string;
  paused: boolean;
}

export interface EggentSyncthingStatus {
  available: boolean;
  error?: string;
  enabled: boolean;
  paused: boolean;
  localDeviceId?: string;
  uptime?: number;
  folder?: {
    id: string;
    label: string;
    path: string;
    state: string;
    stateChanged?: string;
    error?: string;
    localFiles: number;
    globalFiles: number;
    needFiles: number;
    localBytes: number;
    globalBytes: number;
    needBytes: number;
    inSyncFiles: number;
    inSyncBytes: number;
  };
  peers: EggentSyncthingPeer[];
  pendingDevices: Array<{
    deviceId: string;
    name?: string;
    address?: string;
    time?: string;
  }>;
  conflicts: string[];
  ignorePatterns: string[];
}

function syncthingConfigured(): boolean {
  return Boolean(SYNCTHING_URL && SYNCTHING_API_KEY);
}

async function syncthingRequest<T>(
  pathname: string,
  init: RequestInit = {},
  timeoutMs = 8_000
): Promise<T> {
  if (!syncthingConfigured()) {
    throw new Error("Syncthing is not configured for this Eggent runtime.");
  }

  const response = await fetch(`${SYNCTHING_URL}${pathname}`, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "X-API-Key": SYNCTHING_API_KEY,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Syncthing API ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function getFolders(): Promise<SyncthingFolder[]> {
  return syncthingRequest<SyncthingFolder[]>("/rest/config/folders");
}

async function getDevices(): Promise<SyncthingDevice[]> {
  return syncthingRequest<SyncthingDevice[]>("/rest/config/devices");
}

function normalizeDeviceId(value: string): string {
  return value.trim().toUpperCase();
}

function validateDeviceId(value: string): string {
  const deviceId = normalizeDeviceId(value);
  if (!/^[A-Z0-9-]{40,80}$/.test(deviceId)) {
    throw new Error("Enter a valid Syncthing Device ID.");
  }
  return deviceId;
}

async function findConflictFiles(maxResults = 50): Promise<string[]> {
  const conflicts: string[] = [];

  async function walk(dir: string, relativeDir = ""): Promise<void> {
    if (conflicts.length >= maxResults) return;
    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (conflicts.length >= maxResults) break;
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (["node_modules", ".git", ".cache", "npm-cache", "ms-playwright"].includes(entry.name)) continue;
        await walk(path.join(dir, entry.name), relativePath);
      } else if (entry.name.includes(".sync-conflict-")) {
        conflicts.push(relativePath);
      }
    }
  }

  await walk(LOCAL_DATA_PATH);
  return conflicts;
}

export async function getEggentSyncthingStatus(): Promise<EggentSyncthingStatus> {
  if (!syncthingConfigured()) {
    return {
      available: false,
      error: "Syncthing sidecar is not configured. Rebuild/restart the Docker stack or set SYNCTHING_URL and SYNCTHING_API_KEY.",
      enabled: false,
      paused: false,
      peers: [],
      pendingDevices: [],
      conflicts: [],
      ignorePatterns: EGGENT_SYNCTHING_IGNORES,
    };
  }

  try {
    const [system, folders, devices, connections, pendingDevices, conflicts] = await Promise.all([
      syncthingRequest<SyncthingSystemStatus>("/rest/system/status"),
      getFolders(),
      getDevices(),
      syncthingRequest<SyncthingConnections>("/rest/system/connections"),
      syncthingRequest<SyncthingPendingDevices>("/rest/cluster/pending/devices").catch(() => ({})),
      findConflictFiles(),
    ]);

    const folder = folders.find((item) => item.id === EGGENT_SYNCTHING_FOLDER_ID);
    const folderStatus = folder
      ? await syncthingRequest<SyncthingFolderStatus>(
          `/rest/db/status?folder=${encodeURIComponent(EGGENT_SYNCTHING_FOLDER_ID)}`
        ).catch(() => undefined)
      : undefined;

    const connectionMap = connections.connections ?? {};
    const sharedDeviceIds = new Set((folder?.devices ?? []).map((item) => item.deviceID).filter(Boolean));
    const peers = devices
      .filter((device) => device.deviceID && (sharedDeviceIds.size === 0 || sharedDeviceIds.has(device.deviceID)))
      .map((device): EggentSyncthingPeer => {
        const connection = connectionMap[device.deviceID || ""];
        return {
          deviceId: device.deviceID || "",
          name: device.name || device.deviceID || "Syncthing device",
          connected: connection?.connected === true,
          address: connection?.address,
          connectionType: connection?.type,
          clientVersion: connection?.clientVersion,
          paused: device.paused === true,
        };
      });

    return {
      available: true,
      enabled: Boolean(folder && folder.paused !== true),
      paused: folder?.paused === true,
      localDeviceId: system.myID,
      uptime: system.uptime,
      folder: folder
        ? {
            id: EGGENT_SYNCTHING_FOLDER_ID,
            label: folder.label || EGGENT_SYNCTHING_FOLDER_LABEL,
            path: folder.path || SYNCTHING_DATA_PATH,
            state: folderStatus?.state || (folder.paused ? "paused" : "unknown"),
            stateChanged: folderStatus?.stateChanged,
            error: folderStatus?.error,
            localFiles: folderStatus?.localFiles ?? 0,
            globalFiles: folderStatus?.globalFiles ?? 0,
            needFiles: folderStatus?.needFiles ?? 0,
            localBytes: folderStatus?.localBytes ?? 0,
            globalBytes: folderStatus?.globalBytes ?? 0,
            needBytes: folderStatus?.needBytes ?? 0,
            inSyncFiles: folderStatus?.inSyncFiles ?? 0,
            inSyncBytes: folderStatus?.inSyncBytes ?? 0,
          }
        : undefined,
      peers,
      pendingDevices: Object.entries(pendingDevices).map(([deviceId, pending]) => ({
        deviceId,
        name: pending.name,
        address: pending.address,
        time: pending.time,
      })),
      conflicts,
      ignorePatterns: EGGENT_SYNCTHING_IGNORES,
    };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : "Syncthing is unavailable.",
      enabled: false,
      paused: false,
      peers: [],
      pendingDevices: [],
      conflicts: [],
      ignorePatterns: EGGENT_SYNCTHING_IGNORES,
    };
  }
}

async function writeIgnorePatterns(): Promise<void> {
  await syncthingRequest(`/rest/db/ignores?folder=${encodeURIComponent(EGGENT_SYNCTHING_FOLDER_ID)}`, {
    method: "POST",
    body: JSON.stringify({ ignore: EGGENT_SYNCTHING_IGNORES }),
  });
}

export async function enableEggentSyncthing(): Promise<void> {
  const folders = await getFolders();
  const existing = folders.find((item) => item.id === EGGENT_SYNCTHING_FOLDER_ID);

  if (existing) {
    await syncthingRequest(
      `/rest/config/folders/${encodeURIComponent(EGGENT_SYNCTHING_FOLDER_ID)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ paused: false, type: "sendreceive" }),
      }
    );
  } else {
    const template = await syncthingRequest<SyncthingFolder>("/rest/config/defaults/folder");
    const devices = await getDevices();
    await syncthingRequest("/rest/config/folders", {
      method: "POST",
      body: JSON.stringify({
        ...template,
        id: EGGENT_SYNCTHING_FOLDER_ID,
        label: EGGENT_SYNCTHING_FOLDER_LABEL,
        path: SYNCTHING_DATA_PATH,
        type: "sendreceive",
        paused: false,
        fsWatcherEnabled: true,
        fsWatcherDelayS: 2,
        devices: devices
          .filter((device) => device.deviceID)
          .map((device) => ({ deviceID: device.deviceID })),
        versioning: {
          type: "staggered",
          params: {
            cleanInterval: "3600",
            maxAge: "2592000",
          },
        },
      }),
    });
  }

  await writeIgnorePatterns();
}

export async function pauseEggentSyncthing(paused: boolean): Promise<void> {
  await syncthingRequest(
    `/rest/config/folders/${encodeURIComponent(EGGENT_SYNCTHING_FOLDER_ID)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ paused }),
    }
  );
}

export async function addEggentSyncthingPeer(options: {
  deviceId: string;
  name?: string;
  address?: string;
}): Promise<void> {
  const deviceId = validateDeviceId(options.deviceId);
  const system = await syncthingRequest<SyncthingSystemStatus>("/rest/system/status");
  if (normalizeDeviceId(system.myID || "") === deviceId) {
    throw new Error("This is the current Eggent Device ID. Enter the other device ID.");
  }

  const devices = await getDevices();
  const existingDevice = devices.find((device) => normalizeDeviceId(device.deviceID || "") === deviceId);
  if (!existingDevice) {
    const template = await syncthingRequest<SyncthingDevice>("/rest/config/defaults/device");
    await syncthingRequest("/rest/config/devices", {
      method: "POST",
      body: JSON.stringify({
        ...template,
        deviceID: deviceId,
        name: options.name?.trim() || `Eggent ${deviceId.slice(0, 7)}`,
        addresses: [options.address?.trim() || "dynamic"],
        autoAcceptFolders: false,
        paused: false,
      }),
    });
  }

  await enableEggentSyncthing();
  const folders = await getFolders();
  const folder = folders.find((item) => item.id === EGGENT_SYNCTHING_FOLDER_ID);
  if (!folder) throw new Error("Eggent data folder was not created.");

  const folderDevices = folder.devices ?? [];
  if (!folderDevices.some((device) => normalizeDeviceId(device.deviceID || "") === deviceId)) {
    await syncthingRequest(
      `/rest/config/folders/${encodeURIComponent(EGGENT_SYNCTHING_FOLDER_ID)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          devices: [...folderDevices, { deviceID: deviceId }],
        }),
      }
    );
  }
}

export async function removeEggentSyncthingPeer(deviceIdInput: string): Promise<void> {
  const deviceId = validateDeviceId(deviceIdInput);
  const folders = await getFolders();
  const folder = folders.find((item) => item.id === EGGENT_SYNCTHING_FOLDER_ID);

  if (folder) {
    await syncthingRequest(
      `/rest/config/folders/${encodeURIComponent(EGGENT_SYNCTHING_FOLDER_ID)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          devices: (folder.devices ?? []).filter(
            (device) => normalizeDeviceId(device.deviceID || "") !== deviceId
          ),
        }),
      }
    );
  }

  await syncthingRequest(`/rest/config/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
  }).catch(() => undefined);
}

export async function acceptPendingEggentSyncthingDevice(options: {
  deviceId: string;
  name?: string;
}): Promise<void> {
  await addEggentSyncthingPeer({
    deviceId: options.deviceId,
    name: options.name,
    address: "dynamic",
  });
  await syncthingRequest(
    `/rest/cluster/pending/devices?device=${encodeURIComponent(normalizeDeviceId(options.deviceId))}`,
    { method: "DELETE" }
  ).catch(() => undefined);
}

export async function getSyncthingEvents(since: number): Promise<Array<{ id?: number; type?: string; data?: unknown }>> {
  const query = new URLSearchParams({
    since: String(since),
    timeout: "30",
    events: "ItemFinished,FolderCompletion,StateChanged,RemoteIndexUpdated,DeviceConnected,DeviceDisconnected,FolderErrors",
  });
  return syncthingRequest(`/rest/events?${query}`, {}, 40_000);
}

export function isSyncthingRuntimeConfigured(): boolean {
  return syncthingConfigured();
}
