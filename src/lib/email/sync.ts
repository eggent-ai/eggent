import { fetchEmailList } from "@/lib/email/client";
import { getEmailConfig } from "@/lib/email/config";
import { rememberLetters, syncCursor } from "@/lib/email/store";

/**
 * Keeps the workspace's own list of its letters (data/email) while it is up:
 * shortly after boot and every few minutes, it asks the email service for
 * what came since the last letter it knows. A sleeping workspace asks nothing;
 * the service keeps its letters and the workspace catches up when it wakes.
 *
 * Nothing here starts the agent: a letter that comes in is told to the person
 * by the service, and the agent reads it when the person asks.
 */

const PAGE = 50;
const MAX_PAGES = 10;
const RUN_KEY = "__EGGENT_EMAIL_SYNC_RUN__";

export async function syncEmail(): Promise<{ added: number }> {
  if (getEmailConfig()?.mode !== "service") return { added: 0 };
  const holder = globalThis as typeof globalThis & { [RUN_KEY]?: Promise<{ added: number }> };
  if (holder[RUN_KEY]) return holder[RUN_KEY];
  const run = (async () => {
    let cursor = await syncCursor();
    let added = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const letters = await fetchEmailList({ after: cursor, limit: PAGE });
      if (!letters.length) break;
      const last = Math.max(...letters.map((letter) => letter.id));
      await rememberLetters(letters, last);
      added += letters.length;
      cursor = last;
      if (letters.length < PAGE) break;
    }
    return { added };
  })();
  holder[RUN_KEY] = run;
  try {
    return await run;
  } finally {
    if (holder[RUN_KEY] === run) delete holder[RUN_KEY];
  }
}

function syncIntervalMs(): number {
  const seconds = Number(process.env.EGGENT_EMAIL_SYNC_SECONDS);
  return Number.isFinite(seconds) && seconds >= 30 ? seconds * 1000 : 5 * 60_000;
}

export function startEmailSync(): void {
  if (getEmailConfig()?.mode !== "service") return;
  const KEY = "__EGGENT_EMAIL_SYNC_TIMER__";
  const holder = globalThis as typeof globalThis & { [KEY]?: boolean };
  if (holder[KEY]) return;
  holder[KEY] = true;
  const tick = () => {
    syncEmail()
      .then((result) => {
        if (result.added) console.log(`[email] letters listed: ${result.added}`);
      })
      .catch((error) => console.warn(`[email] sync: ${error instanceof Error ? error.message : error}`));
  };
  const first = setTimeout(tick, 30_000);
  (first as { unref?: () => void }).unref?.();
  const timer = setInterval(tick, syncIntervalMs());
  (timer as { unref?: () => void }).unref?.();
}
