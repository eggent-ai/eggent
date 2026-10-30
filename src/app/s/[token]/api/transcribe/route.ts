import type { NextRequest } from "next/server";
import { transcribeAudioBuffer } from "@/lib/speech/transcriber";
import { fail, linkContext, NO_STORE, withinLimit } from "@/lib/public-chat/route-helpers";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const PER_HOUR = 30;

/** POST /s/<token>/api/transcribe (form: file) -> {transcript}: a visitor's voice, into the field. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const context = await linkContext(req, (await params).token, { write: true });
  if (context instanceof Response) return context;
  const { token, visitor } = context;
  if (!visitor) return fail("Write your name and email first.", 401, "noVisitor");
  if (Number(req.headers.get("content-length") || 0) > MAX_AUDIO_BYTES + 64 * 1024) return fail("The recording is too long.", 413, "tooLarge");
  if (!withinLimit("transcribe", `${token}:${visitor.id}`, PER_HOUR)) return fail("Too many recordings in an hour. Type instead.", 429, "rateLimited");
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return fail("No recording arrived.", 400, "noFile");
    if (file.size > MAX_AUDIO_BYTES) return fail("The recording is too long.", 413, "tooLarge");
    const result = await transcribeAudioBuffer({
      buffer: Buffer.from(await file.arrayBuffer()),
      filename: file.name || "audio.webm",
      mimeType: file.type,
      language: "auto",
    });
    return Response.json({ success: true, transcript: result.transcript }, { headers: NO_STORE });
  } catch (error) {
    console.error("[public-chat] transcription failed:", error instanceof Error ? error.message : error);
    return fail("The recording could not be turned into text. Type instead.", 500, "failed");
  }
}
