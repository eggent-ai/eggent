export const SUPPORTED_LOCALES = ["en"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export type LocalePreference = SupportedLocale | "auto";

export const DEFAULT_LOCALE: SupportedLocale = "en";

export const LOCALE_OPTIONS: Array<{ value: LocalePreference; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "en", label: "English" },
];

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === "auto" || isSupportedLocale(value);
}

export function normalizeLocalePreference(value: unknown): LocalePreference {
  return isLocalePreference(value) ? value : "auto";
}

export function resolveLocalePreference(preference: unknown, acceptLanguage?: string | null): SupportedLocale {
  const normalized = normalizeLocalePreference(preference);
  if (normalized !== "auto") return normalized;
  return localeFromAcceptLanguage(acceptLanguage) || DEFAULT_LOCALE;
}

export function resolveBrowserLocale(preference: unknown): SupportedLocale {
  const normalized = normalizeLocalePreference(preference);
  if (normalized !== "auto") return normalized;
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  return localeFromAcceptLanguage(navigator.languages?.join(",") || navigator.language) || DEFAULT_LOCALE;
}

function localeFromAcceptLanguage(header?: string | null): SupportedLocale | null {
  if (!header) return null;
  for (const rawPart of header.split(",")) {
    const tag = rawPart.trim().split(";")[0]?.toLowerCase();
    if (!tag) continue;
    const base = tag.split("-")[0];
    if (isSupportedLocale(base)) return base;
  }
  return null;
}
