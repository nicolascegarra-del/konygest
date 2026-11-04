import type { Metadata } from "next";
import { Suspense } from "react";

import { LoadingBlock, PageHeader } from "@/components/common/states";
import { DocumentStorageSettings } from "@/components/settings/document-storage";

export const metadata: Metadata = { title: "Documentos" };

export default function DocumentStoragePage() {
  return (
    <>
      <PageHeader
        title="Documentos"
        description="Dónde se guardan los albaranes, las órdenes de carga y, más adelante, las facturas de tu empresa."
      />
      {/* useSearchParams (vuelta de Google/Microsoft) necesita un límite de Suspense. */}
      <Suspense fallback={<LoadingBlock rows={4} />}>
        <DocumentStorageSettings />
      </Suspense>
    </>
  );
}
