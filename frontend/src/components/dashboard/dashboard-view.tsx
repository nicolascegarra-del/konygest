"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, RotateCcw, Save, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { EmptyState, ErrorState, LoadingBlock, PageHeader } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { friendlyMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";
import type { DashboardResponse, WidgetItem, WidgetSize } from "@/types/api";

import { LayoutEditor } from "./layout-editor";
import { hasWidget, WIDGET_REGISTRY } from "./registry";

const DASHBOARD_KEY = ["me", "dashboard"] as const;

const SIZE_CLASSES: Record<WidgetSize, string> = {
  sm: "md:col-span-1",
  md: "md:col-span-2 lg:col-span-2",
  lg: "md:col-span-2 lg:col-span-3",
};

export function DashboardView() {
  const queryClient = useQueryClient();
  const readOnly = useAuthStore((state) => state.user?.read_only ?? false);
  const [draft, setDraft] = useState<WidgetItem[] | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const query = useQuery({
    queryKey: DASHBOARD_KEY,
    queryFn: ({ signal }) => api.get<DashboardResponse>("/me/dashboard", undefined, signal),
  });

  const save = useMutation({
    mutationFn: (layout: WidgetItem[]) => api.put<DashboardResponse>("/me/dashboard", { layout }),
    onSuccess: (data) => {
      queryClient.setQueryData(DASHBOARD_KEY, data);
      setDraft(null);
      toast.success("Pantalla inicial guardada.");
    },
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  const restore = useMutation({
    mutationFn: () => api.delete<DashboardResponse>("/me/dashboard"),
    onSuccess: (data) => {
      queryClient.setQueryData(DASHBOARD_KEY, data);
      setDraft(null);
      setConfirmReset(false);
      toast.success("Has vuelto a la pantalla inicial de tu rol.");
    },
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  if (query.isPending) return <LoadingBlock rows={4} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;

  const { layout, catalog, customized } = query.data;
  const editing = draft !== null;

  return (
    <>
      <PageHeader
        title="Inicio"
        actions={
          editing ? (
            <>
              <Button variant="outline" onClick={() => setDraft(null)} disabled={save.isPending}>
                <X aria-hidden /> Cancelar
              </Button>
              {customized ? (
                <Button variant="outline" onClick={() => setConfirmReset(true)}>
                  <RotateCcw aria-hidden /> Restaurar la del rol
                </Button>
              ) : null}
              <Button loading={save.isPending} onClick={() => save.mutate(draft)}>
                <Save aria-hidden /> Guardar
              </Button>
            </>
          ) : (
            <Button variant="outline" disabled={readOnly} onClick={() => setDraft(layout)}>
              <Pencil aria-hidden /> Personalizar
            </Button>
          )
        }
      />

      {editing ? (
        <LayoutEditor layout={draft} catalog={catalog} onChange={setDraft} />
      ) : layout.filter((item) => hasWidget(item.widget)).length === 0 ? (
        <EmptyState
          title="Tu pantalla inicial está vacía"
          description="Pulsa «Personalizar» para añadir widgets del catálogo."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4 lg:grid-cols-3">
          {layout.map((item) => {
            const Widget = WIDGET_REGISTRY[item.widget];
            if (!Widget) return null;
            return (
              <div key={item.widget} className={cn("min-w-0", SIZE_CLASSES[item.size])}>
                <Widget size={item.size} />
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Restaurar la pantalla de tu rol"
        description="Se descartará tu personalización y volverás a ver la pantalla inicial que la empresa ha definido para tu rol."
        confirmLabel="Restaurar"
        loading={restore.isPending}
        onConfirm={() => restore.mutate()}
      />
    </>
  );
}
