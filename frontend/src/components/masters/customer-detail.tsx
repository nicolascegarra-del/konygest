"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pencil, Plus, Save } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { EmptyState, ErrorState, FieldError, LoadingBlock, PageHeader } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { optionLabel, useMasterLookups } from "@/hooks/use-master-lookups";
import { api } from "@/lib/api";
import { friendlyMessage } from "@/lib/errors";
import { formatKg, formatPrice } from "@/lib/format";
import type { Page } from "@/types/api";
import type { Customer, Farm } from "@/types/fase1";

import { CUSTOMER_FIELDS, FARM_FIELDS, formatCreditLimit } from "./definitions";
import { buildMasterSchema, toFormValues } from "./form-schema";
import { PriceLinesEditor } from "./list-editors";
import { MasterDialog, type MasterFormConfig } from "./master-dialog";
import { activeBadge, useCanManageMasters } from "./master-page";
import type { MasterField, PriceLineValue } from "./types";

const CUSTOMER_CONFIG: MasterFormConfig = {
  resource: "customers",
  fields: CUSTOMER_FIELDS,
  newLabel: "Nuevo cliente",
  editLabel: "Editar cliente",
  savedMessage: "Cliente guardado.",
};

const FARM_CONFIG: MasterFormConfig = {
  resource: "farms",
  fields: FARM_FIELDS,
  newLabel: "Nueva explotación",
  editLabel: "Editar explotación",
  savedMessage: "Explotación guardada.",
};

const PRICES_FIELD: MasterField = { name: "prices", type: "price-lines", label: "Precios negociados", itemKind: "product" };
const pricesSchema = buildMasterSchema([PRICES_FIELD]);

/** Cuerpo del PUT de un cliente a partir de su ficha (la API exige la ficha completa). */
export function customerPayload(customer: Customer): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const record = customer as unknown as Record<string, unknown>;
  for (const field of CUSTOMER_FIELDS) {
    payload[field.name] = record[field.name] ?? (field.type === "switch" ? false : null);
  }
  return payload;
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="shrink-0 text-sm text-muted-foreground sm:w-40">{label}</dt>
      <dd className="min-w-0 break-words text-sm">{children || "—"}</dd>
    </div>
  );
}

/** Ficha de cliente: datos, explotaciones (con sus silos) y precios negociados. */
export function CustomerDetail({ customerId }: { customerId: string }) {
  const queryClient = useQueryClient();
  const canManage = useCanManageMasters();
  const lookups = useMasterLookups();
  const [editingCustomer, setEditingCustomer] = useState(false);
  const [editingFarm, setEditingFarm] = useState<Farm | "new" | null>(null);

  const customer = useQuery({
    queryKey: ["masters", "customers", "detail", customerId],
    queryFn: ({ signal }) => api.get<Customer>(`/masters/customers/${customerId}`, undefined, signal),
  });
  const farms = useQuery({
    queryKey: ["masters", "farms", "list", { customer_id: customerId }],
    queryFn: ({ signal }) =>
      api.get<Page<Farm>>("/masters/farms", { customer_id: customerId, limit: 200 }, signal),
  });

  const fixedFarmValues = useMemo(() => ({ customer_id: customerId }), [customerId]);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["masters"] });

  if (customer.isPending) return <LoadingBlock rows={6} />;
  if (customer.isError) return <ErrorState error={customer.error} onRetry={() => customer.refetch()} />;
  const data = customer.data;
  const nameOf = (list: "price_lists" | "payment_methods", id: string | null) => {
    if (!id) return null;
    const option = lookups.data?.[list].find((entry) => entry.id === id);
    return option ? optionLabel(option) : "Dado de baja";
  };

  return (
    <>
      <Button variant="ghost" size="sm" asChild className="mb-2 -ml-2">
        <Link href="/maestros/clientes">
          <ArrowLeft aria-hidden /> Clientes
        </Link>
      </Button>
      <PageHeader
        title={data.name}
        description={`Código ${data.code}`}
        actions={
          canManage ? (
            <Button variant="outline" onClick={() => setEditingCustomer(true)}>
              <Pencil aria-hidden /> Editar datos
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Datos del cliente</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-2">
              <InfoRow label="Estado">{activeBadge(data.is_active)}</InfoRow>
              <InfoRow label="NIF/CIF">{data.tax_id}</InfoRow>
              <InfoRow label="Teléfono">{data.phone}</InfoRow>
              <InfoRow label="Email">{data.email}</InfoRow>
              <InfoRow label="Dirección">
                {[data.address, [data.postal_code, data.city].filter(Boolean).join(" "), data.province]
                  .filter(Boolean)
                  .join(", ")}
              </InfoRow>
              <InfoRow label="Comercial">{data.sales_rep_name}</InfoRow>
              <InfoRow label="Tarifa">{nameOf("price_lists", data.price_list_id) ?? "Precio general"}</InfoRow>
              <InfoRow label="Forma de pago">{nameOf("payment_methods", data.payment_method_id)}</InfoRow>
              <InfoRow label="Límite de crédito">{formatCreditLimit(data.credit_limit)}</InfoRow>
              <InfoRow label="Recargo de equivalencia">{data.equivalence_surcharge ? "Sí" : "No"}</InfoRow>
              <InfoRow label="Notas">
                {data.notes ? <span className="whitespace-pre-line">{data.notes}</span> : null}
              </InfoRow>
            </dl>
          </CardContent>
        </Card>

        <CustomerPrices key={data.id + JSON.stringify(data.prices)} customer={data} canManage={canManage} onSaved={invalidate} />

        <Card className="lg:col-span-2">
          <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle>Explotaciones</CardTitle>
              <CardDescription>Granjas del cliente y sus silos de destino.</CardDescription>
            </div>
            {canManage ? (
              <Button variant="outline" size="sm" onClick={() => setEditingFarm("new")}>
                <Plus aria-hidden /> Nueva explotación
              </Button>
            ) : null}
          </CardHeader>
          <CardContent>
            {farms.isPending ? (
              <LoadingBlock rows={2} />
            ) : farms.isError ? (
              <ErrorState error={farms.error} onRetry={() => farms.refetch()} />
            ) : farms.data.items.length === 0 ? (
              <EmptyState title="Sin explotaciones" description="Añade las granjas donde se descarga el pienso." />
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {farms.data.items.map((farm) => (
                  <li key={farm.id} className="rounded-lg border p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium">{farm.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {[farm.rega_code ? `REGA ${farm.rega_code}` : null, farm.city].filter(Boolean).join(" · ") || "—"}
                        </p>
                      </div>
                      {activeBadge(farm.is_active)}
                    </div>
                    {farm.silos.length > 0 ? (
                      <ul className="mt-2 flex flex-wrap gap-1.5 text-xs" aria-label={`Silos de ${farm.name}`}>
                        {farm.silos.map((silo, index) => (
                          <li key={index} className="rounded-md bg-muted px-2 py-1">
                            {silo.name}
                            {silo.capacity_kg ? ` · ${formatKg(silo.capacity_kg)}` : ""}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-xs text-muted-foreground">Sin silos de destino.</p>
                    )}
                    {canManage ? (
                      <Button variant="outline" size="sm" className="mt-3" onClick={() => setEditingFarm(farm)}>
                        <Pencil aria-hidden /> Editar
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {editingCustomer ? (
        <MasterDialog
          config={CUSTOMER_CONFIG}
          record={data as unknown as { id: string } & Record<string, unknown>}
          description={`${data.code} · ${data.name}`}
          onClose={() => setEditingCustomer(false)}
          onSaved={() => {
            setEditingCustomer(false);
            void invalidate();
          }}
        />
      ) : null}
      {editingFarm !== null ? (
        <MasterDialog
          config={FARM_CONFIG}
          record={editingFarm === "new" ? null : (editingFarm as unknown as { id: string } & Record<string, unknown>)}
          description={data.name}
          fixedValues={fixedFarmValues}
          onClose={() => setEditingFarm(null)}
          onSaved={() => {
            setEditingFarm(null);
            void invalidate();
          }}
        />
      ) : null}
    </>
  );
}

/** Tabla editable de precios negociados. Se guarda con un PUT de la ficha completa + `prices`. */
function CustomerPrices({
  customer,
  canManage,
  onSaved,
}: {
  customer: Customer;
  canManage: boolean;
  onSaved: () => void;
}) {
  const lookups = useMasterLookups();
  const initial = useMemo(
    () => (toFormValues([PRICES_FIELD], customer as unknown as Record<string, unknown>).prices ?? []) as PriceLineValue[],
    [customer],
  );
  const [rows, setRows] = useState<PriceLineValue[]>(initial);
  const [error, setError] = useState<string | undefined>();
  const dirty = JSON.stringify(rows) !== JSON.stringify(initial);

  const save = useMutation({
    mutationFn: (prices: unknown) => api.put(`/masters/customers/${customer.id}`, { ...customerPayload(customer), prices }),
    onSuccess: () => {
      toast.success("Precios guardados.");
      onSaved();
    },
    onError: (caught) => toast.error(friendlyMessage(caught)),
  });

  const submit = () => {
    const parsed = pricesSchema.safeParse({ prices: rows });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message);
      return;
    }
    setError(undefined);
    save.mutate(parsed.data.prices);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Precios negociados</CardTitle>
        <CardDescription>Tienen prioridad sobre la tarifa del cliente y el precio general.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {canManage ? (
          <>
            <PriceLinesEditor
              id="customer-prices"
              value={rows}
              onChange={setRows}
              items={(lookups.data?.items ?? []).filter((item) => item.kind === "product")}
              disabled={save.isPending}
            />
            <FieldError message={error} />
            <div className="flex justify-end">
              <Button onClick={submit} loading={save.isPending} disabled={!dirty}>
                <Save aria-hidden /> Guardar precios
              </Button>
            </div>
          </>
        ) : customer.prices.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin precios negociados.</p>
        ) : (
          <ul className="divide-y text-sm">
            {customer.prices.map((line) => (
              <li key={line.item_id} className="flex justify-between gap-3 py-2">
                <span>
                  {line.item_code} · {line.item_name}
                </span>
                <span className="font-medium tabular-nums">{formatPrice(line.price)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
