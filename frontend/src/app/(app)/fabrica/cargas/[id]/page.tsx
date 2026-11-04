import type { Metadata } from "next";

import { WeighingPage } from "@/components/logistics/weighing";

export const metadata: Metadata = { title: "Pesada de carga" };

export default async function WeighingRoutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WeighingPage loadId={id} />;
}
