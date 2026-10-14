import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import crypto from "node:crypto";
import { cloudTranscriptionTarget, transcribeInCloud } from "@/lib/speech/cloud-transcriber";

const execFileAsync = promisify(execFile);

const DATA_DIR = path.join(process.cwd(), "data");
const SPEECH_TMP_DIR = path.join(DATA_DIR, "tmp", "speech");
const DEFAULT_MODEL_NAME = "base";
const MODEL_URLS: Record<string, string> = {
  tiny: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
  base: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
  small: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
  medium: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
};

export interface SpeechTranscriptionResult {
  transcript: string;
  /** The local model file, or "cloud" when the gateway transcribed it. */
  modelPath: string;
  language: string;
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return defaultValue;
  return !["0", "false", "no", "off"].includes(value);
}

function getConfiguredModelName(): string {
  return (process.env.EGGENT_STT_MODEL || DEFAULT_MODEL_NAME).trim() || DEFAULT_MODEL_NAME;
}

function getDefaultModelPath(): string {
  const modelName = getConfiguredModelName();
  return path.join(DATA_DIR, "models", "whisper", `ggml-${modelName}.bin`);
}

function getModelPath(): string {
  return process.env.EGGENT_STT_MODEL_PATH?.trim() || getDefaultModelPath();
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadFile(url: string, targetPath: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download speech model (${response.status})`);
  }

  const tmpPath = `${targetPath}.download`;
  const reader = response.body.getReader();
  const handle = await fs.open(tmpPath, "w");
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await handle.write(Buffer.from(value));
    }
  } finally {
    await handle.close();
  }
  await fs.rename(tmpPath, targetPath);
}

async function ensureModel(): Promise<string> {
  const modelPath = getModelPath();
  if (await fileExists(modelPath)) {
    return modelPath;
  }

  const autoDownload = envFlag("EGGENT_STT_AUTO_DOWNLOAD_MODEL", true);
  if (!autoDownload) {
    throw new Error(
      `Speech model not found: ${modelPath}. Set EGGENT_STT_MODEL_PATH or place a whisper.cpp ggml model there.`
    );
  }

  const modelName = getConfiguredModelName();
  const url = MODEL_URLS[modelName];
  if (!url) {
    throw new Error(
      `Unknown EGGENT_STT_MODEL "${modelName}". Use one of: ${Object.keys(MODEL_URLS).join(", ")} or set EGGENT_STT_MODEL_PATH.`
    );
  }

  await downloadFile(url, modelPath);
  return modelPath;
}

async function findExecutable(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["--help"], { timeout: 5000, maxBuffer: 1024 * 1024 });
      return candidate;
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      if (err.code !== "ENOENT") {
        return candidate;
      }
    }
  }
  return null;
}

async function getWhisperBinary(): Promise<string> {
  const configured = process.env.EGGENT_STT_BINARY?.trim();
  const binary = configured || await findExecutable(["whisper-cli", "whisper.cpp", "main"]);
  if (!binary) {
    throw new Error(
      "Local speech transcription is not installed. Install whisper.cpp and make `whisper-cli` available, or set EGGENT_STT_BINARY."
    );
  }
  return binary;
}

async function getFfmpegBinary(): Promise<string> {
  const configured = process.env.EGGENT_FFMPEG_BINARY?.trim();
  const binary = configured || await findExecutable(["ffmpeg"]);
  if (!binary) {
    throw new Error("ffmpeg is required for speech transcription. Install ffmpeg or set EGGENT_FFMPEG_BINARY.");
  }
  return binary;
}

function safeExtension(filename: string, mimeType?: string): string {
  const ext = path.extname(filename).replace(/[^a-zA-Z0-9.]/g, "").slice(0, 12);
  if (ext) return ext;
  const lower = (mimeType || "").toLowerCase();
  if (lower.includes("ogg") || lower.includes("opus")) return ".ogg";
  if (lower.includes("webm")) return ".webm";
  if (lower.includes("wav")) return ".wav";
  if (lower.includes("mpeg") || lower.includes("mp3")) return ".mp3";
  if (lower.includes("mp4") || lower.includes("m4a")) return ".m4a";
  return ".audio";
}

function normalizeTranscript(text: string): string {
  return text
    .replace(/\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLanguage(value?: string): string {
  const language = value?.trim().toLowerCase() || "auto";
  if (["", "detect", "detected", "auto-detect", "autodetect"].includes(language)) return "auto";
  return language;
}

async function normalizeAudio(inputPath: string, outputPath: string): Promise<void> {
  const ffmpeg = await getFfmpegBinary();
  const timeout = Number(process.env.EGGENT_STT_FFMPEG_TIMEOUT_MS || 120_000);
  await execFileAsync(ffmpeg, [
    "-y",
    "-i", inputPath,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-f", "wav",
    outputPath,
  ], { timeout, maxBuffer: 4 * 1024 * 1024 });
}

async function runWhisper(params: {
  wavPath: string;
  outputPrefix: string;
  modelPath: string;
  language: string;
}): Promise<string> {
  const whisper = await getWhisperBinary();
  const timeout = Number(process.env.EGGENT_STT_TIMEOUT_MS || 300_000);
  const language = normalizeLanguage(params.language);
  const args = [
    "-m", params.modelPath,
    "-f", params.wavPath,
    "-otxt",
    "-of", params.outputPrefix,
    "-nt",
    // Be explicit. whisper.cpp commonly defaults to English when -l is
    // omitted; for non-English speech that can produce English output. `auto`
    // keeps transcription in the detected original language and does not enable
    // translation.
    "-l", language,
  ];

  await execFileAsync(whisper, args, { timeout, maxBuffer: 16 * 1024 * 1024 });
  const transcriptPath = `${params.outputPrefix}.txt`;
  const content = await fs.readFile(transcriptPath, "utf-8");
  return normalizeTranscript(content);
}

export async function transcribeAudioBuffer(params: {
  buffer: Buffer;
  filename: string;
  mimeType?: string;
  language?: string;
}): Promise<SpeechTranscriptionResult> {
  if (!envFlag("EGGENT_STT_ENABLED", true)) {
    throw new Error("Local speech transcription is disabled.");
  }

  const maxBytes = Number(process.env.EGGENT_STT_MAX_BYTES || 50 * 1024 * 1024);
  if (params.buffer.byteLength > maxBytes) {
    throw new Error(`Audio file is too large (${params.buffer.byteLength} bytes). Max supported size is ${maxBytes} bytes.`);
  }

  await fs.mkdir(SPEECH_TMP_DIR, { recursive: true });
  const id = crypto.randomUUID();
  const ext = safeExtension(params.filename, params.mimeType);
  const inputPath = path.join(SPEECH_TMP_DIR, `${id}${ext}`);
  // Its own name: an uploaded .wav is saved as `${id}.wav`, and ffmpeg refuses
  // to write its output over its input.
  const wavPath = path.join(SPEECH_TMP_DIR, `${id}.16k.wav`);
  const outputPrefix = path.join(SPEECH_TMP_DIR, `${id}`);
  const keepAudio = envFlag("EGGENT_STT_KEEP_AUDIO", false);
  const language = normalizeLanguage(params.language || process.env.EGGENT_STT_LANGUAGE);

  // The included model's gateway first, when this workspace runs on it; local
  // whisper for everyone else and whenever the gateway does not answer.
  const target = await cloudTranscriptionTarget().catch(() => null);
  if (target) {
    const transcript = await transcribeInCloud(target, { buffer: params.buffer, extension: ext, mimeType: params.mimeType, language });
    if (transcript) return { transcript: normalizeTranscript(transcript), modelPath: "cloud", language };
  }

  try {
    const modelPath = await ensureModel();
    await fs.writeFile(inputPath, params.buffer);
    await normalizeAudio(inputPath, wavPath);
    const transcript = await runWhisper({ wavPath, outputPrefix, modelPath, language });
    if (!transcript) {
      throw new Error("Speech transcription produced an empty transcript.");
    }
    return { transcript, modelPath, language };
  } finally {
    if (!keepAudio) {
      await Promise.allSettled([
        fs.rm(inputPath, { force: true }),
        fs.rm(wavPath, { force: true }),
        fs.rm(`${outputPrefix}.txt`, { force: true }),
      ]);
    }
  }
}

export async function transcribeAudioFile(params: {
  filePath: string;
  filename?: string;
  mimeType?: string;
  language?: string;
}): Promise<SpeechTranscriptionResult> {
  const buffer = await fs.readFile(params.filePath);
  return transcribeAudioBuffer({
    buffer,
    filename: params.filename || path.basename(params.filePath),
    mimeType: params.mimeType,
    language: params.language,
  });
}
