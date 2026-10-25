"use client";

/**
 * One short card about Eggent Cloud, on an Eggent somebody runs themselves.
 *
 * It sits under the workspace's model, where a self-hosted workspace would
 * otherwise go and fetch an API key. It leads with the three things a home
 * setup finds hardest - keys, a computer that has to stay on, reaching it from
 * a phone - then lists the rest in a line each, and links to the site in the
 * reader's language. Every line names something the hosted Eggent does today.
 * Whether the card is shown at all is the deployment's word (`cloudPromo` on
 * /api/deployment); a person can hide it, and it stays hidden in that browser.
 */
import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Clock,
  Cloud,
  FileSearch,
  FolderSync,
  Globe,
  Laptop,
  Mic,
  Send,
  Smartphone,
  Sparkles,
  Users,
  WandSparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";

const HIDDEN_KEY = "eggent.cloudPromoHidden";

export function CloudPromo() {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);

  // After mount: the server renders this page too, and the choice to hide the
  // card lives in the browser.
  useEffect(() => {
    let hidden = false;
    try {
      hidden = window.localStorage.getItem(HIDDEN_KEY) === "1";
    } catch {
      hidden = false;
    }
    if (hidden) return;
    let cancelled = false;
    fetch("/api/deployment", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((json: { cloudPromo?: boolean } | null) => {
        if (!cancelled && json?.cloudPromo) setShown(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!shown) return null;

  const hide = () => {
    try {
      window.localStorage.setItem(HIDDEN_KEY, "1");
    } catch {
      // Hidden for this page only.
    }
    setShown(false);
  };

  const highlights = [
    { icon: Sparkles, title: t("cloudPromo.keysTitle"), text: t("cloudPromo.keysText") },
    { icon: Clock, title: t("cloudPromo.awayTitle"), text: t("cloudPromo.awayText") },
    { icon: Smartphone, title: t("cloudPromo.anywhereTitle"), text: t("cloudPromo.anywhereText") },
  ];
  const points = [
    { icon: Globe, text: t("cloudPromo.browser") },
    { icon: FileSearch, text: t("cloudPromo.pages") },
    { icon: Mic, text: t("cloudPromo.voice") },
    { icon: WandSparkles, text: t("cloudPromo.skills") },
    { icon: Send, text: t("cloudPromo.telegram") },
    { icon: FolderSync, text: t("cloudPromo.sync") },
    { icon: Laptop, text: t("cloudPromo.mac") },
    { icon: Users, text: t("cloudPromo.team") },
  ];

  return (
    <section aria-labelledby="cloud-promo-title" className="relative rounded-xl border bg-card p-5">
      <Button
        variant="ghost"
        size="icon"
        className="absolute right-2 top-2 size-8 text-muted-foreground hover:text-foreground"
        onClick={hide}
        aria-label={t("cloudPromo.hide")}
        title={t("cloudPromo.hide")}
      >
        <X className="size-4" />
      </Button>
      <div className="flex items-start gap-3 pr-8">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted" aria-hidden>
          <Cloud className="size-4" />
        </span>
        <div className="space-y-0.5">
          <h3 id="cloud-promo-title" className="font-medium">{t("cloudPromo.title")}</h3>
          <p className="text-sm text-muted-foreground">{t("cloudPromo.lead")}</p>
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {highlights.map(({ icon: Icon, title, text }) => (
          <div key={title} className="rounded-lg bg-muted/50 p-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              {title}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{text}</p>
          </div>
        ))}
      </div>
      <ul className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {points.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-start gap-2">
            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span>{text}</span>
          </li>
        ))}
      </ul>
      <a
        href={t("cloudPromo.url")}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-4 inline-flex min-h-6 items-center gap-1 text-sm font-medium text-foreground underline decoration-foreground/30 underline-offset-2 transition-colors hover:decoration-foreground"
      >
        {t("cloudPromo.cta")}
        <ArrowUpRight className="size-3.5" aria-hidden />
      </a>
    </section>
  );
}
