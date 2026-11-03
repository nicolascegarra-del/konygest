"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/common/states";
import { useCanWrite } from "@/components/factory/common";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { SalesOrderDetail } from "@/types/fase2";

import { orderDetailKey } from "./order-detail";
import { OrderForm } from "./order-form";

function Back({ href, label }: { href: string; label: string }) {
  return (
    <Button variant="ghost" size="sm" asChild className="mb-2 -ml-2">
      <Link href={href}>
        <ArrowLeft aria-hidden /> {label}
      </Link>
    </Button>
  );
}

/** `/pedidos/nuevo`. */
export function NewOrderPage() {
  const canCreate = useCanWrite("pedidos.crear");
  return (
    <>
      <Back href="/pedidos" label="Pedidos" />
      <PageHeader title="Nuevo pedido" description="Guárdalo como borrador o envíalo directamente a validar a oficina." />
      {canCreate ? (
        <OrderForm />
      ) : (
        <EmptyState title="No puedes crear pedidos" description="Tu usuario no tiene permiso para crear pedidos o la cuenta está en solo lectura." />
      )}
    </>
  );
}

/** `/pedidos/[id]/editar`: solo si la ficha trae la acción `edit`. */
export function EditOrderPage({ orderId }: { orderId: string }) {
  const query = useQuery({
    queryKey: orderDetailKey(orderId),
    queryFn: ({ signal }) => api.get<SalesOrderDetail>(`/orders/${orderId}`, undefined, signal),
  });

  if (query.isPending) return <LoadingBlock rows={6} />;
  if (query.isError) {
    return (
      <>
        <Back href="/pedidos" label="Pedidos" />
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      </>
    );
  }
  const order = query.data;
  return (
    <>
      <Back href={`/pedidos/${order.id}`} label={`Pedido ${order.number}`} />
      <PageHeader
        title={`Editar pedido ${order.number}`}
        description={order.status === "pending" ? "Ajuste de oficina antes de validar." : "Al guardar, las líneas se sustituyen por las de este formulario."}
      />
      {order.allowed_actions.includes("edit") ? (
        // El formulario toma los datos al montarse: un refetch en segundo plano no pisa lo que se está tecleando.
        <OrderForm order={order} />
      ) : (
        <EmptyState
          title="Este pedido ya no se puede editar"
          description="Por su estado o por tus permisos. Vuelve a la ficha para ver qué puedes hacer."
          action={
            <Button variant="outline" asChild>
              <Link href={`/pedidos/${order.id}`}>Ir a la ficha</Link>
            </Button>
          }
        />
      )}
    </>
  );
}
