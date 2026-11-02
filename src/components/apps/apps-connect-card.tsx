"use client";

import { Blocks } from "lucide-react";
import { useI18n } from "@/i18n/provider";

/**
 * Under an answer that needs an app the person has not connected: the way to
 * connect it, on the deployment's own page. Keys are typed there, never into
 * the chat.
 */
export function AppsConnectCard({ url }: { url: string }) {
  const { t } = useI18n();
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3" data-slot="apps-connect-card">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Blocks className="size-4" aria-hidden />
      </span>
      <p className="min-w-0 flex-1 text-sm leading-5 text-muted-foreground">{t("apps.card.text")}</p>
      <a href={url} className="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">
        {t("apps.card.button")}
      </a>
    </div>
  );
}
