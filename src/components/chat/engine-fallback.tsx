"use client";

/**
 * The way out when the program a project runs on cannot finish: carry on with
 * Eggent's model. The chat around the message knows how to do that (put the
 * project back on a model, send the same words again) and lends it to the
 * answer that failed, which draws the button only under the newest one.
 */
import { createContext, useContext } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";

export interface EngineFallback {
  /** The newest answer: older ones do not offer to re-send what was said after them. */
  lastAssistantId: string | null;
  busy: boolean;
  run: () => void;
}

const EngineFallbackContext = createContext<EngineFallback | null>(null);

export const EngineFallbackProvider = EngineFallbackContext.Provider;

export function EngineFallbackButton({ messageId }: { messageId: string }) {
  const { t } = useI18n();
  const fallback = useContext(EngineFallbackContext);
  if (!fallback || fallback.lastAssistantId !== messageId) return null;
  return (
    <div>
      <Button variant="outline" size="sm" onClick={fallback.run} disabled={fallback.busy}>
        {t("engines.limit.continue")}
      </Button>
    </div>
  );
}
