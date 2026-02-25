import { CronScheduler } from "@/lib/cron/service";

declare global {
  // eslint-disable-next-line no-var
  var __eggentCronScheduler__: CronScheduler | undefined;
}

export async function ensureCronSchedulerStarted(): Promise<void> {
  if (!globalThis.__eggentCronScheduler__) {
    globalThis.__eggentCronScheduler__ = new CronScheduler();
  }
  globalThis.__eggentCronScheduler__.start();
}
