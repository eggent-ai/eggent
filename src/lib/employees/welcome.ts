/**
 * The first thing a new workspace says: a question in the chat, drawn without
 * the model, so it is there the moment the page is. It stands until the person
 * has anything here - a chat or an employee - and only where the deployment has
 * employees to offer; a self-hosted install has none and never sees it.
 */
import { hasAnyChat } from "@/lib/storage/chat-store";

export const FIRST_SHIFT_SKILL = "first-shift";

const EVENT = /^(shown|typed|skipped|apps|button:[a-z0-9-]{1,40})$/;

export function validWelcomeEvent(value: unknown): value is string {
  return typeof value === "string" && EVENT.test(value);
}

export async function welcomeDue(
  skills: ReadonlyArray<{ name: string; employee?: unknown }>,
  hired: number,
  onboardingPending: boolean
): Promise<boolean> {
  if (hired > 0 || onboardingPending) return false;
  if (!skills.some((skill) => skill.name === FIRST_SHIFT_SKILL)) return false;
  return !(await hasAnyChat().catch(() => true));
}

/** Tells the deployment which step was reached, when it asks to know. Never holds anything up. */
export async function reportWelcomeEvent(event: string): Promise<void> {
  const url = process.env.EGGENT_ONBOARDING_EVENT_URL?.trim();
  const token = process.env.EGGENT_SERVICES_TOKEN?.trim();
  if (!url || !token) return;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ event }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}
