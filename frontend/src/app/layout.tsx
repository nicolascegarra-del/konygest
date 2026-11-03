import type { Metadata, Viewport } from "next";
import { Inter, Nunito } from "next/font/google";
import type { ReactNode } from "react";

import { Providers } from "@/components/providers";
import { APP_NAME, SITE_URL } from "@/lib/config";

import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const nunito = Nunito({ subsets: ["latin"], variable: "--font-nunito", weight: ["600"], display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: `${APP_NAME} · Gestión de fábricas de piensos a granel`, template: `%s · ${APP_NAME}` },
  description:
    "Konygest reúne stock, fabricación, pedidos de comerciales, logística, facturación con Verifactu e IA en una sola aplicación para fábricas de piensos a granel.",
  applicationName: APP_NAME,
  icons: { icon: "/icon.svg" },
  authors: [{ name: "Klyp" }],
  openGraph: {
    type: "website",
    locale: "es_ES",
    siteName: APP_NAME,
    title: `${APP_NAME} · Gestión de fábricas de piensos a granel`,
    description:
      "Stock, fabricación, pedidos, logística y facturación con Verifactu en una sola aplicación para tu fábrica de piensos.",
  },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#051937",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es-ES" suppressHydrationWarning className={`${inter.variable} ${nunito.variable}`}>
      <body className="min-h-dvh antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
