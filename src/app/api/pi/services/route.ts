import { NextRequest } from "next/server";
import { getPiModelsState, setServiceChoice, type ServiceChoice } from "@/lib/pi/config-store";
import { checkTerminalRequest, guardStatus, jsonError } from "@/lib/terminal/guard";

/**
 * Who draws, transcribes voice and looks back on chats, for a workspace on its
 * own model: the included model, a provider of its own, or the default here.
 *
 * Turning the included model on spends its balance, so the write wants what
 * the other settings that cost something want - a signed-in session of this
 * site and a JSON body a foreign page cannot send without a preflight - on top
 * of the middleware.
 */

interface Body {
  service?: unknown;
  use?: unknown;
  provider?: unknown;
  model?: unknown;
}

function choiceFrom(body: Body): ServiceChoice | null {
  const use = typeof body.use === "string" ? body.use : "";
  const provider = typeof body.provider === "string" ? body.provider : "";
  const model = typeof body.model === "string" ? body.model : "";
  if (body.service === "images") {
    if (use === "off" || use === "eggent") return { service: "images", use };
    if (use === "provider") return { service: "images", use, provider, model };
  }
  if (body.service === "speech") {
    if (use === "local" || use === "eggent") return { service: "speech", use };
    if (use === "provider") return { service: "speech", use, provider, model };
  }
  if (body.service === "learning" && (use === "chat" || use === "eggent")) {
    return { service: "learning", use };
  }
  return null;
}

export async function PUT(req: NextRequest) {
  const failure = await checkTerminalRequest(req, { write: true });
  if (failure) return jsonError("Not allowed.", guardStatus(failure));

  const body = (await req.json().catch(() => null)) as Body | null;
  const choice = body && typeof body === "object" ? choiceFrom(body) : null;
  if (!choice) return jsonError("Name a service (images, speech, learning) and what should serve it.", 400);
  try {
    await setServiceChoice(choice);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to save the choice.", 400);
  }
  return Response.json(await getPiModelsState(), { headers: { "Cache-Control": "no-store" } });
}
