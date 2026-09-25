/**
 * Stands in for the i18n server module in tests.
 *
 * The real one reads the request's Accept-Language through next/headers, which
 * Node cannot load outside Next. Tests run in English, the language the public
 * build ships, with the real message catalog behind it.
 */
import { translate, type MessageKey, type MessageValues } from "../../src/i18n/messages.ts";

export async function getServerLocale(): Promise<"en"> {
  return "en";
}

export async function getServerTranslator(): Promise<(key: MessageKey, values?: MessageValues) => string> {
  return (key: MessageKey, values?: MessageValues) => translate("en", key, values);
}

export async function getServerMessage(key: MessageKey, values?: MessageValues): Promise<string> {
  return translate("en", key, values);
}
