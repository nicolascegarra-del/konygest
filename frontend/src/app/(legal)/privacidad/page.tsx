import type { Metadata } from "next";

import { LegalPage } from "@/components/landing/legal-page";

export const metadata: Metadata = { title: "Política de privacidad", alternates: { canonical: "/privacidad" } };

export default function PrivacidadPage() {
  return (
    <LegalPage title="Política de privacidad" updated="03/11/2026">
      <p>
        Esta política explica cómo trata Klyp los datos personales de quienes visitan este sitio o usan Konygest, de
        acuerdo con el Reglamento (UE) 2016/679 (RGPD) y la LOPDGDD.
      </p>
      <h2>Responsable del tratamiento</h2>
      <p>Klyp. Contacto: soporte@klyp.es.</p>
      <h2>Finalidades y base jurídica</h2>
      <ul>
        <li>Atender solicitudes de demo o información: consentimiento del interesado.</li>
        <li>Prestar el servicio contratado a cada empresa cliente: ejecución del contrato.</li>
        <li>Seguridad, auditoría y prevención del fraude: interés legítimo.</li>
      </ul>
      <h2>Destinatarios</h2>
      <p>
        No se ceden datos a terceros salvo obligación legal o proveedores necesarios para prestar el servicio
        (alojamiento, envío de correo), bajo el correspondiente contrato de encargo de tratamiento.
      </p>
      <h2>Conservación</h2>
      <p>Los datos se conservan mientras dure la relación y, después, durante los plazos legales aplicables.</p>
      <h2>Derechos</h2>
      <p>
        Puedes ejercer los derechos de acceso, rectificación, supresión, oposición, limitación y portabilidad escribiendo
        a soporte@klyp.es. También puedes reclamar ante la Agencia Española de Protección de Datos (aepd.es).
      </p>
    </LegalPage>
  );
}
