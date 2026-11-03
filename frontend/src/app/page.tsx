import { ArrowRight, Check, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { DemoForm } from "@/components/landing/demo-form";
import { LandingFooter } from "@/components/landing/footer";
import { LandingHeader } from "@/components/landing/header";
import { MODULES, PLANS, PROFILES } from "@/components/landing/content";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

export default function LandingPage() {
  return (
    <div className="bg-white text-klyp-text-dark dark:bg-klyp-navy dark:text-klyp-pale">
      <LandingHeader />
      <main>
        {/* Hero */}
        <section className="bg-klyp-navy text-white">
          <div className="mx-auto grid max-w-6xl gap-8 px-4 py-16 md:py-24 lg:grid-cols-[1.2fr_1fr] lg:items-center">
            <div className="space-y-6">
              <Badge className="bg-white/10 text-white">Para fábricas de piensos a granel</Badge>
              <h1 className="text-3xl font-bold leading-tight !text-white sm:text-4xl md:text-5xl">
                Toda tu fábrica de piensos, en una sola aplicación.
              </h1>
              <p className="max-w-xl text-base text-white/80 md:text-lg">
                Del pedido del comercial a la factura con Verifactu: stock, fabricación, logística y facturación conectados,
                con una pantalla inicial propia para cada perfil de tu equipo.
              </p>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Button asChild size="lg" variant="default">
                  <a href="#demo">
                    Solicitar demo <ArrowRight aria-hidden />
                  </a>
                </Button>
                <Button asChild size="lg" variant="outlineOnNavy">
                  <Link href="/login">Acceder</Link>
                </Button>
              </div>
            </div>
            <ul className="grid gap-3 rounded-lg border border-white/15 bg-white/5 p-5 text-sm text-white/90" aria-label="Ventajas">
              {[
                "Un solo dato para fábrica, oficina y comerciales",
                "Cada empresa aislada y con sus propios roles",
                "Siempre online, desde el móvil o el ordenador",
                "Facturación preparada para Verifactu",
              ].map((text) => (
                <li key={text} className="flex items-start gap-3">
                  <Check className="mt-0.5 size-5 shrink-0 text-[#7db2f0]" aria-hidden />
                  {text}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Módulos */}
        <section id="modulos" className="scroll-mt-16 bg-white py-16 dark:bg-klyp-navy md:py-20">
          <div className="mx-auto max-w-6xl px-4">
            <h2 className="text-2xl font-bold md:text-3xl">Los módulos que tu fábrica necesita</h2>
            <p className="mt-2 max-w-2xl text-klyp-gray dark:text-klyp-pale/80">
              Lo esencial viene siempre activo; lo demás lo activas cuando lo necesites.
            </p>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {MODULES.map((module) => (
                <article
                  key={module.title}
                  className="rounded-lg border bg-white p-5 shadow-sm dark:border-klyp-navy-light dark:bg-[#0a2349]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <module.icon className="size-7 text-klyp-accent dark:text-[#7db2f0]" aria-hidden />
                    {module.optional ? <Badge variant="secondary">Opcional</Badge> : null}
                  </div>
                  <h3 className="mt-3 text-lg font-semibold">{module.title}</h3>
                  <p className="mt-1 text-sm text-klyp-gray dark:text-klyp-pale/80">{module.description}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Perfiles */}
        <section id="perfiles" className="scroll-mt-16 bg-klyp-pale py-16 dark:bg-[#031024] md:py-20">
          <div className="mx-auto max-w-6xl px-4">
            <h2 className="text-2xl font-bold md:text-3xl">Una pantalla inicial para cada perfil</h2>
            <p className="mt-2 max-w-2xl text-klyp-gray dark:text-klyp-pale/80">
              Cada rol ve lo que le importa y puede reordenar su pantalla a su gusto.
            </p>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {PROFILES.map((profile) => (
                <article key={profile.title} className="rounded-lg bg-white p-5 shadow-sm dark:bg-[#0a2349]">
                  <h3 className="text-lg font-semibold">{profile.title}</h3>
                  <p className="mt-1 text-sm text-klyp-gray dark:text-klyp-pale/80">{profile.description}</p>
                  <ul className="mt-3 space-y-2 text-sm">
                    {profile.items.map((item) => (
                      <li key={item} className="flex items-start gap-2">
                        <Check className="mt-0.5 size-4 shrink-0 text-klyp-accent dark:text-[#7db2f0]" aria-hidden />
                        {item}
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* IA */}
        <section id="ia" className="scroll-mt-16 bg-klyp-navy py-16 text-white md:py-20">
          <div className="mx-auto grid max-w-6xl gap-8 px-4 lg:grid-cols-2 lg:items-center">
            <div className="space-y-4">
              <Sparkles className="size-8 text-[#7db2f0]" aria-hidden />
              <h2 className="text-2xl font-bold !text-white md:text-3xl">IA con tu propia clave</h2>
              <p className="text-white/80">
                Cada empresa elige su proveedor (Claude, Gemini o ChatGPT) y pega su clave, que se guarda cifrada. La IA no
                ejecuta consultas libres: solo usa herramientas del sistema con los permisos de quien pregunta.
              </p>
            </div>
            <ul className="grid gap-3 text-sm">
              {[
                ["Asistente de consultas", "«¿Cuánto cebo queda en los silos?» o «Pedidos pendientes de Juan».", "Disponible en toda la app"],
                ["Pedidos por voz o texto", "Dicta o pega un WhatsApp y obtén un borrador que el comercial revisa.", "Nunca confirma sola"],
                ["Propuesta de cargas", "Reparto sugerido de pedidos en camiones y rutas.", "El planificador decide"],
              ].map(([title, text, note]) => (
                <li key={title} className="rounded-lg border border-white/15 bg-white/5 p-4">
                  <p className="font-semibold text-white">{title}</p>
                  <p className="mt-1 text-white/80">{text}</p>
                  <p className="mt-1 text-xs text-[#7db2f0]">{note}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Planes */}
        <section id="planes" className="scroll-mt-16 bg-white py-16 dark:bg-klyp-navy md:py-20">
          <div className="mx-auto max-w-6xl px-4">
            <h2 className="text-2xl font-bold md:text-3xl">Planes</h2>
            <p className="mt-2 max-w-2xl text-klyp-gray dark:text-klyp-pale/80">
              Precio ajustado al tamaño de tu fábrica y a los módulos que uses.
            </p>
            <div className="mt-8 grid gap-4 md:grid-cols-3">
              {PLANS.map((plan) => (
                <article
                  key={plan.name}
                  className={
                    plan.highlighted
                      ? "rounded-lg border-2 border-klyp-accent bg-white p-6 shadow-md dark:bg-[#0a2349]"
                      : "rounded-lg border bg-white p-6 shadow-sm dark:border-klyp-navy-light dark:bg-[#0a2349]"
                  }
                >
                  <h3 className="text-xl font-semibold">{plan.name}</h3>
                  <p className="mt-1 text-sm text-klyp-gray dark:text-klyp-pale/80">{plan.tagline}</p>
                  <p className="mt-4 text-2xl font-bold">A consultar</p>
                  <ul className="mt-4 space-y-2 text-sm">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-2">
                        <Check className="mt-0.5 size-4 shrink-0 text-klyp-accent dark:text-[#7db2f0]" aria-hidden />
                        {feature}
                      </li>
                    ))}
                  </ul>
                  <Button asChild variant={plan.highlighted ? "default" : "outline"} className="mt-6 w-full">
                    <a href="#demo">Consultar</a>
                  </Button>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Demo */}
        <section id="demo" className="scroll-mt-16 bg-klyp-navy py-16 md:py-20">
          <div className="mx-auto max-w-3xl px-4">
            <h2 className="text-2xl font-bold !text-white md:text-3xl">Solicita una demo</h2>
            <p className="mb-6 mt-2 text-white/80">Cuéntanos cómo trabaja tu fábrica y te enseñamos Konygest con tus datos.</p>
            <DemoForm />
          </div>
        </section>
      </main>
      <LandingFooter />
    </div>
  );
}
