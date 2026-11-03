"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useMemo } from "react";
import { Controller, useForm, type Control, type FieldErrors } from "react-hook-form";
import { toast } from "sonner";

import { Field, FieldError } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { optionLabel, useMasterLookups } from "@/hooks/use-master-lookups";
import { api } from "@/lib/api";
import { friendlyMessage, isApiError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import type { LookupOption, MasterLookups } from "@/types/fase1";

import { CustomerPicker } from "./customer-picker";
import { buildMasterSchema, toFormValues } from "./form-schema";
import { FarmSilosEditor, NumberListEditor, PriceLinesEditor } from "./list-editors";
import type { FarmSiloValue, FieldOption, MasterField, MasterFormValues, PriceLineValue, SelectField } from "./types";

type Payload = Record<string, unknown>;

/** Lo que necesita el diálogo de una definición de maestro. */
export interface MasterFormConfig {
  resource: string;
  fields: MasterField[];
  newLabel: string;
  editLabel: string;
  savedMessage: string;
}

interface MasterDialogProps {
  config: MasterFormConfig;
  /** Registro a editar (salida de la API) o `null` para dar de alta. */
  record: ({ id: string } & Record<string, unknown>) | null;
  description?: string;
  /** Valores fijos que no se muestran y se envían siempre (p. ej. `customer_id` en la ficha del cliente). */
  fixedValues?: Payload;
  onClose: () => void;
  onSaved: (saved: Payload) => void;
}

function selectOptions(field: SelectField, lookups: MasterLookups | undefined): FieldOption[] {
  if (field.options) return field.options;
  if (!field.lookup || !lookups) return [];
  const list: LookupOption[] = lookups[field.lookup] ?? [];
  return list
    .filter((option) => !field.lookupKind || option.kind === field.lookupKind)
    .map((option) => ({ value: option.id, label: optionLabel(option) }));
}

/**
 * Diálogo genérico de alta/edición de un maestro. Pinta los campos de la definición,
 * valida con Zod (los números se teclean con coma decimal) y envía la ficha completa:
 * POST `/masters/<resource>` al crear y PUT `/masters/<resource>/{id}` al editar.
 * Si el servidor señala un campo (`409 CONFLICT`, `400 INVALID_REFERENCE`), se marca en el formulario.
 */
export function MasterDialog({ config, record, description, fixedValues, onClose, onSaved }: MasterDialogProps) {
  const isEdit = record !== null;
  const fields = useMemo(
    () => config.fields.filter((field) => !fixedValues || !(field.name in fixedValues)),
    [config.fields, fixedValues],
  );
  const schema = useMemo(() => buildMasterSchema(fields), [fields]);
  const needsLookups = fields.some((field) => (field.type === "select" && field.lookup) || field.type === "price-lines");
  const lookups = useMasterLookups(needsLookups);

  const {
    control,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<MasterFormValues, unknown, Payload>({
    resolver: zodResolver(schema),
    defaultValues: toFormValues(fields, record),
  });

  const save = useMutation({
    mutationFn: (values: Payload) => {
      const body = { ...values, ...fixedValues };
      return record
        ? api.put<Payload>(`/masters/${config.resource}/${record.id}`, body)
        : api.post<Payload>(`/masters/${config.resource}`, body);
    },
    onSuccess: (saved) => {
      toast.success(config.savedMessage);
      onSaved(saved);
    },
    onError: (error) => {
      if (isApiError(error) && error.field && fields.some((field) => field.name === error.field)) {
        setError(error.field, { type: "server", message: friendlyMessage(error) });
      }
      toast.error(friendlyMessage(error));
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? config.editLabel : config.newLabel}</DialogTitle>
          <DialogDescription>{description ?? "Los campos marcados con * son obligatorios."}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit((values) => save.mutate(values))} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            {fields.map((field) => (
              <div
                key={field.name}
                className={cn(
                  (field.wide ||
                    field.type === "textarea" ||
                    field.type === "number-list" ||
                    field.type === "price-lines" ||
                    field.type === "farm-silos" ||
                    field.type === "customer") &&
                    "sm:col-span-2",
                )}
              >
                <MasterFieldInput
                  field={field}
                  control={control}
                  errors={errors}
                  lookups={lookups.data}
                  record={record}
                  disabled={save.isPending}
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" loading={save.isPending}>
              Guardar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function errorOf(errors: FieldErrors<MasterFormValues>, name: string): string | undefined {
  const error = errors[name];
  if (!error) return undefined;
  return typeof error.message === "string" ? error.message : undefined;
}

function MasterFieldInput({
  field,
  control,
  errors,
  lookups,
  record,
  disabled,
}: {
  field: MasterField;
  control: Control<MasterFormValues, unknown, Payload>;
  errors: FieldErrors<MasterFormValues>;
  lookups: MasterLookups | undefined;
  record: Record<string, unknown> | null;
  disabled: boolean;
}) {
  const id = `master-${field.name}`;
  const error = errorOf(errors, field.name);
  const label = field.required ? `${field.label} *` : field.label;

  if (field.type === "switch") {
    return (
      <Controller
        control={control}
        name={field.name}
        render={({ field: input }) => (
          <div className="flex min-h-11 items-center gap-3">
            <Switch id={id} checked={input.value === true} onCheckedChange={input.onChange} disabled={disabled} />
            <label htmlFor={id} className="text-sm">
              {field.label}
              {field.hint ? <span className="block text-xs text-muted-foreground">{field.hint}</span> : null}
            </label>
          </div>
        )}
      />
    );
  }

  if (field.type === "number-list" || field.type === "price-lines" || field.type === "farm-silos") {
    return (
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">{label}</legend>
        {field.hint ? <p className="mb-2 text-xs text-muted-foreground">{field.hint}</p> : null}
        <Controller
          control={control}
          name={field.name}
          render={({ field: input }) =>
            field.type === "number-list" ? (
              <NumberListEditor
                id={id}
                value={input.value as string[]}
                onChange={input.onChange}
                itemLabel={field.itemLabel}
                suffix={field.suffix}
                addLabel={field.addLabel}
                showTotal={field.showTotal}
                maxItems={field.maxItems}
                disabled={disabled}
              />
            ) : field.type === "price-lines" ? (
              <PriceLinesEditor
                id={id}
                value={input.value as PriceLineValue[]}
                onChange={input.onChange}
                items={(lookups?.items ?? []).filter((item) => !field.itemKind || item.kind === field.itemKind)}
                disabled={disabled}
              />
            ) : (
              <FarmSilosEditor id={id} value={input.value as FarmSiloValue[]} onChange={input.onChange} disabled={disabled} />
            )
          }
        />
        <FieldError message={error} />
      </fieldset>
    );
  }

  return (
    <Field label={label} htmlFor={id} error={error} hint={field.hint}>
      <Controller
        control={control}
        name={field.name}
        render={({ field: input }) => {
          const value = typeof input.value === "string" ? input.value : "";
          const common = {
            id,
            name: input.name,
            onBlur: input.onBlur,
            disabled,
            "aria-invalid": error ? true : undefined,
          };
          switch (field.type) {
            case "textarea":
              return (
                <Textarea {...common} value={value} maxLength={field.maxLength} onChange={(e) => input.onChange(e.target.value)} />
              );
            case "number":
              return (
                <div className="relative">
                  <Input
                    {...common}
                    inputMode="decimal"
                    autoComplete="off"
                    value={value}
                    onChange={(e) => input.onChange(e.target.value)}
                    className={field.suffix ? "pr-16" : undefined}
                  />
                  {field.suffix ? (
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                      {field.suffix}
                    </span>
                  ) : null}
                </div>
              );
            case "select": {
              const options = selectOptions(field, lookups);
              const known = !value || options.some((option) => option.value === value);
              return (
                <Select {...common} value={value} onChange={(e) => input.onChange(e.target.value)}>
                  {field.emptyLabel !== undefined || !value ? (
                    <option value="">{field.emptyLabel ?? "Elige una opción…"}</option>
                  ) : null}
                  {!known ? <option value={value}>Valor actual (dado de baja)</option> : null}
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              );
            }
            case "customer": {
              const initial = record?.[field.labelFrom];
              return (
                <CustomerPicker
                  id={id}
                  value={value}
                  onChange={input.onChange}
                  initialLabel={typeof initial === "string" ? initial : undefined}
                  disabled={disabled}
                  invalid={!!error}
                />
              );
            }
            default:
              return (
                <Input
                  {...common}
                  type={field.inputType ?? "text"}
                  autoComplete="off"
                  maxLength={field.maxLength}
                  placeholder={field.placeholder}
                  value={value}
                  onChange={(e) => input.onChange(e.target.value)}
                  className={field.uppercase ? "uppercase" : undefined}
                />
              );
          }
        }}
      />
    </Field>
  );
}
