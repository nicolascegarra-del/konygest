import type { Metadata } from "next";

import { ProductionPage } from "@/components/factory/production-page";

export const metadata: Metadata = { title: "Fabricación" };

export default function ProductionPageRoute() {
  return <ProductionPage />;
}
