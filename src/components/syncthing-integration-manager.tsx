"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  HardDrive,
  Link2,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { copyTextToClipboard } from "@/lib/utils";

interface SyncthingPeer {
  deviceId: string;
  name: string;
  connected: boolean;
  address?: string;
  connectionType?: string;
  clientVersion?: string;
  paused: boolean;
}

interface SyncthingStatus {
  available: boolean;
  error?: string;
  enabled: boolean;
  paused: boolean;
  localDeviceId?: string;
  folder?: {
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
  peers: SyncthingPeer[];
  pendingDevices: Array<{
    deviceId: string;
    name?: string;
    address?: string;
    time?: string;
  }>;
  conflicts: string[];
  ignorePatterns: string[];
}

type Action = "enable" | "pause" | "resume" | "pair" | "accept" | "remove";

function formatBytes(value: number): string {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function statusLabel(status: SyncthingStatus | null): string {
  if (!status?.available) return "Unavailable";
  if (!status.enabled && !status.paused) return "Not enabled";
  if (status.paused) return "Paused";
  if (status.conflicts.length > 0) return "Conflict detected";
  if ((status.folder?.needFiles ?? 0) > 0) return "Syncing";
  if (status.folder?.state === "idle") return "Up to date";
  return status.folder?.state || "Starting";
}

export function SyncthingIntegrationManager() {
  const [status, setStatus] = useState<SyncthingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [copied, setCopied] = useState(false);

  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch("/api/integrations/syncthing/status", { cache: "no-store" });
      const data = (await response.json()) as SyncthingStatus;
      setStatus(data);
      if (data.available) {
        setError(null);
      } else if (data.error) {
        setError(data.error);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load sync status.");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    const timer = window.setInterval(() => void loadStatus(true), 5_000);
    return () => window.clearInterval(timer);
  }, [loadStatus]);

  const runAction = useCallback(async (
    nextAction: Action,
    payload: { deviceId?: string; name?: string; address?: string } = {}
  ) => {
    setAction(nextAction);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch("/api/integrations/syncthing/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: nextAction, ...payload }),
      });
      const data = (await response.json()) as { status?: SyncthingStatus; error?: string };
      if (!response.ok) throw new Error(data.error || "Sync action failed.");
      if (data.status) setStatus(data.status);
      if (nextAction === "pair" || nextAction === "accept") {
        setDeviceId("");
        setDeviceName("");
      }
      setSuccess(
        nextAction === "pair" || nextAction === "accept"
          ? "Device added. Add/accept this device on the other Eggent if it is not connected yet."
          : nextAction === "enable"
            ? "Eggent data sync enabled."
            : "Sync settings updated."
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sync action failed.");
    } finally {
      setAction(null);
    }
  }, []);

  const copyDeviceId = useCallback(async () => {
    if (!status?.localDeviceId) return;
    if (await copyTextToClipboard(status.localDeviceId)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    }
  }, [status?.localDeviceId]);

  const label = statusLabel(status);
  const connectedPeers = status?.peers.filter((peer) => peer.connected).length ?? 0;

  return (
    <section className="rounded-xl border bg-card p-5 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <HardDrive className="size-5" />
          </div>
          <div>
            <h3 className="text-lg font-semibold">Device sync</h3>
            <p className="text-sm text-muted-foreground">
              Active-active file synchronization between Eggent installations, powered by Syncthing.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`size-2 rounded-full ${
            !status?.available
              ? "bg-muted-foreground"
              : status.conflicts.length > 0
                ? "bg-destructive"
                : status.enabled && !status.paused
                  ? "bg-emerald-500"
                  : "bg-amber-500"
          }`} />
          <span className="text-sm font-medium">{loading ? "Loading..." : label}</span>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {success ? (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          {success}
        </div>
      ) : null}

      {status?.available ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Peers</div>
              <div className="mt-1 text-lg font-semibold">{connectedPeers}/{status.peers.length}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Local files</div>
              <div className="mt-1 text-lg font-semibold">{status.folder?.localFiles ?? 0}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Pending</div>
              <div className="mt-1 text-lg font-semibold">
                {status.folder?.needFiles ?? 0} · {formatBytes(status.folder?.needBytes ?? 0)}
              </div>
            </div>
          </div>

          {!status.enabled && !status.paused ? (
            <div className="rounded-lg border bg-muted/20 p-4 space-y-3">
              <div>
                <h4 className="font-medium">Enable synchronization</h4>
                <p className="text-sm text-muted-foreground">
                  Creates a Send &amp; Receive folder for Eggent data with local secrets, caches,
                  Telegram runtime, schedules, virtual environments, and dependencies excluded.
                </p>
              </div>
              <Button onClick={() => void runAction("enable")} disabled={action !== null} className="gap-2">
                {action === "enable" ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                Enable Sync
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {status.paused ? (
                <Button onClick={() => void runAction("resume")} disabled={action !== null} className="gap-2">
                  <Play className="size-4" /> Resume
                </Button>
              ) : (
                <Button variant="outline" onClick={() => void runAction("pause")} disabled={action !== null} className="gap-2">
                  <Pause className="size-4" /> Pause
                </Button>
              )}
              <Button variant="outline" onClick={() => void loadStatus()} disabled={loading} className="gap-2">
                <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /> Refresh
              </Button>
            </div>
          )}

          <div className="rounded-lg border p-4 space-y-3">
            <div>
              <div className="text-xs font-mono text-muted-foreground">this Eggent device</div>
              <h4 className="font-medium">Device ID</h4>
              <p className="text-xs text-muted-foreground">
                This is a public identifier, not a password. Copy it to the other Eggent.
              </p>
            </div>
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md bg-muted p-3 text-xs">
                {status.localDeviceId || "Unavailable"}
              </code>
              <Button variant="outline" size="icon" onClick={copyDeviceId} disabled={!status.localDeviceId}>
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
          </div>

          {status.pendingDevices.length > 0 ? (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
              <h4 className="font-medium">Connection requests</h4>
              {status.pendingDevices.map((pending) => (
                <div key={pending.deviceId} className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-background p-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{pending.name || "New Syncthing device"}</div>
                    <code className="block max-w-full truncate text-xs text-muted-foreground">{pending.deviceId}</code>
                  </div>
                  <Button size="sm" onClick={() => void runAction("accept", { deviceId: pending.deviceId, name: pending.name })} disabled={action !== null}>
                    Accept
                  </Button>
                </div>
              ))}
            </div>
          ) : null}

          <div className="rounded-lg border p-4 space-y-4">
            <div>
              <h4 className="font-medium">Add another Eggent</h4>
              <p className="text-sm text-muted-foreground">
                Enable Sync on both computers, then paste the other Device ID here. The other side can accept the request.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-[1fr_220px_auto]">
              <div className="space-y-1.5">
                <Label htmlFor="syncthing-device-id">Peer Device ID</Label>
                <Input
                  id="syncthing-device-id"
                  value={deviceId}
                  onChange={(event) => setDeviceId(event.target.value)}
                  placeholder="XXXXXXX-XXXXXXX-..."
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="syncthing-device-name">Device name</Label>
                <Input
                  id="syncthing-device-name"
                  value={deviceName}
                  onChange={(event) => setDeviceName(event.target.value)}
                  placeholder="Office PC"
                />
              </div>
              <Button
                className="self-end gap-2"
                onClick={() => void runAction("pair", { deviceId, name: deviceName })}
                disabled={action !== null || !deviceId.trim()}
              >
                {action === "pair" ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
                Add
              </Button>
            </div>
          </div>

          {status.peers.length > 0 ? (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Connected devices</h4>
              {status.peers.map((peer) => (
                <div key={peer.deviceId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`size-2 rounded-full ${peer.connected ? "bg-emerald-500" : "bg-muted-foreground"}`} />
                      <span className="text-sm font-medium">{peer.name}</span>
                      <span className="text-xs text-muted-foreground">{peer.connected ? "Connected" : "Offline"}</span>
                    </div>
                    <code className="mt-1 block max-w-[600px] truncate text-xs text-muted-foreground">{peer.deviceId}</code>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive"
                    title="Remove device"
                    onClick={() => void runAction("remove", { deviceId: peer.deviceId })}
                    disabled={action !== null}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          ) : null}

          {status.conflicts.length > 0 ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 space-y-2">
              <div className="flex items-center gap-2 font-medium text-destructive">
                <AlertTriangle className="size-4" /> Sync conflicts
              </div>
              <p className="text-sm text-muted-foreground">
                These files were modified on multiple devices. Syncthing preserved both versions; review them manually.
              </p>
              <ul className="max-h-32 overflow-y-auto space-y-1 font-mono text-xs">
                {status.conflicts.map((file) => <li key={file}>{file}</li>)}
              </ul>
            </div>
          ) : null}

          <details className="rounded-lg border p-4 text-sm">
            <summary className="cursor-pointer font-medium">What is not synchronized</summary>
            <p className="mt-2 text-muted-foreground">
              Credentials, app settings, Pi auth/packages, Telegram runtime, scheduled task runtime,
              caches, dependencies, virtual environments, and <span className="font-mono">.env*</span> files stay local.
              Project content, chats, chat files, memory, pipelines, run artifacts, and Pi chat sessions are synchronized.
            </p>
          </details>
        </>
      ) : loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Connecting to Syncthing...
        </div>
      ) : (
        <div className="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
          Docker deployments include the Syncthing sidecar. Rebuild and restart the stack to make it available.
          Native deployments can set <span className="font-mono">SYNCTHING_URL</span> and <span className="font-mono">SYNCTHING_API_KEY</span>.
        </div>
      )}
    </section>
  );
}
