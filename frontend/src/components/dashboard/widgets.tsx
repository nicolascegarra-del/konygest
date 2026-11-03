"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { safeInternalPath } from "@/components/app/notification-bell";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { buildTenantNav } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";
import type { NotificationItem, Page, TenantSummary } from "@/types/api";

import type { WidgetProps } from "./types";

const longDate = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long" });

// «martes, 3 de noviembre» → «Martes, 3 de noviembre» (la clase `capitalize` pondría «De»)
const capitalizeFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function WelcomeWidget() {
  const me = useAuthStore((state) => state.user);
  const unread = useQuery({
    queryKey: ["notifications", "unread-count"],
    queryFn: ({ signal }) => api.get<{ unread: number }>("/notifications/unread-count", undefined, signal),
  });
  if (!me) return null;
  const firstName = me.full_name.trim().split(/\s+/)[0] ?? me.full_name;
  const pending = unread.data?.unread ?? 0;
  return (
    <Card className="h-full bg-klyp-navy text-white dark:bg-klyp-navy-light">
      <CardHeader>
        <CardDescription className="text-white/70">{capitalizeFirst(longDate.format(new Date()))}</CardDescription>
        <CardTitle className="text-2xl !text-white">Hola, {firstName}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-white/85">
        {me.tenant ? <p>{me.tenant.name}</p> : null}
        <p className="mt-1">
          {pending > 0
            ? `Tienes ${pending} ${pending === 1 ? "aviso sin leer" : "avisos sin leer"}.`
            : "No tienes avisos pendientes."}
        </p>
      </CardContent>
    </Card>
  );
}

export function QuickLinksWidget({ size }: WidgetProps) {
  const me = useAuthStore((state) => state.user);
  if (!me) return null;
  const items = buildTenantNav(me)
    .flatMap((group) => group.items)
    .filter((item) => item.href !== "/inicio");
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Accesos rápidos</CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <EmptyState title="Sin accesos disponibles" description="Tu rol aún no tiene pantallas asignadas." />
        ) : (
          <ul className={cn("grid gap-2", size !== "sm" && "sm:grid-cols-2")}>
            {items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="flex min-h-11 items-center gap-3 rounded-md border px-3 text-sm hover:bg-accent"
                >
                  <item.icon className="size-4 shrink-0 text-primary" aria-hidden />
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function NotificationsWidget() {
  const query = useQuery({
    queryKey: ["notifications", "latest"],
    queryFn: ({ signal }) => api.get<Page<NotificationItem>>("/notifications", { limit: 5 }, signal),
  });
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Últimos avisos</CardTitle>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <LoadingBlock rows={3} />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : query.data.items.length === 0 ? (
          <EmptyState title="Sin avisos" description="Aquí aparecerán las novedades importantes." />
        ) : (
          <ul className="divide-y">
            {query.data.items.map((item) => {
              const href = safeInternalPath(item.link);
              const content = (
                <>
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {item.title}
                    {!item.read_at ? <Badge>Nuevo</Badge> : null}
                  </span>
                  {item.body ? <span className="block text-sm text-muted-foreground">{item.body}</span> : null}
                  <span className="block text-xs text-muted-foreground">{formatDateTime(item.created_at)}</span>
                </>
              );
              return (
                <li key={item.id} className="py-2">
                  {href ? (
                    <Link href={href} className="block rounded-md hover:bg-accent">
                      {content}
                    </Link>
                  ) : (
                    content
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function CompanySummaryWidget() {
  const query = useQuery({
    queryKey: ["tenant", "summary"],
    queryFn: ({ signal }) => api.get<TenantSummary>("/tenant/summary", undefined, signal),
  });
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Resumen de la empresa</CardTitle>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <LoadingBlock rows={2} />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Usuarios", query.data.users],
              ["Activos", query.data.active_users],
              ["Roles", query.data.roles],
              ["Módulos activos", query.data.modules_enabled.length],
            ].map(([label, value]) => (
              <div key={label} className="rounded-md bg-muted p-3">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="text-2xl font-bold">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
