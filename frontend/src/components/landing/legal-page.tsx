import type { ReactNode } from "react";

import { LandingFooter } from "@/components/landing/footer";
import { LandingHeader } from "@/components/landing/header";

export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-white text-klyp-text-dark dark:bg-klyp-navy dark:text-klyp-pale">
      <LandingHeader />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-12">
        <h1 className="text-3xl font-bold">{title}</h1>
        <p className="mt-1 text-sm text-klyp-gray dark:text-klyp-pale/70">Última actualización: {updated}</p>
        <div className="mt-8 space-y-4 text-sm leading-relaxed [&_h2]:mt-8 [&_h2]:text-xl [&_h2]:font-semibold [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
          {children}
        </div>
      </main>
      <LandingFooter />
    </div>
  );
}
