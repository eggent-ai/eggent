import { initTelegramLifecycle } from "@/lib/telegram/polling-lifecycle";
import { restorePiSchedules } from "@/lib/pi/schedule-host";

initTelegramLifecycle().catch((error) => {
  console.error("Failed to initialize Telegram lifecycle:", error);
});

// A scheduled job is armed inside a live session and dies with it, so without
// this every restart ends every schedule while its store still says enabled.
restorePiSchedules().catch((error) => {
  console.error("Failed to restore scheduled tasks:", error);
});
