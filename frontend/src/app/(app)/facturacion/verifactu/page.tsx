import type { Metadata } from "next";

import { VerifactuPage } from "@/components/invoicing/verifactu-page";

export const metadata: Metadata = { title: "Verifactu" };

export default function VerifactuRoutePage() {
  return <VerifactuPage />;
}
