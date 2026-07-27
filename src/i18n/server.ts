import { headers } from "next/headers";
import { getSettings } from "@/lib/storage/settings-store";
import { resolveLocalePreference, type SupportedLocale } from "./locales";
import { translate, type MessageKey, type MessageValues } from "./messages";

export async function getServerLocale(acceptLanguage?: string | null): Promise<SupportedLocale> {
  const settings = await getSettings();
  let header = acceptLanguage;
  if (header === undefined) {
    try {
      header = (await headers()).get("accept-language");
    } catch {
      header = null;
    }
  }
  return resolveLocalePreference(settings.general.language, header);
}

export async function getServerTranslator(acceptLanguage?: string | null): Promise<(key: MessageKey, values?: MessageValues) => string> {
  const locale = await getServerLocale(acceptLanguage);
  return (key: MessageKey, values?: MessageValues) => translate(locale, key, values);
}

export async function getServerMessage(key: MessageKey, values?: MessageValues, acceptLanguage?: string | null): Promise<string> {
  const locale = await getServerLocale(acceptLanguage);
  return translate(locale, key, values);
}
