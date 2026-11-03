"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Input, Select } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { api } from "@/lib/api";
import type { Page } from "@/types/api";
import type { Customer } from "@/types/fase1";

/**
 * Selector de cliente con búsqueda en el servidor (los clientes no van en `/masters/lookups`
 * porque pueden ser miles). Muestra los 20 primeros que coinciden y conserva el elegido.
 */
export function CustomerPicker({
  id,
  value,
  onChange,
  initialLabel,
  disabled,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (customerId: string) => void;
  initialLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [selectedLabel, setSelectedLabel] = useState(initialLabel ?? "");
  const debounced = useDebouncedValue(search.trim());
  const query = useQuery({
    queryKey: ["masters", "customers", "picker", debounced],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api.get<Page<Customer>>("/masters/customers", { search: debounced, active: true, limit: 20 }, signal),
  });
  const options = query.data?.items ?? [];
  const selectedInResults = options.some((customer) => customer.id === value);

  return (
    <div className="space-y-2">
      <Input
        type="search"
        value={search}
        disabled={disabled}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Buscar cliente por código, nombre o NIF"
        aria-label="Buscar cliente"
      />
      <Select
        id={id}
        value={value}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          const customer = options.find((option) => option.id === event.target.value);
          setSelectedLabel(customer ? `${customer.code} · ${customer.name}` : "");
          onChange(event.target.value);
        }}
      >
        <option value="">{query.isPending ? "Cargando clientes…" : "Elige un cliente…"}</option>
        {value && !selectedInResults ? <option value={value}>{selectedLabel || "Cliente actual"}</option> : null}
        {options.map((customer) => (
          <option key={customer.id} value={customer.id}>
            {customer.code} · {customer.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
