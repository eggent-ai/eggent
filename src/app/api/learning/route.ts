import { NextRequest } from "next/server";
import { applyNoteOps } from "@/lib/learning/notes";
import { readLearningView } from "@/lib/learning/view";
import { learningAvailable } from "@/lib/learning/config";
import { getSettings, saveSettings } from "@/lib/storage/settings-store";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";

/**
 * What the agent has learned, for the settings page: read it, switch learning
 * on or off, and add or remove a note by hand.
 *
 * The notes are read by the agent at the start of every conversation, so a
 * write here is a write into its instructions. It therefore wants what the
 * shell routes want - a signed-in session of this site, and a JSON body a
 * foreign page cannot send without a preflight - on top of the middleware.
 */

export async function GET(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: false });
  if (failure) return jsonError("Not allowed.", guardStatus(failure));
  return Response.json(await readLearningView(), { headers: { "Cache-Control": "no-store" } });
}

interface Body {
  enabled?: unknown;
  action?: unknown;
  target?: unknown;
  content?: unknown;
  text?: unknown;
}

export async function POST(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: true });
  if (failure) return jsonError("Not allowed.", guardStatus(failure));

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body || typeof body !== "object") return jsonError("Send a JSON object.", 400);

  if (typeof body.enabled === "boolean") {
    if (!learningAvailable()) return jsonError("Learning is switched off for this workspace.", 409);
    const current = await getSettings();
    await saveSettings({ learning: { ...current.learning, enabled: body.enabled } });
    return Response.json(await readLearningView(), { headers: { "Cache-Control": "no-store" } });
  }

  if (body.target !== "user" && body.target !== "notes") return jsonError('target must be "user" or "notes".', 400);

  if (body.action === "add" && typeof body.content === "string") {
    const result = await applyNoteOps([{ action: "add", target: body.target, content: body.content }], { source: "user" });
    if (!result.ok) return Response.json({ error: result.reason, code: result.code }, { status: 422 });
    return Response.json(await readLearningView(), { headers: { "Cache-Control": "no-store" } });
  }

  if (body.action === "remove" && typeof body.text === "string") {
    const result = await applyNoteOps([{ action: "remove", target: body.target, match: body.text, exact: true }], { source: "user" });
    if (!result.ok) return Response.json({ error: result.reason, code: result.code }, { status: 422 });
    return Response.json(await readLearningView(), { headers: { "Cache-Control": "no-store" } });
  }

  return jsonError("Unknown request.", 400);
}
