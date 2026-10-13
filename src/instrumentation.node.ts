import { initTelegramLifecycle } from "@/lib/telegram/polling-lifecycle";
import { getManagedGatewayToken, refreshPiModelCatalog, syncManagedProviderCatalog } from "@/lib/pi/config-store";
import { managedGatewayBaseUrl, refreshManagedCatalog } from "@/lib/pi/managed-models";
import { restorePiSchedules } from "@/lib/pi/schedule-host";
import { sweepStoredChats } from "@/lib/secrets/sweep";
import { startChatsWatcher } from "@/lib/storage/chats-watcher";

// A chat written by the sync with a paired workspace or computer shows up on screen as it arrives.
startChatsWatcher();

initTelegramLifecycle().catch((error) => {
  console.error("Failed to initialize Telegram lifecycle:", error);
});

// Credentials already in stored chats are masked once per version of the shape
// list; new writes are masked as they happen (chat-store.ts).
function sweepChats(retryLater: boolean): void {
  // A chat used in the last half minute is left to its own next save, not rewritten under it.
  sweepStoredChats({ minAgeMs: 30_000 })
    .then((result) => {
      if (!result) return;
      console.log(`[Secrets] Stored chats checked: ${result.scanned}, masked: ${result.masked}${result.skipped ? `, left for their next save: ${result.skipped}` : ""}${result.failed ? `, unreadable: ${result.failed}` : ""}`);
      if (retryLater && result.retry.length > 0) {
        const timer = setTimeout(() => sweepChats(false), 2 * 60_000);
        (timer as { unref?: () => void }).unref?.();
      }
    })
    .catch((error) => {
      console.warn("Failed to sweep stored chats for credentials:", error);
    });
}
sweepChats(true);

// A scheduled job is armed inside a live session and dies with it, so without
// this every restart ends every schedule while its store still says enabled.
restorePiSchedules().catch((error) => {
  console.error("Failed to restore scheduled tasks:", error);
});

/**
 * Provider catalogs are refreshed here and nowhere else.
 *
 * Every other runtime is built offline so that a chat turn never waits on a
 * fetch, which leaves this the only thing keeping the choosable models in step
 * with what the providers actually serve. Set EGGENT_MODEL_CATALOG_REFRESH=0 on
 * a workspace that must not reach out at all.
 */
const MODEL_CATALOG_REFRESH_MS = 4 * 60 * 60 * 1000;

function modelCatalogRefreshEnabled(): boolean {
  const raw = process.env.EGGENT_MODEL_CATALOG_REFRESH?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

function refreshModelCatalog(): void {
  refreshPiModelCatalog()
    .then(({ providers, models }) => {
      console.log(`[Models] Catalog refreshed: ${models} models across ${providers} providers`);
    })
    .catch((error) => {
      console.warn(`[Models] Catalog refresh failed: ${error instanceof Error ? error.message : error}`);
    });
  refreshIncludedModelCatalog();
}

/**
 * Which models the included plan offers is the deployment's answer, not ours,
 * so it is fetched on the same schedule and for the same reason as the provider
 * catalogs above: a chat turn must not wait on it, and a workspace that cannot
 * reach the gateway keeps whatever it last knew.
 */
/**
 * Bring models.json in step with the catalog already on disk.
 *
 * Separate from the fetch, and outside the network switch, because it needs no
 * network: a workspace that cannot reach the gateway - or one told never to try
 * - would otherwise keep answering from a models.json that disagrees with the
 * list it already holds, which is the same "saved model resolves to nothing"
 * failure by a different route.
 */
function syncIncludedModelsFromDisk(): void {
  syncManagedProviderCatalog()
    .then(({ models, movedTo }) => {
      if (models === 0) return;
      console.log(`[Models] Eggent AI offers ${models} models${movedTo ? `; workspace moved onto ${movedTo}` : ""}`);
    })
    .catch((error) => {
      console.warn(`[Models] Eggent AI model list could not be applied: ${error instanceof Error ? error.message : error}`);
    });
}

function refreshIncludedModelCatalog(): void {
  if (!managedGatewayBaseUrl()) return;
  getManagedGatewayToken()
    .then(async (token) => {
      if (!token) return;
      const { models } = await refreshManagedCatalog(token);
      if (models === 0) return;
      const { movedTo } = await syncManagedProviderCatalog();
      console.log(
        `[Models] Eggent AI list refreshed: ${models} models${movedTo ? `; workspace moved onto ${movedTo}` : ""}`
      );
    })
    .catch((error) => {
      console.warn(`[Models] Eggent AI model list failed: ${error instanceof Error ? error.message : error}`);
    });
}

// Always, before anything is fetched: applying what is already known cannot
// fail on a network the workspace may not have.
syncIncludedModelsFromDisk();

if (modelCatalogRefreshEnabled()) {
  refreshModelCatalog();
  const timer = setInterval(refreshModelCatalog, MODEL_CATALOG_REFRESH_MS);
  timer.unref?.();
}
