/**
 * The words a terminal route answers with, in the workspace's language.
 */
import type { NextRequest } from "next/server";
import { getServerTranslator } from "@/i18n/server";
import { guardStatus, jsonError, type GuardFailure } from "@/lib/terminal/guard";

export async function failureResponse(
  req: NextRequest,
  failure: GuardFailure | "not-found"
): Promise<Response> {
  const t = await getServerTranslator(req.headers.get("accept-language"));
  if (failure === "not-found") return jsonError(t("api.error.terminalNotFound"), 404);
  const message =
    failure === "unauthorized"
      ? t("api.error.unauthorized")
      : failure === "origin"
        ? t("api.error.terminalOrigin")
        : t("api.error.terminalJsonRequired");
  return jsonError(message, guardStatus(failure));
}
