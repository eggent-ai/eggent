import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { unstable_noStore as noStore } from "next/cache";
import { getSettings } from "@/lib/storage/settings-store";
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

  return (
    <html lang="en" className={settings.general.darkMode ? "dark" : undefined}>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
