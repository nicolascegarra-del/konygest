"use client";

import { useQuery } from "@tanstack/react-query";
import { CircleCheck, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { ErrorState, LoadingBlock } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { formatKg, formatMoney, formatPercent, formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { OrderChecks } from "@/types/fase2";

function Row({ label, value, strong, tone }: { label: string; value: ReactNode; strong?: boolean; tone?: "bad" }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("text-right tabular-nums", strong && "font-semibold", tone === "bad" && "text-destructive")}>{value}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function OkLine({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-sm text-success">
      <CircleCheck className="size-4 shrink-0" aria-hidden />
      {children}
    </p>
  );
}

/** Comprobaciones antes de validar: riesgo del cliente, precios por debajo de referencia y stock. */
export function OrderChecksPanel({ orderId }: { orderId: string }) {
  const query = useQuery({
    queryKey: ["orders", "checks", orderId],
    queryFn: ({ signal }) => api.get<OrderChecks>(`/orders/${orderId}/checks`, undefined, signal),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Comprobaciones</CardTitle>
        <CardDescription>Riesgo del cliente, precios y stock en este momento.</CardDescription>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <LoadingBlock rows={3} />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : (
          <ChecksContent checks={query.data} />
        )}
      </CardContent>
    </Card>
  );
}

export function ChecksContent({ checks }: { checks: OrderChecks }) {
  const { credit, prices, stock } = checks;
  const shortItems = stock.filter((row) => row.short);
  return (
    <div className="space-y-5">
      <Section title="Riesgo">
        {credit.credit_limit === null ? (
          <OkLine>El cliente no tiene límite de crédito.</OkLine>
        ) : (
          <>
            {credit.exceeded ? (
              <p role="alert" className="flex items-start gap-1.5 rounded-md bg-destructive/10 p-2 text-sm font-medium text-destructive">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                Supera el riesgo del cliente
                {credit.available !== null && credit.available < 0 ? ` en ${formatMoney(-credit.available)}` : ""}. Para validarlo
                habrá que forzarlo.
              </p>
            ) : null}
            <dl className="divide-y">
              <Row label="Límite de crédito" value={formatMoney(credit.credit_limit)} />
              <Row label="Pendiente (otros pedidos)" value={formatMoney(credit.outstanding_amount)} />
              <Row label="Este pedido" value={formatMoney(credit.order_amount)} />
              <Row
                label="Disponible"
                value={formatMoney(credit.available)}
                strong
                tone={credit.available !== null && credit.available < 0 ? "bad" : undefined}
              />
            </dl>
          </>
        )}
      </Section>

      <Section title="Precios">
        {prices.length === 0 ? (
          <OkLine>Ningún precio por debajo del de referencia.</OkLine>
        ) : (
          <ul className="space-y-2">
            {prices.map((row) => (
              <li key={row.line_id} className="rounded-md border border-warning/40 bg-warning/10 p-2 text-sm">
                <p className="flex items-center gap-1.5 font-medium">
                  <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden />
                  {row.item_code} · {row.item_name}
                </p>
                <p className="mt-0.5 text-muted-foreground tabular-nums">
                  {formatPrice(row.unit_price)} frente a {formatPrice(row.reference_price)}{" "}
                  <span className="font-semibold text-warning">({formatPercent(row.difference_pct)})</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Stock">
        {stock.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin piensos que comprobar.</p>
        ) : (
          <>
            {shortItems.length === 0 ? <OkLine>Hay stock para todo el pedido.</OkLine> : null}
            <ul className="space-y-2">
              {stock.map((row) => (
                <li key={row.item_id} className="rounded-md border p-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      {row.item_code} · {row.item_name}
                    </span>
                    {row.short ? <Badge variant="warning">Stock insuficiente</Badge> : <Badge variant="success">Hay stock</Badge>}
                  </div>
                  <dl className="mt-1 grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <dt className="text-muted-foreground">Pedido</dt>
                      <dd className="tabular-nums">{formatKg(row.requested_kg)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Comprometido</dt>
                      <dd className="tabular-nums">{formatKg(row.committed_kg)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">En stock</dt>
                      <dd className="tabular-nums">{formatKg(row.stock_kg)}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
            {shortItems.length > 0 ? (
              <p className="text-xs text-muted-foreground">El stock es informativo: no impide validar (se puede fabricar).</p>
            ) : null}
          </>
        )}
      </Section>
    </div>
  );
}
