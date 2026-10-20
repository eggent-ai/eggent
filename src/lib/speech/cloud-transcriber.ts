/**
 * Speech to text somewhere other than this server.
 *
 * Two places can take a recording: the included model's gateway, and a
 * provider the workspace connected with its own key. Which one - or neither -
 * is decided in one place (resolveSpeechBackend), by the same rule as images:
 * the gateway while the workspace runs on the included model, or when the
 * person turned it on for voice; the own provider when one was chosen; local
 * whisper otherwise. Anything that does not end in a transcript - a refusal, a
 * timeout, a provider that does not transcribe - returns null and the caller
 * transcribes locally, so a voice message is never lost to a wall.
 */

/** The gateway's own ceiling on one recording, and OpenAI's. */
export const CLOUD_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;

/** Containers the gateway's upstream accepts as they are. */
const ACCEPTED_EXTENSIONS = new Set([".webm", ".ogg", ".mp3", ".mp4", ".m4a", ".wav", ".flac", ".mpeg", ".mpga"]);

export interface CloudTarget {
  url: string;
  token: string;
}

/** A provider of the workspace's own: its transcription endpoint, key and model. */
export interface ProviderTarget extends CloudTarget {
  model: string;
  providerId: string;
}

export interface CloudTranscriptionInput {
  buffer: Buffer;
  /** With its dot, as the transcriber already derived it. */
  extension: string;
  mimeType?: string;
  /** "auto" or a two-letter code. */
  language: string;
}

export type SpeechTarget =
  | ({ kind: "eggent" } & CloudTarget)
  | ({ kind: "provider" } & ProviderTarget);

/** Where to send a recording, or null for whisper on this server. */
export async function speechTarget(): Promise<SpeechTarget | null> {
  const { resolveSpeechBackend } = await import("@/lib/pi/config-store");
  return resolveSpeechBackend();
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

/**
 * Transcribe with a provider of the workspace's own, or return null with the
 * reason logged.
 *
 * OpenAI's own request - a form with the file, the model, the language when it
 * is known - which every OpenAI-compatible service that transcribes accepts.
 * The key is the provider's, so nothing here is billed to the included model.
 */
export async function transcribeWithProvider(
  target: ProviderTarget,
  input: CloudTranscriptionInput,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<string | null> {
  if (input.buffer.byteLength === 0 || input.buffer.byteLength > CLOUD_TRANSCRIPTION_MAX_BYTES) return null;
  const upload = cloudUploadName(input.extension, input.mimeType);
  if (!upload) return null;
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? Number(process.env.EGGENT_STT_CLOUD_TIMEOUT_MS || 60_000);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(input.buffer)], { type: upload.mimeType }), upload.filename);
  form.append("model", target.model);
  if (input.language && input.language !== "auto") form.append("language", input.language);
  form.append("response_format", "json");
  try {
    const response = await fetchImpl(target.url, {
      method: "POST",
      headers: { authorization: `Bearer ${target.token}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      console.warn(`[speech] ${target.providerId} refused the recording (${response.status}), transcribing locally: ${errorMessage(text)}`);
      return null;
    }
    const parsed = JSON.parse(text) as { text?: unknown };
    const transcript = typeof parsed.text === "string" ? parsed.text.trim() : "";
    return transcript || null;
  } catch (error) {
    console.warn(`[speech] ${target.providerId} transcription failed, transcribing locally: ${error instanceof Error ? error.message : String(error)}`);
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
