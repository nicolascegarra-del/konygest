import type { Metadata } from "next";

import { LegalPage } from "@/components/landing/legal-page";

export const metadata: Metadata = { title: "Política de cookies", alternates: { canonical: "/cookies" } };

export default function CookiesPage() {
  return (
    <LegalPage title="Política de cookies" updated="03/11/2026">
      <p>
        Konygest solo utiliza almacenamiento técnico necesario para su funcionamiento. No usa cookies de publicidad ni
        de seguimiento.
      </p>
      <h2>Cookies y almacenamiento que utilizamos</h2>
      <ul>
        <li>
          <strong>kg_refresh</strong> (cookie técnica, HttpOnly, SameSite=Strict): mantiene tu sesión iniciada de forma
          segura. Caduca a los 7 días.
        </li>
        <li>
          <strong>theme</strong> (almacenamiento local del navegador): recuerda si prefieres modo claro u oscuro.
        </li>
      </ul>
      <p>Al ser estrictamente necesarias, no requieren consentimiento previo.</p>
      <h2>Cómo desactivarlas</h2>
      <p>
        Puedes bloquear o eliminar las cookies desde la configuración de tu navegador, aunque entonces no podrás iniciar
        sesión en la aplicación.
      </p>
    </LegalPage>
  );
}
