export type PiInteractionKind =
  | "terminal_input"
  | "oauth_url"
  | "device_code"
  | "text"
  | "secret"
  | "select"
  | "confirm";

export type PiInteractionStatus = "pending" | "completed" | "cancelled" | "expired";

export interface PiPendingInteraction {
  id: string;
  runId: string;
  kind: PiInteractionKind;
  status: PiInteractionStatus;
  title: string;
  message?: string;
  placeholder?: string;
  options?: string[];
  /** Folded under the question: the technical detail behind it, for whoever wants to check. */
  details?: string;
  /** A decision only the person makes (an approval): no "decide for me" and no "skip". */
  decisionOnly?: boolean;
  timeoutMs?: number;
  createdAt: string;
  updatedAt: string;
}

export interface PiInteractionResponse {
  value?: string | boolean | null;
  cancel?: boolean;
}

/**
 * Sent when the user presses "decide for me".
 *
 * A marker rather than a phrase, so the answer reads identically to the model
 * whatever language the button was labelled in.
 */
export const DEFER_INTERACTION_ANSWER = "__eggent_decide_for_me__";
