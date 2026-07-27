import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { unstable_noStore as noStore } from "next/cache";
import { headers } from "next/headers";
import { getSettings } from "@/lib/storage/settings-store";
import { I18nProvider } from "@/i18n/provider";
import { normalizeLocalePreference, resolveLocalePreference } from "@/i18n/locales";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Eggent",
  description: "AI Agent Terminal - Execute code, manage memory, search the web",
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
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <I18nProvider initialLocale={locale} initialPreference={localePreference}>
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
