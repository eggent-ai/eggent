"use client";

import Link from "next/link";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import type { MessageKey } from "@/i18n/messages";
import type { SecretKind } from "@/lib/secrets/shapes";

/**
 * Above the composer, when what is about to be sent looks like a credential.
 *
 * It does not forbid anything: sometimes the agent has to be given the key, and
 * only the person knows. It says what happens to what they send - it is kept in
 * the chat's history - and, for the two kinds that have a proper place, where
 * that is. Sending anyway is one click.
 */

const COPY: Record<SecretKind, MessageKey> = {
  "bot-token": "composer.secret.botToken",
  "api-key": "composer.secret.apiKey",
  token: "composer.secret.generic",
  "cloud-key": "composer.secret.generic",
  "private-key": "composer.secret.generic",
  "url-credentials": "composer.secret.generic",
  password: "composer.secret.generic",
};

const PLACE: Partial<Record<SecretKind, { href: string; label: MessageKey }>> = {
  "bot-token": { href: "/dashboard/messengers", label: "composer.secret.openMessengers" },
  "api-key": { href: "/dashboard/settings", label: "composer.secret.openModels" },
};

export function SecretNotice({ kind, onSend, onEdit }: { kind: SecretKind; onSend: () => void; onEdit: () => void }) {
  const { t } = useI18n();
  const place = PLACE[kind];
  return (
    <div className="mb-2 flex flex-col gap-2 rounded-xl border bg-muted/40 px-3 py-2.5 text-xs leading-5" role="alert" data-secret-notice>
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">{t("composer.secret.title")}</p>
          <p className="text-muted-foreground">
            {t(COPY[kind])}
            {place ? (
              <>
                {" "}
                <Link href={place.href} className="text-foreground underline underline-offset-2">
                  {t(place.label)}
                </Link>
              </>
            ) : null}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
          {t("composer.secret.edit")}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onSend}>
          {t("composer.secret.send")}
        </Button>
      </div>
    </div>
  );
}
