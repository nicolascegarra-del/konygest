"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Logo } from "@/components/common/logo";
import { ThemeToggle } from "@/components/common/theme-toggle";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

const NAV_LINKS = [
  { href: "#modulos", label: "Módulos" },
  { href: "#perfiles", label: "Perfiles" },
  { href: "#ia", label: "IA" },
  { href: "#planes", label: "Planes" },
  { href: "#demo", label: "Solicitar demo" },
];

export function LandingHeader() {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-klyp-navy/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
        <Link href="/" aria-label="Konygest, inicio">
          <Logo onDark />
        </Link>
        <nav className="hidden items-center gap-6 md:flex" aria-label="Principal">
          {NAV_LINKS.map((link) => (
            <a key={link.href} href={link.href} className="text-sm text-white/80 hover:text-white">
              {link.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-1">
          <ThemeToggle onNavy />
          <Button asChild variant="onNavy" size="sm" className="hidden sm:inline-flex">
            <Link href="/login">Acceder</Link>
          </Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <Button
              variant="ghost"
              size="icon"
              className="text-white hover:bg-white/10 hover:text-white md:hidden"
              onClick={() => setOpen(true)}
              aria-label="Abrir menú"
            >
              <Menu aria-hidden />
            </Button>
            <DialogContent side="left" className="bg-klyp-navy text-white">
              <DialogTitle className="sr-only">Menú</DialogTitle>
              <div className="flex flex-col gap-1 p-4 pt-14">
                {NAV_LINKS.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    onClick={() => setOpen(false)}
                    className="flex min-h-11 items-center rounded-md px-3 text-white/90 hover:bg-white/10"
                  >
                    {link.label}
                  </a>
                ))}
                <Button asChild variant="onNavy" className="mt-4">
                  <Link href="/login">Acceder</Link>
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </header>
  );
}
