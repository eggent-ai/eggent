import { NextRequest } from "next/server";
import { joinActiveRun } from "@/lib/pi/active-runs";
import { filesSentWith, steerModelText } from "@/lib/pi/steer";
import { isStoredMessageId } from "@/lib/pi/steer-shape";
import { AUTH_COOKIE_NAME } from "@/lib/auth/session";
import { verifyActiveSession } from "@/lib/auth/session-floor";
import { requestComesFromThisSite } from "@/lib/terminal/guard";

export const runtime = "nodejs";

/** Longer than anybody types; a paste of a whole document belongs in a file. */
const MAX_MESSAGE_CHARS = 100_000;

function answer(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Add a message to the turn working in this chat.
 *
 * The composer used to refuse anything while a turn ran, so the only way to
 * correct the agent was Stop: the answer in progress was thrown away and the
 * request typed again. This hands the message to the turn instead, which puts
 * it in front of the model after the step it is on.
 *
 * Answers what became of it:
 * - `steered`: the turn has it, and writes it down where its agent reads it;
 * - `stopped`: it was a stop word, and the turn is stopping;
 * - `refused`: a command, which a turn cannot take in the middle - it can be
 *   sent once the turn is over;
 * - `not-running`: there is no turn to add it to (it ended a moment ago, or is
 *   stopping), so the screen sends it as a turn of its own.
 *
 * Not through `/api/chat`: that answers with a stream, and the screen already
 * reads the turn's. A second stream for the same chat replaced the first one
 * on the screen.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ chatId: string }> }) {
  // Checked here as well as by the middleware, which lets some paths by (open issue 2). A page on a
  // sibling workspace is the same site, so a cookie alone is not enough: the request has to come from
  // this one, and carry JSON, which a foreign page cannot send without a preflight nobody answers.
  const cookie = req.cookies.get(AUTH_COOKIE_NAME)?.value || "";
  if (!cookie || !(await verifyActiveSession(cookie))) return answer({ error: "unauthorized" }, 401);
  if (!requestComesFromThisSite(req)) return answer({ error: "origin" }, 403);
  if (!/^application\/json\b/i.test(req.headers.get("content-type") || "")) return answer({ error: "json" }, 415);

  const { chatId } = await params;
  if (!isStoredMessageId(chatId)) return answer({ error: "Chat ID required" }, 400);

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return answer({ error: "The body is not JSON." }, 400);
  }

  const message = typeof body.message === "string" ? body.message : "";
  if (!message.trim()) return answer({ error: "Message required" }, 400);
  if (message.length > MAX_MESSAGE_CHARS) return answer({ error: "Message too long" }, 413);

  const messageId = isStoredMessageId(body.messageId) ? body.messageId : crypto.randomUUID();
  const files = await filesSentWith(chatId, body.files);
  const outcome = await joinActiveRun(chatId, message, {
    messageId,
    text: message,
    modelText: steerModelText(message, files),
    ...(files.length ? { files: files.map((file) => file.name) } : {}),
  });
  return answer({ status: outcome ?? "not-running", messageId });
}
