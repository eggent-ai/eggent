import type { EmailSummary } from "@/lib/email/types";

/**
 * Who a letter is from, in the words both the agent and the person see.
 * Client-safe: the letter's page draws the same sentence the tool gives.
 */

export function senderOf(letter: Pick<EmailSummary, "from">): string {
  const address = letter.from.address || "unknown";
  return letter.from.name ? `${letter.from.name} <${address}>` : address;
}

/** Who a letter is from, as far as anybody could check, in words for the agent. */
export function trustOf(letter: EmailSummary): string {
  if (letter.direction === "out") return "sent by you";
  if (letter.folder === "bounce") return "a delivery report about a letter you sent";
  if (letter.fromOwner) return "from your person's own address, and the sender's mail server vouched for it";
  if (letter.suspicious) return `doubtful: ${letter.suspicious}`;
  if (letter.threadReply) return "a reply to a letter you sent; the sender is not checked further";
  if (letter.authenticated) return "the sender's mail server vouched for this address; who they are is not known";
  return "the sender could not be checked: anybody could have written this From line";
}
