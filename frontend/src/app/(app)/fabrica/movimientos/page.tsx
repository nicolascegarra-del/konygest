import type { Metadata } from "next";

import { MovementsPage } from "@/components/factory/movements-page";

export const metadata: Metadata = { title: "Movimientos de stock" };

export default function MovementsPageRoute() {
  return <MovementsPage />;
}
