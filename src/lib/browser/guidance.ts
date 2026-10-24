import { browserAvailable, browserCliPresent } from "@/lib/browser/config";
import { historyCliDir } from "@/lib/files/versions/service";

/**
 * The line in the agent's shared instructions about the browser, or nothing.
 * It goes in only where the browser exists, because it is billed on every
 * request and a tool the agent cannot use is a tool it will try.
 */
export function browserGuidance(): string {
  if (!browserAvailable() || !browserCliPresent(historyCliDir())) return "";
  return [
    "- Browser: a real browser on a machine of its own, driven with `eggent-browser` in bash (`eggent-browser help` lists the commands: open a page, read it as a numbered list of what can be clicked or typed into plus its text, click, type, press keys, scroll, take a screenshot, close).",
    "Use it when fetch_content is not enough: a page that needs clicks, forms, scrolling, several steps or a sign-in. The user can watch it in the Browser panel (the globe button in the top right) and take control there:",
    "for a password, a one-time code or a captcha, ask them to do that step in the panel themselves and to hand control back - never ask for a password in the chat. Sign-ins are kept between sessions.",
    "Close it with `eggent-browser close` when the task is done: its minutes are limited.",
  ].join(" ");
}
