"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/common/states";
import { useCanWrite } from "@/components/factory/common";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { LoadDetail } from "@/types/fase3";

import { BackLink, loadDetailKey } from "./common";
import { LoadForm } from "./load-form";

/** `/logistica/cargas/nueva?date=YYYY-MM-DD&orders=id,id` (los parámetros vienen del tablero). */
export function NewLoadPage({ date, orderIds }: { date?: string; orderIds: string[] }) {
  const canPlan = useCanWrite("logistica.planificar");
  return (
    <>
      <BackLink href="/logistica" label="Planificación" />
      <PageHeader title="Nueva carga" description="Elige camión y pedidos, ordena las paradas y revisa el reparto." />
      {canPlan ? (
        <LoadForm initialDate={date} initialOrderIds={orderIds} />
      ) : (
        <EmptyState title="No puedes planificar cargas" description="Tu usuario no tiene permiso de planificación o la cuenta está en solo lectura." />
      )}
    </>
  );
}

/** `/logistica/cargas/[id]/editar`: solo con la acción `edit` (cargas planificadas). */
export function EditLoadPage({ loadId }: { loadId: string }) {
  const query = useQuery({
    queryKey: loadDetailKey(loadId),
    queryFn: ({ signal }) => api.get<LoadDetail>(`/loads/${loadId}`, undefined, signal),
  });

  if (query.isPending) return <LoadingBlock rows={6} />;
  if (query.isError) {
    return (
      <>
        <BackLink href="/logistica/cargas" label="Cargas" />
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      </>
    );
  }
  const load = query.data;
  return (
    <>
      <BackLink href={`/logistica/cargas/${load.id}`} label={`Carga ${load.number}`} />
      <PageHeader title={`Editar carga ${load.number}`} description="Al guardar, las paradas y el reparto se sustituyen por los de este formulario." />
      {load.allowed_actions.includes("edit") ? (
        // El formulario toma los datos al montarse: un refetch en segundo plano no pisa lo que se está cambiando.
        <LoadForm load={load} />
      ) : (
        <EmptyState
          title="Esta carga ya no se puede editar"
          description="Solo se editan las cargas planificadas. Vuelve a la ficha para ver qué puedes hacer."
          action={
            <Button variant="outline" asChild>
              <Link href={`/logistica/cargas/${load.id}`}>Ir a la ficha</Link>
            </Button>
          }
        />
      )}
    </>
  );
}
