import type { Metadata } from "next";

import { LegalPage } from "@/components/landing/legal-page";

export const metadata: Metadata = { title: "Aviso legal", alternates: { canonical: "/aviso-legal" } };

export default function AvisoLegalPage() {
  return (
    <LegalPage title="Aviso legal" updated="03/11/2026">
      <p>
        En cumplimiento de la Ley 34/2002 de Servicios de la Sociedad de la Información y de Comercio Electrónico, se
        informa de los datos del titular de este sitio web.
      </p>
      <h2>Titular</h2>
      <ul>
        <li>Denominación: Klyp (titular de Konygest).</li>
        <li>Correo de contacto: soporte@klyp.es</li>
        <li>Datos registrales y fiscales: pendientes de completar por el titular antes de la publicación.</li>
      </ul>
      <h2>Condiciones de uso</h2>
      <p>
        El acceso a este sitio atribuye la condición de usuario e implica la aceptación de estas condiciones. El usuario
        se compromete a hacer un uso adecuado de los contenidos y servicios, sin fines ilícitos y sin dañar el
        funcionamiento del sitio.
      </p>
      <h2>Propiedad intelectual</h2>
      <p>
        Los contenidos, marcas, diseños y el software de Konygest son propiedad de Klyp o de sus licenciantes. Queda
        prohibida su reproducción o distribución sin autorización expresa.
      </p>
      <h2>Responsabilidad</h2>
      <p>
        Klyp no garantiza la ausencia de interrupciones del servicio ni se responsabiliza de los daños derivados de un
        uso indebido del sitio. Los contenidos informativos pueden modificarse sin previo aviso.
      </p>
      <h2>Legislación aplicable</h2>
      <p>Este aviso se rige por la legislación española. Para cualquier controversia serán competentes los juzgados que correspondan conforme a derecho.</p>
    </LegalPage>
  );
}
