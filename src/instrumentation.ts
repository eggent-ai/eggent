export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") {
    return;
  }

  try {
    const { initTelegramLifecycle } = await import("@/lib/telegram/polling-lifecycle");
    await initTelegramLifecycle();
  } catch (error) {
    console.error("Failed to initialize Telegram lifecycle:", error);
  }
}
