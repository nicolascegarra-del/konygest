import type { Metadata } from "next";

import { LoadsPage } from "@/components/logistics/loads-page";

export const metadata: Metadata = { title: "Cargas" };

export default function LoadsRoutePage() {
  return <LoadsPage />;
}
