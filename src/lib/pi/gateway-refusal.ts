/**
 * The id the deployment's model gateway gives the answer it writes in place of
 * a model's when it turns a request away (a limit reached, the disk full). Such
 * an answer is a well-formed reply that finishes normally and spent nothing, so
 * to the runtime, to the scheduler and to the store the run looks like a
 * success: the id is the one thing that tells them apart. The gateway's own
 * test pins the prefix.
 */
export const GATEWAY_REFUSAL_ID_PREFIX = "eggent_limit_";

/** Whether an assistant message, as the runtime reports it, is the gateway saying no. */
export function isGatewayRefusal(message: { responseId?: unknown } | null | undefined): boolean {
  return typeof message?.responseId === "string" && message.responseId.startsWith(GATEWAY_REFUSAL_ID_PREFIX);
}
