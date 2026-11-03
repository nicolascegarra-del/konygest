import Link from "next/link";

import { Logo } from "@/components/common/logo";

export function LandingFooter() {
  return (
    <footer className="border-t border-white/10 bg-klyp-navy text-white/80">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <Logo onDark />
          <p className="max-w-xs text-sm">Gestión de fábricas de piensos a granel. Un producto de Klyp.</p>
        </div>
        <nav aria-label="Legal" className="flex flex-col gap-1 text-sm md:items-end">
          <Link href="/aviso-legal" className="flex min-h-11 items-center hover:text-white md:min-h-8">
            Aviso legal
          </Link>
          <Link href="/privacidad" className="flex min-h-11 items-center hover:text-white md:min-h-8">
            Política de privacidad
          </Link>
          <Link href="/cookies" className="flex min-h-11 items-center hover:text-white md:min-h-8">
            Política de cookies
          </Link>
        </nav>
      </div>
      <div className="border-t border-white/10 py-4 text-center text-xs">
        © {new Date().getFullYear()} Klyp. Todos los derechos reservados.
      </div>
    </footer>
  );
}
