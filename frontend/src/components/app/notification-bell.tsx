"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { friendlyMessage } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { NotificationItem, Page } from "@/types/api";

export const NOTIFICATIONS_KEY = ["notifications"] as const;

/** Solo se navega a rutas internas: el campo `link` viene del servidor. */
export function safeInternalPath(link: string | null): string | null {
  if (!link || !link.startsWith("/") || link.startsWith("//")) return null;
  return link;
}

export function NotificationBell() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const unread = useQuery({
    queryKey: [...NOTIFICATIONS_KEY, "unread-count"],
    queryFn: ({ signal }) => api.get<{ unread: number }>("/notifications/unread-count", undefined, signal),
    refetchInterval: 30_000,
  });

  const list = useQuery({
    queryKey: [...NOTIFICATIONS_KEY, "list"],
    enabled: open,
    queryFn: ({ signal }) => api.get<Page<NotificationItem>>("/notifications", { limit: 20 }, signal),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });

  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: refresh,
    onError: (error) => toast.error(friendlyMessage(error)),
  });
  const markAll = useMutation({
    mutationFn: () => api.post("/notifications/read-all"),
    onSuccess: refresh,
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  const count = unread.data?.unread ?? 0;

  function openNotification(item: NotificationItem): void {
    if (!item.read_at) markRead.mutate(item.id);
    const path = safeInternalPath(item.link);
    if (path) {
      setOpen(false);
      router.push(path);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={count > 0 ? `Avisos, ${count} sin leer` : "Avisos"}
        >
          <Bell aria-hidden />
          {count > 0 ? (
            <span className="absolute right-1 top-1 flex min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[11px] font-semibold leading-5 text-destructive-foreground">
              {count > 99 ? "99+" : count}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="flex items-center justify-between border-b px-4 py-2">
          <h2 className="text-sm font-semibold">Avisos</h2>
          <Button
            variant="ghost"
            size="sm"
            disabled={count === 0}
            loading={markAll.isPending}
            onClick={() => markAll.mutate()}
          >
            <CheckCheck aria-hidden /> Marcar todos
          </Button>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {list.isPending ? (
            <div className="p-4">
              <LoadingBlock rows={3} />
            </div>
          ) : list.isError ? (
            <div className="p-4">
              <ErrorState error={list.error} onRetry={() => list.refetch()} />
            </div>
          ) : list.data.items.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No tienes avisos" description="Cuando pase algo importante lo verás aquí." />
            </div>
          ) : (
            <ul>
              {list.data.items.map((item) => (
                <li key={item.id} className="border-b last:border-b-0">
                  <button
                    type="button"
                    onClick={() => openNotification(item)}
                    className={cn(
                      "flex min-h-11 w-full flex-col gap-0.5 px-4 py-3 text-left hover:bg-accent",
                      !item.read_at && "bg-primary/5",
                    )}
                  >
                    <span className="flex items-start gap-2 text-sm">
                      {!item.read_at ? (
                        <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-label="Sin leer" />
                      ) : null}
                      <span className={cn(!item.read_at && "font-semibold")}>{item.title}</span>
                    </span>
                    {item.body ? <span className="text-sm text-muted-foreground">{item.body}</span> : null}
                    <span className="text-xs text-muted-foreground">{formatDateTime(item.created_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
