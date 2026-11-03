"use client";

import { useQuery } from "@tanstack/react-query";

import { ErrorState, LoadingBlock } from "@/components/common/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { TENANT_STATUS_LABELS, TENANT_STATUSES } from "@/lib/labels";
import type { AdminStats } from "@/types/api";

export function StatsView() {
  const query = useQuery({
    queryKey: ["admin", "stats"],
    queryFn: ({ signal }) => api.get<AdminStats>("/admin/stats", undefined, signal),
  });
  if (query.isPending) return <LoadingBlock rows={3} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;

  const { tenants, users, active_users_30d } = query.data;
  const totalTenants = TENANT_STATUSES.reduce((sum, status) => sum + (tenants[status] ?? 0), 0);

  return (
    <div className="space-y-6">
      <section aria-labelledby="stats-tenants">
        <h2 id="stats-tenants" className="mb-3 text-lg font-semibold">
          Empresas ({totalTenants})
        </h2>
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {TENANT_STATUSES.map((status) => (
            <Card key={status}>
              <CardHeader className="pb-1">
                <dt className="text-sm text-muted-foreground">{TENANT_STATUS_LABELS[status]}</dt>
              </CardHeader>
              <CardContent>
                <dd className="text-3xl font-bold">{tenants[status] ?? 0}</dd>
              </CardContent>
            </Card>
          ))}
        </dl>
      </section>
      <section aria-labelledby="stats-users">
        <h2 id="stats-users" className="mb-3 text-lg font-semibold">
          Usuarios
        </h2>
        <dl className="grid gap-3 sm:grid-cols-2">
          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="text-sm font-normal text-muted-foreground">
                <dt>Usuarios totales</dt>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dd className="text-3xl font-bold">{users}</dd>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="text-sm font-normal text-muted-foreground">
                <dt>Activos en los últimos 30 días</dt>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dd className="text-3xl font-bold">{active_users_30d}</dd>
            </CardContent>
          </Card>
        </dl>
      </section>
    </div>
  );
}
