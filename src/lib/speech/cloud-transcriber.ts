/**
 * Speech to text through the included model's gateway.
 *
 * Only while the workspace runs on the included model: the gateway bills the
 * recording to the same balance as everything else, and a workspace that moved
 * to its own provider has said where its AI comes from. Anything that does not
 * end in a transcript - no gateway, a refusal, a timeout - returns null and the
 * caller transcribes locally, so a voice message is never lost to a wall.
 */

/** The gateway's own ceiling on one recording. */
export const CLOUD_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;

/** Containers the gateway's upstream accepts as they are. */
const ACCEPTED_EXTENSIONS = new Set([".webm", ".ogg", ".mp3", ".mp4", ".m4a", ".wav", ".flac", ".mpeg", ".mpga"]);

export interface CloudTarget {
  url: string;
  token: string;
}

export interface CloudTranscriptionInput {
  buffer: Buffer;
  /** With its dot, as the transcriber already derived it. */
  extension: string;
  mimeType?: string;
  /** "auto" or a two-letter code. */
  language: string;
}

function cloudDisabled(): boolean {
  const value = process.env.EGGENT_STT_CLOUD?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "off" || value === "no";
}

/** Where to send a recording, or null when this workspace is not on the included model. */
export async function cloudTranscriptionTarget(): Promise<CloudTarget | null> {
  if (cloudDisabled()) return null;
  const { managedGatewayBaseUrl } = await import("@/lib/pi/managed-models");
  const base = managedGatewayBaseUrl();
  if (!base) return null;
  const { getEggentAiModelLockState, getManagedGatewayToken } = await import("@/lib/pi/config-store");
  if (!(await getEggentAiModelLockState()).locked) return null;
  const token = await getManagedGatewayToken();
  if (!token) return null;
  return { url: `${base.replace(/\/+$/, "")}/audio/transcriptions`, token };
}

/**
 * The name and type the recording is sent under.
 *
 * Telegram's voice notes are `.oga`, which is Ogg Opus under a name the
 * upstream does not know; anything else unknown is left to local transcription.
 */
export function cloudUploadName(extension: string, mimeType?: string): { filename: string; mimeType: string } | null {
  const ext = extension.toLowerCase();
  const mapped = ext === ".oga" || ext === ".opus" ? ".ogg" : ext;
  if (!ACCEPTED_EXTENSIONS.has(mapped)) return null;
  // A browser recording says `audio/webm;codecs=opus`; the parameters stay here.
  const base = mimeType?.split(";")[0].trim().toLowerCase();
  const type = base && /^audio\/[\w.+-]+$/.test(base)
    ? base
    : `audio/${mapped === ".m4a" ? "mp4" : mapped === ".mp3" ? "mpeg" : mapped.slice(1)}`;
  return { filename: `voice${mapped}`, mimeType: type };
}

/**
 * Transcribe in the cloud, or return null with the reason logged.
 *
 * `fetchImpl` is for tests; the request itself is the whole contract with the
 * gateway: JSON with the recording in base64, the transcript back as `text`.
 */
export async function transcribeInCloud(
  target: CloudTarget,
  input: CloudTranscriptionInput,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<string | null> {
  if (input.buffer.byteLength === 0 || input.buffer.byteLength > CLOUD_TRANSCRIPTION_MAX_BYTES) return null;
  const upload = cloudUploadName(input.extension, input.mimeType);
  if (!upload) return null;
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? Number(process.env.EGGENT_STT_CLOUD_TIMEOUT_MS || 60_000);
  try {
    const response = await fetchImpl(target.url, {
      method: "POST",
      headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        audio: input.buffer.toString("base64"),
        filename: upload.filename,
        mime_type: upload.mimeType,
        language: input.language,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      console.warn(`[speech] cloud transcription refused (${response.status}), transcribing locally: ${errorMessage(text)}`);
      return null;
    }
    const parsed = JSON.parse(text) as { text?: unknown };
    const transcript = typeof parsed.text === "string" ? parsed.text.trim() : "";
    return transcript || null;
  } catch (error) {
    console.warn(`[speech] cloud transcription failed, transcribing locally: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") return parsed.error.message.slice(0, 200);
  } catch {
    // not JSON
  }
  return body.slice(0, 200);
}
