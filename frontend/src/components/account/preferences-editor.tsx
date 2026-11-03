"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { EmptyState, ErrorState, LoadingBlock } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { friendlyMessage } from "@/lib/errors";
import type { NotificationPreference } from "@/types/api";

const CHANNELS = [
  { key: "in_app", label: "En la app" },
  { key: "email", label: "Email" },
  { key: "push", label: "Push" },
] as const;

type ChannelKey = (typeof CHANNELS)[number]["key"];

/** Editor de tipo de aviso x canal. Sirve para las preferencias propias y para las de la empresa. */
export function PreferencesEditor({ endpoint, queryKey }: { endpoint: string; queryKey: readonly string[] }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<NotificationPreference[] | null>(null);

  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.get<NotificationPreference[]>(endpoint, undefined, signal),
  });

  const save = useMutation({
    mutationFn: (items: NotificationPreference[]) => api.put<NotificationPreference[]>(endpoint, items),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      setDraft(null);
      toast.success("Preferencias guardadas.");
    },
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  if (query.isPending) return <LoadingBlock rows={4} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  if (query.data.length === 0) return <EmptyState title="Todavía no hay tipos de aviso" />;

  const items = draft ?? query.data;

  function toggle(type: string, channel: ChannelKey, value: boolean): void {
    setDraft(items.map((item) => (item.type === type ? { ...item, [channel]: value } : item)));
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.type}>
            <Card>
              <CardContent className="flex flex-col gap-3 pt-4 md:flex-row md:items-center md:justify-between md:pt-6">
                <p className="font-medium">{item.name}</p>
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  {CHANNELS.map((channel) => {
                    const id = `${item.type}-${channel.key}`;
                    return (
                      <div key={channel.key} className="flex min-h-11 items-center gap-2">
                        <Switch
                          id={id}
                          checked={item[channel.key]}
                          onCheckedChange={(value) => toggle(item.type, channel.key, value)}
                          aria-label={`${item.name}: ${channel.label}`}
                        />
                        <label htmlFor={id} className="text-sm">
                          {channel.label}
                        </label>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-2">
        {draft ? (
          <Button variant="outline" onClick={() => setDraft(null)}>
            Descartar cambios
          </Button>
        ) : null}
        <Button disabled={!draft} loading={save.isPending} onClick={() => draft && save.mutate(draft)}>
          Guardar
        </Button>
      </div>
    </div>
  );
}
