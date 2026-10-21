/**
 * Why a program of this computer cannot take a turn, said in the person's
 * words - one place for the two that need it: the tool that runs the turn
 * here, and the refusal a computer sends back when the cloud hands it a chat.
 */
import type { MessageKey, MessageValues } from "@/i18n/messages";
import type { EngineErrorCode } from "@/lib/engines/host-types";
import type { EngineStatus } from "@/lib/engines/types";

export type EngineTranslator = (key: MessageKey, values?: MessageValues) => string;

/** The messages for the failures a run can end in; a lost session is retried, never shown. */
export const ENGINE_ERROR_MESSAGE: Record<Exclude<EngineErrorCode, "session-lost">, MessageKey> = {
  "not-installed": "engines.error.notInstalled",
  "signed-out": "engines.error.signedOut",
  limit: "engines.error.limit",
  "unsupported-model": "engines.error.unsupportedModel",
  "api-key": "engines.error.apiKey",
  timeout: "engines.error.timeout",
  failed: "engines.error.failed",
};

/** The failure a status that is not "ready" stands for. */
export function codeForStatus(status: EngineStatus): EngineErrorCode {
  if (status.state === "not-installed") return "not-installed";
  if (status.state === "signed-out") return "signed-out";
  if (status.code === "api-key") return "api-key";
  if (status.code === "limit") return "limit";
  return "failed";
}

/** What to tell the person when the program is not ready before anything is started. */
export function explainBlockedStatus(status: EngineStatus, label: string, t: EngineTranslator): { code: EngineErrorCode; text: string } {
  const code = codeForStatus(status);
  if (code === "failed") return { code, text: t("engines.error.problem", { engine: label, detail: status.detail ?? "not ready" }) };
  return { code, text: t(ENGINE_ERROR_MESSAGE[code as Exclude<EngineErrorCode, "session-lost">], { engine: label, until: "", detail: "" }) };
}

/**
 * The same, as a short reason that stands on its own: for a computer to tell
 * another side why it cannot take a chat. It says nothing of "this computer",
 * since it is read on a screen that is somewhere else.
 */
export function engineBlockedReason(status: EngineStatus, label: string, t: EngineTranslator): string {
  switch (codeForStatus(status)) {
    case "not-installed":
      return t("engines.reason.notInstalled", { engine: label });
    case "signed-out":
      return t("engines.reason.signedOut", { engine: label });
    case "api-key":
      return t("engines.reason.apiKey", { engine: label });
    case "limit":
      return t("engines.reason.limit", { engine: label });
    default:
      return t("engines.reason.problem", { engine: label, detail: status.detail ?? "not ready" });
  }
}
