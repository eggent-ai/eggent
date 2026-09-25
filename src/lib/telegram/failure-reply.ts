import { redactSecrets } from "@/lib/pi/provider-failure";

/**
 * Long enough for the runtime's own sentence plus the models a provider still
 * lists, short enough to read on a phone.
 */
export const MAX_FAILURE_REPLY_CHARS = 600;

/**
 * What a person in Telegram is told when their message could not be answered.
 *
 * The runtime already words a failed turn for a human - the provider answered
 * but does not offer the model, and here is what it does offer - and over
 * Telegram that sentence ended in the container log. Secrets are cut out
 * because error bodies echo request material, and the text is capped because
 * some runtimes hand back a whole JSON document as their message.
 */
export function agentFailureText(error: unknown, fallback: string): string {
    const raw =
        error instanceof Error ? error.message : typeof error === "string" ? error : "";
    const text = redactSecrets(raw).trim();
    if (!text) return fallback;
    if (text.length <= MAX_FAILURE_REPLY_CHARS) return text;
    return `${text.slice(0, MAX_FAILURE_REPLY_CHARS - 1).trimEnd()}…`;
}
