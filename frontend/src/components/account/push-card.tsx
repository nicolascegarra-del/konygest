"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing } from "lucide-react";
import { toast } from "sonner";

import { ErrorState, LoadingBlock } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { friendlyMessage } from "@/lib/errors";
import { disablePush, enablePush, getCurrentSubscription, isPushSupported } from "@/lib/push";

export function PushCard() {
  const queryClient = useQueryClient();

  const key = useQuery({
    queryKey: ["notifications", "push-key"],
    queryFn: ({ signal }) => api.get<{ public_key: string }>("/notifications/push/public-key", undefined, signal),
  });
  const subscription = useQuery({
    queryKey: ["notifications", "push-subscription"],
    queryFn: async () => (await getCurrentSubscription()) !== null,
  });

  const enable = useMutation({
    mutationFn: (publicKey: string) => enablePush(publicKey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications", "push-subscription"] });
      toast.success("Avisos push activados en este navegador.");
    },
    onError: (error) =>
      toast.error(
        error instanceof Error && error.message === "PERMISSION_DENIED"
          ? "El navegador ha bloqueado las notificaciones. Permítelas en los ajustes del sitio."
          : friendlyMessage(error),
      ),
  });
  const disable = useMutation({
    mutationFn: disablePush,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications", "push-subscription"] });
      toast.success("Avisos push desactivados en este navegador.");
    },
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  let body: React.ReactNode;
  if (key.isPending || subscription.isPending) {
    body = <LoadingBlock rows={1} />;
  } else if (key.isError) {
    body = <ErrorState error={key.error} onRetry={() => key.refetch()} />;
  } else if (!key.data.public_key) {
    body = <p className="text-sm text-muted-foreground">Los avisos push no están configurados en este servidor.</p>;
  } else if (!isPushSupported()) {
    body = <p className="text-sm text-muted-foreground">Este navegador no admite avisos push.</p>;
  } else if (subscription.data) {
    body = (
      <Button variant="outline" loading={disable.isPending} onClick={() => disable.mutate()}>
        Desactivar en este navegador
      </Button>
    );
  } else {
    const publicKey = key.data.public_key;
    body = (
      <Button loading={enable.isPending} onClick={() => enable.mutate(publicKey)}>
        <BellRing aria-hidden /> Activar en este navegador
      </Button>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Avisos push</CardTitle>
        <CardDescription>Recibe avisos en este dispositivo aunque no tengas Konygest abierto.</CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
