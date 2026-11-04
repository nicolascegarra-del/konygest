import type { Metadata } from "next";

import { NewLoadPage } from "@/components/logistics/load-form-pages";

export const metadata: Metadata = { title: "Nueva carga" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function NewLoadRoutePage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const orders = (first(params.orders) ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return <NewLoadPage date={first(params.date)} orderIds={orders} />;
}
