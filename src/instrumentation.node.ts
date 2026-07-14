import { initSyncthingLifecycle } from "@/lib/syncthing/lifecycle";
import { initTelegramLifecycle } from "@/lib/telegram/polling-lifecycle";

initTelegramLifecycle().catch((error) => {
  console.error("Failed to initialize Telegram lifecycle:", error);
});

initSyncthingLifecycle();
