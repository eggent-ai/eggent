import { initTelegramLifecycle } from "@/lib/telegram/polling-lifecycle";
import { refreshPiModelCatalog } from "@/lib/pi/config-store";
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
}

if (modelCatalogRefreshEnabled()) {
  refreshModelCatalog();
  const timer = setInterval(refreshModelCatalog, MODEL_CATALOG_REFRESH_MS);
  timer.unref?.();
}
