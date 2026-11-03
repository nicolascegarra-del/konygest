"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Field } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";

const demoSchema = z.object({
  name: z.string().trim().min(2, "Indica tu nombre."),
  company: z.string().trim().min(2, "Indica el nombre de la fábrica o empresa."),
  email: z.string().trim().email("Introduce un email válido."),
  phone: z
    .string()
    .trim()
    .regex(/^[+\d][\d\s-]{6,}$/, "Introduce un teléfono válido.")
    .or(z.literal("")),
  message: z.string().trim().max(1000, "Máximo 1000 caracteres."),
  consent: z.boolean().refine((value) => value, "Debes aceptar la política de privacidad."),
  // Campo trampa antispam: las personas no lo ven ni lo rellenan.
  website: z.string().max(0),
});

type DemoFormValues = z.infer<typeof demoSchema>;

export function DemoForm() {
  const [sent, setSent] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<DemoFormValues>({
    resolver: zodResolver(demoSchema),
    defaultValues: { name: "", company: "", email: "", phone: "", message: "", consent: false, website: "" },
  });

  async function onSubmit(): Promise<void> {
    // TODO: enviar la solicitud a un endpoint del backend (p. ej. POST /api/v1/public/demo-requests)
    // con protección antispam y límite de peticiones. Pendiente de definir en la API; de momento
    // solo se valida en cliente y se muestra el agradecimiento (sin enviar datos a ningún sitio).
    setSent(true);
  }

  if (sent) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg bg-white p-8 text-center text-klyp-text-dark" role="status">
        <CheckCircle2 className="size-10 text-klyp-accent" aria-hidden />
        <h3 className="text-xl font-semibold text-klyp-navy">¡Gracias por tu interés!</h3>
        <p className="text-sm">Hemos recibido tu solicitud. Nos pondremos en contacto contigo en breve.</p>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      noValidate
      className="space-y-4 rounded-lg bg-white p-5 text-klyp-text-dark shadow-md md:p-8"
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Nombre y apellidos" htmlFor="demo-name" error={errors.name?.message}>
          <Input id="demo-name" autoComplete="name" aria-invalid={!!errors.name} {...register("name")} />
        </Field>
        <Field label="Fábrica o empresa" htmlFor="demo-company" error={errors.company?.message}>
          <Input id="demo-company" autoComplete="organization" aria-invalid={!!errors.company} {...register("company")} />
        </Field>
        <Field label="Email" htmlFor="demo-email" error={errors.email?.message}>
          <Input id="demo-email" type="email" autoComplete="email" aria-invalid={!!errors.email} {...register("email")} />
        </Field>
        <Field label="Teléfono (opcional)" htmlFor="demo-phone" error={errors.phone?.message}>
          <Input id="demo-phone" type="tel" autoComplete="tel" aria-invalid={!!errors.phone} {...register("phone")} />
        </Field>
      </div>
      <Field label="¿Qué necesitas resolver? (opcional)" htmlFor="demo-message" error={errors.message?.message}>
        <Textarea id="demo-message" {...register("message")} />
      </Field>
      <div className="absolute -left-[9999px]" aria-hidden>
        <label htmlFor="demo-website">No rellenar</label>
        <input id="demo-website" tabIndex={-1} autoComplete="off" {...register("website")} />
      </div>
      <div>
        <label className="flex min-h-11 items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1 size-5 accent-[#2E6DB4]" {...register("consent")} />
          <span>
            He leído y acepto la{" "}
            <a href="/privacidad" className="text-klyp-accent underline">
              política de privacidad
            </a>
            .
          </span>
        </label>
        {errors.consent ? (
          <p className="mt-1 text-sm text-destructive" role="alert">
            {errors.consent.message}
          </p>
        ) : null}
      </div>
      <Button type="submit" size="lg" loading={isSubmitting} className="w-full sm:w-auto">
        Solicitar demo
      </Button>
    </form>
  );
}
