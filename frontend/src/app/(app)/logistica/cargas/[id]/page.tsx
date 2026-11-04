import type { Metadata } from "next";

import { LoadDetailView } from "@/components/logistics/load-detail";

export const metadata: Metadata = { title: "Ficha de carga" };

export default async function LoadDetailRoutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LoadDetailView loadId={id} />;
}
