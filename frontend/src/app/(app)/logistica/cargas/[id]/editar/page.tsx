import type { Metadata } from "next";

import { EditLoadPage } from "@/components/logistics/load-form-pages";

export const metadata: Metadata = { title: "Editar carga" };

export default async function EditLoadRoutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EditLoadPage loadId={id} />;
}
