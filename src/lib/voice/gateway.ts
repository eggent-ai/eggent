/**
 * Voice calls with the agent, through the deployment.
 *
 * The workspace holds no voice model of its own: a deployment that offers one
 * says where with EGGENT_VOICE_API_URL and is reached with the same token as
 * its other services. It hands out a short-lived secret the person's browser
 * connects to the voice model with, and times the call from the beats this
 * workspace passes on. Without that address no call button is shown.
 */

export function voiceApiUrl(): string {
  return (process.env.EGGENT_VOICE_API_URL || "").trim().replace(/\/+$/, "");
}

function voiceToken(): string {
  return (process.env.EGGENT_USAGE_API_TOKEN || "").trim();
}

export function voiceAvailable(): boolean {
  return Boolean(voiceApiUrl() && voiceToken());
}

export interface VoiceAnswer {
  ok: boolean;
  status: number;
  json: Record<string, unknown>;
}

export async function voiceRequest(method: string, suffix: string): Promise<VoiceAnswer> {
  const response = await fetch(`${voiceApiUrl()}${suffix}`, {
    method,
    headers: { authorization: `Bearer ${voiceToken()}` },
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, json };
}

/** A call id as the deployment writes it: 32 hex characters, nothing that could walk a path. */
export function isCallId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}
