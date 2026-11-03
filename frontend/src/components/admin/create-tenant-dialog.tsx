"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { Field } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/input";
import { api } from "@/lib/api";
import { friendlyMessage } from "@/lib/errors";
import { TENANT_STATUS_LABELS, TENANT_STATUSES } from "@/lib/labels";
import { emailSchema } from "@/lib/schemas";
import type { Tenant } from "@/types/api";

const schema = z.object({
  name: z.string().trim().min(2, "Indica el nombre de la empresa.").max(150),
  tax_id: z.string().trim().max(30),
  admin_name: z.string().trim().min(2, "Indica el nombre del administrador."),
  admin_email: emailSchema,
  status: z.enum(["trial", "active", "past_due", "disabled"]),
});
type Values = z.infer<typeof schema>;

export function CreateTenantDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", tax_id: "", admin_name: "", admin_email: "", status: "trial" },
  });

  const create = useMutation({
    mutationFn: (values: Values) =>
      api.post<Tenant>("/admin/tenants", { ...values, tax_id: values.tax_id || undefined }),
    onSuccess: (tenant) => {
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
      toast.success("Empresa creada. Se ha enviado la invitación a su administrador.");
      onClose();
      router.push(`/admin/empresas/${tenant.id}`);
    },
    onError: (error) => toast.error(friendlyMessage(error)),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nueva empresa</DialogTitle>
          <DialogDescription>Se invitará por email a su primer administrador.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit((values) => create.mutate(values))} className="space-y-4" noValidate>
          <Field label="Nombre de la empresa" htmlFor="tenant-name" error={errors.name?.message}>
            <Input id="tenant-name" autoComplete="off" {...register("name")} />
          </Field>
          <Field label="CIF / NIF (opcional)" htmlFor="tenant-tax" error={errors.tax_id?.message}>
            <Input id="tenant-tax" autoComplete="off" {...register("tax_id")} />
          </Field>
          <Field label="Nombre del administrador" htmlFor="admin-name" error={errors.admin_name?.message}>
            <Input id="admin-name" autoComplete="off" {...register("admin_name")} />
          </Field>
          <Field label="Email del administrador" htmlFor="admin-email" error={errors.admin_email?.message}>
            <Input id="admin-email" type="email" autoComplete="off" {...register("admin_email")} />
          </Field>
          <Field label="Estado inicial" htmlFor="tenant-status">
            <Select id="tenant-status" {...register("status")}>
              {TENANT_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {TENANT_STATUS_LABELS[value]}
                </option>
              ))}
            </Select>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={create.isPending}>
              Crear empresa
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
