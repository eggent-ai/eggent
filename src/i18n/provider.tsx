"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { resolveBrowserLocale, type LocalePreference, type SupportedLocale } from "./locales";
import { translate, type MessageKey, type MessageValues } from "./messages";

interface I18nContextValue {
  locale: SupportedLocale;
  preference: LocalePreference;
  setLocalePreference: (preference: LocalePreference) => void;
  t: (key: MessageKey, values?: MessageValues) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

interface I18nProviderProps {
  initialLocale: SupportedLocale;
  initialPreference: LocalePreference;
  children: React.ReactNode;
}

export function I18nProvider({ initialLocale, initialPreference, children }: I18nProviderProps) {
  const [preference, setPreference] = useState<LocalePreference>(initialPreference);
  const [locale, setLocale] = useState<SupportedLocale>(initialLocale);

  const setLocalePreference = useCallback((nextPreference: LocalePreference) => {
    setPreference(nextPreference);
    setLocale(resolveBrowserLocale(nextPreference));
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const nextPreference = (event as CustomEvent<{ preference?: LocalePreference }>).detail?.preference;
      if (!nextPreference) return;
      setLocalePreference(nextPreference);
    };
    window.addEventListener("eggent:locale-change", handler);
    return () => window.removeEventListener("eggent:locale-change", handler);
  }, [setLocalePreference]);

  const t = useCallback((key: MessageKey, values?: MessageValues) => translate(locale, key, values), [locale]);

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    preference,
    setLocalePreference,
    t,
  }), [locale, preference, setLocalePreference, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
