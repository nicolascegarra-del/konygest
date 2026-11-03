"use client";

import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { optionLabel } from "@/hooks/use-master-lookups";
import { formatKg, parseDecimal } from "@/lib/format";
import type { LookupOption } from "@/types/fase1";

import type { FarmSiloValue, PriceLineValue } from "./types";

function RemoveButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <Button type="button" variant="ghost" size="icon" aria-label={label} onClick={onClick} disabled={disabled}>
      <Trash2 aria-hidden />
    </Button>
  );
}

/** Lista editable de números (compartimentos de un camión, días de vencimiento...). */
export function NumberListEditor({
  id,
  value,
  onChange,
  itemLabel,
  suffix,
  addLabel,
  showTotal,
  maxItems,
  disabled,
}: {
  id: string;
  value: string[];
  onChange: (next: string[]) => void;
  itemLabel: string;
  suffix?: string;
  addLabel: string;
  showTotal?: boolean;
  maxItems?: number;
  disabled?: boolean;
}) {
  const total = value.reduce((sum, text) => sum + (parseDecimal(text) ?? 0), 0);
  return (
    <div className="space-y-2" id={id}>
      {value.length === 0 ? <p className="text-sm text-muted-foreground">Sin elementos.</p> : null}
      <ul className="space-y-2">
        {value.map((text, index) => (
          <li key={index} className="flex items-center gap-2">
            <span className="w-28 shrink-0 text-sm text-muted-foreground">
              {itemLabel} {index + 1}
            </span>
            <div className="relative min-w-0 flex-1">
              <Input
                inputMode="decimal"
                value={text}
                disabled={disabled}
                aria-label={`${itemLabel} ${index + 1}${suffix ? ` (${suffix})` : ""}`}
                onChange={(event) => onChange(value.map((current, i) => (i === index ? event.target.value : current)))}
                className={suffix ? "pr-14" : undefined}
              />
              {suffix ? (
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  {suffix}
                </span>
              ) : null}
            </div>
            <RemoveButton
              label={`Quitar ${itemLabel.toLowerCase()} ${index + 1}`}
              disabled={disabled}
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || (maxItems !== undefined && value.length >= maxItems)}
          onClick={() => onChange([...value, ""])}
        >
          <Plus aria-hidden /> {addLabel}
        </Button>
        {showTotal ? (
          <p className="text-sm" aria-live="polite">
            Capacidad total: <strong>{formatKg(total)}</strong>
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Líneas artículo + precio (€/kg): tarifas y precios negociados de un cliente. */
export function PriceLinesEditor({
  id,
  value,
  onChange,
  items,
  disabled,
}: {
  id: string;
  value: PriceLineValue[];
  onChange: (next: PriceLineValue[]) => void;
  items: LookupOption[];
  disabled?: boolean;
}) {
  const update = (index: number, patch: Partial<PriceLineValue>) =>
    onChange(value.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  return (
    <div className="space-y-2" id={id}>
      {value.length === 0 ? <p className="text-sm text-muted-foreground">Sin precios.</p> : null}
      <ul className="space-y-3 sm:space-y-2">
        {value.map((line, index) => {
          const known = items.some((item) => item.id === line.item_id);
          return (
            <li key={index} className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[1fr_10rem_auto] sm:items-center">
              <Select
                value={line.item_id}
                disabled={disabled}
                aria-label={`Artículo de la línea ${index + 1}`}
                onChange={(event) => update(index, { item_id: event.target.value, label: undefined })}
                className="col-span-2 sm:col-span-1"
              >
                <option value="">Elige un artículo…</option>
                {line.item_id && !known ? (
                  <option value={line.item_id}>{line.label ?? "Artículo dado de baja"} (inactivo)</option>
                ) : null}
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {optionLabel(item)}
                  </option>
                ))}
              </Select>
              <div className="relative">
                <Input
                  inputMode="decimal"
                  value={line.price}
                  disabled={disabled}
                  aria-label={`Precio de la línea ${index + 1} (€/kg)`}
                  placeholder="0,0000"
                  onChange={(event) => update(index, { price: event.target.value })}
                  className="pr-14"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  €/kg
                </span>
              </div>
              <RemoveButton
                label={`Quitar la línea ${index + 1}`}
                disabled={disabled}
                onClick={() => onChange(value.filter((_, i) => i !== index))}
              />
            </li>
          );
        })}
      </ul>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => onChange([...value, { item_id: "", price: "" }])}
      >
        <Plus aria-hidden /> Añadir precio
      </Button>
    </div>
  );
}

/** Silos de destino de una explotación: nombre + capacidad opcional. */
export function FarmSilosEditor({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: FarmSiloValue[];
  onChange: (next: FarmSiloValue[]) => void;
  disabled?: boolean;
}) {
  const update = (index: number, patch: Partial<FarmSiloValue>) =>
    onChange(value.map((silo, i) => (i === index ? { ...silo, ...patch } : silo)));
  return (
    <div className="space-y-2" id={id}>
      {value.length === 0 ? <p className="text-sm text-muted-foreground">Sin silos de destino.</p> : null}
      <ul className="space-y-2">
        {value.map((silo, index) => (
          <li key={index} className="grid grid-cols-[1fr_8rem_auto] items-center gap-2">
            <Input
              value={silo.name}
              disabled={disabled}
              maxLength={50}
              aria-label={`Nombre del silo ${index + 1}`}
              placeholder={`Silo ${index + 1}`}
              onChange={(event) => update(index, { name: event.target.value })}
            />
            <div className="relative">
              <Input
                inputMode="decimal"
                value={silo.capacity_kg}
                disabled={disabled}
                aria-label={`Capacidad del silo ${index + 1} (kg)`}
                placeholder="Capacidad"
                onChange={(event) => update(index, { capacity_kg: event.target.value })}
                className="pr-9"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                kg
              </span>
            </div>
            <RemoveButton
              label={`Quitar el silo ${index + 1}`}
              disabled={disabled}
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            />
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => onChange([...value, { name: "", capacity_kg: "" }])}
      >
        <Plus aria-hidden /> Añadir silo
      </Button>
    </div>
  );
}
