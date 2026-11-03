import type { Metadata } from "next";

import { StockPage } from "@/components/factory/stock-page";

export const metadata: Metadata = { title: "Stock" };

export default function StockPageRoute() {
  return <StockPage />;
}
