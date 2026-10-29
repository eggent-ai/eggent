import type { Metadata, Viewport } from "next";
import { unstable_noStore as noStore } from "next/cache";
import { headers } from "next/headers";
import { getSettings } from "@/lib/storage/settings-store";
import { I18nProvider } from "@/i18n/provider";
import { normalizeLocalePreference, resolveLocalePreference } from "@/i18n/locales";
import "./globals.css";

export const metadata: Metadata = {
  title: "Eggent",
  description: "AI Agent Terminal - Execute code, manage memory, search the web",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  noStore();
  const settings = await getSettings();
  const requestHeaders = await headers();
  const localePreference = normalizeLocalePreference(settings.general.language);
  const locale = resolveLocalePreference(localePreference, requestHeaders.get("accept-language"));

  return (
    <html lang={locale} className={settings.general.darkMode ? "dark" : undefined}>
      <body className="antialiased">
        <I18nProvider initialLocale={locale} initialPreference={localePreference}>
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
