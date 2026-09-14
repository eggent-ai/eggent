import { initTelegramLifecycle } from "@/lib/telegram/polling-lifecycle";
import { getManagedGatewayToken, refreshPiModelCatalog, syncManagedProviderCatalog } from "@/lib/pi/config-store";
import { managedGatewayBaseUrl, refreshManagedCatalog } from "@/lib/pi/managed-models";
import { restorePiSchedules } from "@/lib/pi/schedule-host";

initTelegramLifecycle().catch((error) => {
  console.error("Failed to initialize Telegram lifecycle:", error);
});

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
