import type { ReactNode } from "react";

import type { DataColumn } from "@/components/common/data-list";
import type { ItemKind, LookupKey, MasterRecord } from "@/types/fase1";

export interface FieldOption {
  value: string;
  label: string;
}

interface BaseField {
  /** Nombre del campo en el JSON de la API. */
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  /** Ocupa las dos columnas del formulario en escritorio. */
  wide?: boolean;
}

export interface TextField extends BaseField {
  type: "text";
  maxLength?: number;
  inputType?: "text" | "email" | "tel";
  /** Envía `null` en vez de cadena vacía (campos opcionales con unicidad, como el NIF). */
  nullable?: boolean;
  uppercase?: boolean;
  placeholder?: string;
}

export interface TextareaField extends BaseField {
  type: "textarea";
  maxLength?: number;
}

export interface NumberField extends BaseField {
  type: "number";
  min?: number;
  max?: number;
  /** Mayor estrictamente que 0. */
  positive?: boolean;
  /** Decimales máximos permitidos (por defecto 2). */
  decimals?: number;
  suffix?: string;
  /** Valor inicial en altas. */
  defaultValue?: number;
}

export interface SelectField extends BaseField {
  type: "select";
  /** Opciones fijas... */
  options?: FieldOption[];
  /** ...o sacadas de `GET /masters/lookups`. */
  lookup?: LookupKey;
  /** Filtra las opciones del lookup por `kind`. */
  lookupKind?: string;
  /** Texto de la opción vacía (si existe, el valor vacío se envía como `null`). */
  emptyLabel?: string;
  /** Valor inicial en altas. */
  defaultValue?: string;
}

export interface SwitchField extends BaseField {
  type: "switch";
  /** Valor por defecto en altas (por defecto `false`; `is_active` siempre empieza en `true`). */
  defaultValue?: boolean;
}

export interface NumberListField extends BaseField {
  type: "number-list";
  /** Etiqueta de cada fila («Compartimento», «Vencimiento»...). */
  itemLabel: string;
  suffix?: string;
  integer?: boolean;
  /** Mínimo para cada valor (inclusive); con `positive`, mayor estricto que 0. */
  min?: number;
  max?: number;
  positive?: boolean;
  minItems?: number;
  maxItems?: number;
  /** Muestra la suma (capacidad total del camión). */
  showTotal?: boolean;
  addLabel: string;
}

export interface PriceLinesField extends BaseField {
  type: "price-lines";
  /** Tipo de artículo seleccionable (los precios de venta son de piensos). */
  itemKind?: ItemKind;
}

export interface FarmSilosField extends BaseField {
  type: "farm-silos";
}

export interface CustomerField extends BaseField {
  type: "customer";
  /** Campo del registro con el nombre del cliente actual (para mostrarlo al editar). */
  labelFrom: string;
}

export type MasterField =
  | TextField
  | TextareaField
  | NumberField
  | SelectField
  | SwitchField
  | NumberListField
  | PriceLinesField
  | FarmSilosField
  | CustomerField;

export interface PriceLineValue {
  item_id: string;
  price: string;
  /** Nombre del artículo cuando ya no está entre las opciones activas. */
  label?: string;
}

export interface FarmSiloValue {
  name: string;
  capacity_kg: string;
}

/** Valores del formulario tal y como los edita el usuario (los números como texto). */
export type MasterFormValues = Record<string, unknown>;

export interface MasterFilter {
  /** Parámetro de la query. */
  name: string;
  label: string;
  allLabel: string;
  options?: FieldOption[];
  lookup?: LookupKey;
}

export interface MasterDefinition<T extends MasterRecord> {
  /** Segmento de la API: `/masters/<resource>`. */
  resource: string;
  title: string;
  description: string;
  /** «Nuevo cliente», «Nueva tarifa»... */
  newLabel: string;
  /** «Editar cliente»... */
  editLabel: string;
  /** Mensaje tras guardar: «Cliente guardado.» */
  savedMessage: string;
  searchPlaceholder: string;
  emptyTitle: string;
  emptyDescription: string;
  columns: DataColumn<T>[];
  fields: MasterField[];
  filters?: MasterFilter[];
  /** Descripción del diálogo de edición (p. ej. el código). */
  describe?: (row: T) => string;
  /** Ficha de detalle propia (clientes). */
  detailHref?: (row: T) => string;
  /** Contenido extra bajo el título de la página. */
  intro?: ReactNode;
}

/** Definición con el tipo de fila borrado, para poder guardarlas juntas en un registro. */
export type AnyMasterDefinition = MasterDefinition<MasterRecord>;
