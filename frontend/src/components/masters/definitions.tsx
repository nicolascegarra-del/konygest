import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { formatKg, formatMoney, formatPercent, formatPrice } from "@/lib/format";
import { ITEM_KIND_LABELS, SILO_KIND_LABELS } from "@/lib/labels";
import type {
  Carrier,
  Customer,
  Driver,
  Farm,
  Item,
  MasterRecord,
  PaymentMethod,
  PriceList,
  Silo,
  Truck,
  VatRate,
} from "@/types/fase1";

import type { AnyMasterDefinition, FieldOption, MasterDefinition, MasterField } from "./types";

/**
 * Borra el tipo de fila de una definición para guardarla en el registro común. Es seguro:
 * cada definición solo recibe filas de su propio recurso.
 */
function defineMaster<T extends MasterRecord>(definition: MasterDefinition<T>): AnyMasterDefinition {
  return definition as unknown as AnyMasterDefinition;
}

const ACTIVE_FIELD: MasterField = {
  name: "is_active",
  type: "switch",
  label: "Activo",
  hint: "Desactívalo para dar de baja sin perder el histórico.",
};

const DEFAULT_FIELD: MasterField = {
  name: "is_default",
  type: "switch",
  label: "Predeterminado",
  hint: "Se propone por defecto en las fichas nuevas.",
};

const ITEM_KIND_OPTIONS: FieldOption[] = [
  { value: "product", label: ITEM_KIND_LABELS.product },
  { value: "raw_material", label: ITEM_KIND_LABELS.raw_material },
];

const SILO_KIND_OPTIONS: FieldOption[] = [
  { value: "silo", label: SILO_KIND_LABELS.silo },
  { value: "warehouse", label: SILO_KIND_LABELS.warehouse },
];

const ADDRESS_FIELDS: MasterField[] = [
  { name: "address", type: "text", label: "Dirección", maxLength: 300, wide: true },
  { name: "postal_code", type: "text", label: "Código postal", maxLength: 10 },
  { name: "city", type: "text", label: "Población", maxLength: 100 },
  { name: "province", type: "text", label: "Provincia", maxLength: 100 },
];

/** Título de fila con nombre y, debajo, un dato secundario. */
function titleCell(main: string, secondary?: string | null, href?: string) {
  return (
    <div className="min-w-0">
      {href ? (
        <Link href={href} className="block truncate font-medium text-link hover:underline">
          {main}
        </Link>
      ) : (
        <p className="truncate font-medium">{main}</p>
      )}
      {secondary ? <p className="truncate text-xs text-muted-foreground">{secondary}</p> : null}
    </div>
  );
}

function defaultBadge(isDefault: boolean) {
  return isDefault ? (
    <Badge variant="secondary" className="ml-2">
      Predeterminado
    </Badge>
  ) : null;
}

/** «Contado», «30 días», «30, 60 y 90 días». */
export function formatDueDays(days: number[]): string {
  if (days.length === 0) return "Contado";
  if (days.length === 1) return `${days[0]} días`;
  return `${days.slice(0, -1).join(", ")} y ${days[days.length - 1]} días`;
}

export const customerHref = (id: string) => `/maestros/clientes/${id}`;

export const CUSTOMER_FIELDS: MasterField[] = [
  { name: "code", type: "text", label: "Código", required: true, maxLength: 30 },
  { name: "name", type: "text", label: "Nombre o razón social", required: true },
  { name: "tax_id", type: "text", label: "NIF/CIF", maxLength: 20, nullable: true, uppercase: true },
  { name: "phone", type: "text", label: "Teléfono", inputType: "tel", maxLength: 30 },
  { name: "email", type: "text", label: "Email", inputType: "email", maxLength: 254 },
  ...ADDRESS_FIELDS,
  { name: "sales_rep_id", type: "select", label: "Comercial", lookup: "sales_reps", emptyLabel: "Sin comercial" },
  { name: "price_list_id", type: "select", label: "Tarifa", lookup: "price_lists", emptyLabel: "Precio general" },
  { name: "payment_method_id", type: "select", label: "Forma de pago", lookup: "payment_methods", emptyLabel: "Sin forma de pago" },
  { name: "credit_limit", type: "number", label: "Límite de crédito", min: 0, suffix: "€" },
  {
    name: "equivalence_surcharge",
    type: "switch",
    label: "Recargo de equivalencia",
    hint: "Comerciante minorista en recargo de equivalencia: sus facturas llevan el recargo de cada tipo de IVA.",
  },
  { name: "notes", type: "textarea", label: "Notas", maxLength: 2000 },
  ACTIVE_FIELD,
];

export const FARM_FIELDS: MasterField[] = [
  { name: "customer_id", type: "customer", label: "Cliente", required: true, labelFrom: "customer_name" },
  { name: "name", type: "text", label: "Nombre", required: true },
  { name: "rega_code", type: "text", label: "Código REGA", maxLength: 20, uppercase: true },
  ...ADDRESS_FIELDS,
  { name: "latitude", type: "number", label: "Latitud", min: -90, max: 90, decimals: 6, hint: "Por ejemplo 38,0235" },
  { name: "longitude", type: "number", label: "Longitud", min: -180, max: 180, decimals: 6, hint: "Por ejemplo -1,1302" },
  {
    name: "silos",
    type: "farm-silos",
    label: "Silos de destino",
    hint: "Silos de la explotación donde se descarga el pienso.",
  },
  { name: "notes", type: "textarea", label: "Notas", maxLength: 2000 },
  ACTIVE_FIELD,
];

const customers = defineMaster<Customer>({
  resource: "customers",
  title: "Clientes",
  description: "Ganaderos y empresas a los que vendes pienso.",
  newLabel: "Nuevo cliente",
  editLabel: "Editar cliente",
  savedMessage: "Cliente guardado.",
  searchPlaceholder: "Buscar por código, nombre, NIF o población",
  emptyTitle: "Todavía no hay clientes",
  emptyDescription: "Da de alta tus clientes para poder registrar sus explotaciones y precios.",
  filters: [{ name: "sales_rep_id", label: "Comercial", allLabel: "Todos los comerciales", lookup: "sales_reps" }],
  detailHref: (row) => customerHref(row.id),
  describe: (row) => `${row.code} · ${row.name}`,
  columns: [
    { key: "name", header: "Cliente", render: (row) => titleCell(row.name, row.code, customerHref(row.id)) },
    { key: "city", header: "Población", render: (row) => [row.city, row.province].filter(Boolean).join(", ") || "—" },
    { key: "rep", header: "Comercial", render: (row) => row.sales_rep_name ?? "—" },
    { key: "farms", header: "Explotaciones", render: (row) => row.farm_count },
  ],
  fields: CUSTOMER_FIELDS,
});

const farms = defineMaster<Farm>({
  resource: "farms",
  title: "Explotaciones",
  description: "Granjas de tus clientes, con sus silos de destino.",
  newLabel: "Nueva explotación",
  editLabel: "Editar explotación",
  savedMessage: "Explotación guardada.",
  searchPlaceholder: "Buscar por nombre, REGA o población",
  emptyTitle: "Todavía no hay explotaciones",
  emptyDescription: "Añade las explotaciones desde aquí o desde la ficha de cada cliente.",
  describe: (row) => `${row.name} · ${row.customer_name}`,
  columns: [
    { key: "name", header: "Explotación", render: (row) => titleCell(row.name, row.rega_code ? `REGA ${row.rega_code}` : null) },
    {
      key: "customer",
      header: "Cliente",
      render: (row) => (
        <Link href={customerHref(row.customer_id)} className="text-link hover:underline">
          {row.customer_name}
        </Link>
      ),
    },
    { key: "city", header: "Población", render: (row) => [row.city, row.province].filter(Boolean).join(", ") || "—" },
    { key: "silos", header: "Silos", render: (row) => row.silos.length },
  ],
  fields: FARM_FIELDS,
});

const items = defineMaster<Item>({
  resource: "items",
  title: "Artículos",
  description: "Piensos que fabricas y vendes y materias primas que compras.",
  newLabel: "Nuevo artículo",
  editLabel: "Editar artículo",
  savedMessage: "Artículo guardado.",
  searchPlaceholder: "Buscar por código o nombre",
  emptyTitle: "Todavía no hay artículos",
  emptyDescription: "Da de alta tus piensos y materias primas.",
  filters: [{ name: "kind", label: "Tipo", allLabel: "Piensos y materias primas", options: ITEM_KIND_OPTIONS }],
  describe: (row) => `${row.code} · ${row.name}`,
  columns: [
    { key: "name", header: "Artículo", render: (row) => titleCell(row.name, row.code) },
    {
      key: "kind",
      header: "Tipo",
      render: (row) => <Badge variant={row.kind === "product" ? "default" : "secondary"}>{ITEM_KIND_LABELS[row.kind]}</Badge>,
    },
    { key: "price", header: "Precio general", render: (row) => formatPrice(row.base_price) },
    { key: "min", header: "Stock mínimo", render: (row) => formatKg(row.min_stock_kg) },
  ],
  fields: [
    { name: "code", type: "text", label: "Código", required: true, maxLength: 30 },
    { name: "name", type: "text", label: "Nombre", required: true },
    { name: "kind", type: "select", label: "Tipo", required: true, options: ITEM_KIND_OPTIONS, defaultValue: "product" },
    { name: "vat_rate_id", type: "select", label: "IVA", lookup: "vat_rates", emptyLabel: "Sin IVA asignado" },
    { name: "base_price", type: "number", label: "Precio general", min: 0, decimals: 4, suffix: "€/kg", hint: "Precio de tarifa general." },
    { name: "min_stock_kg", type: "number", label: "Stock mínimo", required: true, defaultValue: 0, min: 0, suffix: "kg", hint: "Avisa cuando el stock baje de aquí." },
    { name: "description", type: "textarea", label: "Descripción", maxLength: 1000 },
    ACTIVE_FIELD,
  ],
});

const silos = defineMaster<Silo>({
  resource: "silos",
  title: "Silos y almacenes",
  description: "Dónde guardas el pienso fabricado y las materias primas.",
  newLabel: "Nuevo silo o almacén",
  editLabel: "Editar silo o almacén",
  savedMessage: "Silo guardado.",
  searchPlaceholder: "Buscar por código o nombre",
  emptyTitle: "Todavía no hay silos ni almacenes",
  emptyDescription: "Crea los silos de la fábrica para poder llevar el stock.",
  filters: [
    {
      name: "kind",
      label: "Tipo",
      allLabel: "Silos y almacenes",
      options: SILO_KIND_OPTIONS,
    },
  ],
  describe: (row) => `${row.code} · ${row.name}`,
  columns: [
    { key: "name", header: "Silo", render: (row) => titleCell(row.name, row.code) },
    { key: "kind", header: "Tipo", render: (row) => SILO_KIND_LABELS[row.kind] },
    { key: "capacity", header: "Capacidad", render: (row) => formatKg(row.capacity_kg) },
  ],
  fields: [
    { name: "code", type: "text", label: "Código", required: true, maxLength: 30 },
    { name: "name", type: "text", label: "Nombre", required: true },
    { name: "kind", type: "select", label: "Tipo", required: true, options: SILO_KIND_OPTIONS, defaultValue: "silo" },
    { name: "capacity_kg", type: "number", label: "Capacidad", positive: true, suffix: "kg" },
    ACTIVE_FIELD,
  ],
});

const priceLists = defineMaster<PriceList>({
  resource: "price-lists",
  title: "Tarifas",
  description: "Listas de precios por artículo que puedes asignar a los clientes.",
  newLabel: "Nueva tarifa",
  editLabel: "Editar tarifa",
  savedMessage: "Tarifa guardada.",
  searchPlaceholder: "Buscar por nombre",
  emptyTitle: "Todavía no hay tarifas",
  emptyDescription: "Sin tarifas se aplica el precio general de cada artículo.",
  describe: (row) => row.name,
  columns: [
    { key: "name", header: "Tarifa", render: (row) => titleCell(row.name, row.notes || null) },
    { key: "lines", header: "Precios", render: (row) => `${row.lines.length} ${row.lines.length === 1 ? "artículo" : "artículos"}` },
  ],
  fields: [
    { name: "name", type: "text", label: "Nombre", required: true, maxLength: 100 },
    { name: "notes", type: "textarea", label: "Notas", maxLength: 1000 },
    {
      name: "lines",
      type: "price-lines",
      label: "Precios por artículo",
      itemKind: "product",
      hint: "Los piensos sin línea usan su precio general.",
    },
    ACTIVE_FIELD,
  ],
});

const carriers = defineMaster<Carrier>({
  resource: "carriers",
  title: "Transportistas",
  description: "Empresas de transporte y tu flota propia.",
  newLabel: "Nuevo transportista",
  editLabel: "Editar transportista",
  savedMessage: "Transportista guardado.",
  searchPlaceholder: "Buscar por nombre",
  emptyTitle: "Todavía no hay transportistas",
  emptyDescription: "Añade tu flota propia y las empresas que te transportan.",
  describe: (row) => row.name,
  columns: [
    {
      key: "name",
      header: "Transportista",
      render: (row) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          {titleCell(row.name, row.tax_id)}
          {row.is_own_fleet ? <Badge variant="secondary">Flota propia</Badge> : null}
        </span>
      ),
    },
    { key: "phone", header: "Teléfono", render: (row) => row.phone || "—" },
    { key: "email", header: "Email", render: (row) => row.email || "—" },
  ],
  fields: [
    { name: "name", type: "text", label: "Nombre", required: true },
    { name: "tax_id", type: "text", label: "NIF/CIF", maxLength: 20, nullable: true, uppercase: true },
    { name: "phone", type: "text", label: "Teléfono", inputType: "tel", maxLength: 30 },
    { name: "email", type: "text", label: "Email", inputType: "email", maxLength: 254 },
    { name: "is_own_fleet", type: "switch", label: "Flota propia", hint: "Camiones de la propia fábrica." },
    ACTIVE_FIELD,
  ],
});

const trucks = defineMaster<Truck>({
  resource: "trucks",
  title: "Camiones",
  description: "Camiones cisterna con la capacidad de cada compartimento.",
  newLabel: "Nuevo camión",
  editLabel: "Editar camión",
  savedMessage: "Camión guardado.",
  searchPlaceholder: "Buscar por matrícula",
  emptyTitle: "Todavía no hay camiones",
  emptyDescription: "Da de alta los camiones con sus compartimentos.",
  filters: [{ name: "carrier_id", label: "Transportista", allLabel: "Todos los transportistas", lookup: "carriers" }],
  describe: (row) => row.plate,
  columns: [
    { key: "plate", header: "Matrícula", render: (row) => <span className="font-mono font-medium">{row.plate}</span> },
    { key: "carrier", header: "Transportista", render: (row) => row.carrier_name ?? "—" },
    { key: "compartments", header: "Compartimentos", render: (row) => row.compartments.length },
    { key: "capacity", header: "Capacidad", render: (row) => formatKg(row.capacity_kg) },
  ],
  fields: [
    { name: "plate", type: "text", label: "Matrícula", required: true, maxLength: 15, uppercase: true },
    { name: "carrier_id", type: "select", label: "Transportista", lookup: "carriers", emptyLabel: "Sin transportista" },
    {
      name: "compartments",
      type: "number-list",
      label: "Compartimentos",
      itemLabel: "Compartimento",
      addLabel: "Añadir compartimento",
      suffix: "kg",
      positive: true,
      max: 100_000,
      minItems: 1,
      maxItems: 12,
      showTotal: true,
      hint: "Capacidad de cada compartimento, en kg.",
    },
    { name: "notes", type: "textarea", label: "Notas", maxLength: 1000 },
    ACTIVE_FIELD,
  ],
});

const drivers = defineMaster<Driver>({
  resource: "drivers",
  title: "Conductores",
  description: "Conductores de los camiones.",
  newLabel: "Nuevo conductor",
  editLabel: "Editar conductor",
  savedMessage: "Conductor guardado.",
  searchPlaceholder: "Buscar por nombre",
  emptyTitle: "Todavía no hay conductores",
  emptyDescription: "Añade los conductores que reparten el pienso.",
  filters: [{ name: "carrier_id", label: "Transportista", allLabel: "Todos los transportistas", lookup: "carriers" }],
  describe: (row) => row.full_name,
  columns: [
    { key: "name", header: "Conductor", render: (row) => titleCell(row.full_name) },
    { key: "phone", header: "Teléfono", render: (row) => row.phone || "—" },
    { key: "carrier", header: "Transportista", render: (row) => row.carrier_name ?? "—" },
  ],
  fields: [
    { name: "full_name", type: "text", label: "Nombre completo", required: true },
    { name: "phone", type: "text", label: "Teléfono", inputType: "tel", maxLength: 30 },
    { name: "carrier_id", type: "select", label: "Transportista", lookup: "carriers", emptyLabel: "Sin transportista" },
    ACTIVE_FIELD,
  ],
});

export const VAT_RATE_FIELDS: MasterField[] = [
  { name: "name", type: "text", label: "Nombre", required: true, maxLength: 50, placeholder: "General, reducido…" },
  { name: "rate", type: "number", label: "Tipo de IVA", required: true, min: 0, max: 100, suffix: "%" },
  { name: "surcharge", type: "number", label: "Recargo de equivalencia", required: true, defaultValue: 0, min: 0, max: 100, suffix: "%" },
  DEFAULT_FIELD,
  ACTIVE_FIELD,
];

const vatRates = defineMaster<VatRate>({
  resource: "vat-rates",
  title: "Tipos de IVA",
  description: "Tipos de IVA y recargo de equivalencia que aplicas a los artículos.",
  newLabel: "Nuevo tipo de IVA",
  editLabel: "Editar tipo de IVA",
  savedMessage: "Tipo de IVA guardado.",
  searchPlaceholder: "Buscar por nombre",
  emptyTitle: "Todavía no hay tipos de IVA",
  emptyDescription: "Crea los tipos de IVA para asignarlos a los artículos.",
  describe: (row) => row.name,
  columns: [
    {
      key: "name",
      header: "Nombre",
      render: (row) => (
        <span className="font-medium">
          {row.name}
          {defaultBadge(row.is_default)}
        </span>
      ),
    },
    { key: "rate", header: "IVA", render: (row) => formatPercent(row.rate) },
    { key: "surcharge", header: "Recargo", render: (row) => formatPercent(row.surcharge) },
  ],
  fields: VAT_RATE_FIELDS,
});

const paymentMethods = defineMaster<PaymentMethod>({
  resource: "payment-methods",
  title: "Formas de pago",
  description: "Condiciones de pago con los días de cada vencimiento.",
  newLabel: "Nueva forma de pago",
  editLabel: "Editar forma de pago",
  savedMessage: "Forma de pago guardada.",
  searchPlaceholder: "Buscar por nombre",
  emptyTitle: "Todavía no hay formas de pago",
  emptyDescription: "Crea las formas de pago para asignarlas a los clientes.",
  describe: (row) => row.name,
  columns: [
    {
      key: "name",
      header: "Nombre",
      render: (row) => (
        <span className="font-medium">
          {row.name}
          {defaultBadge(row.is_default)}
        </span>
      ),
    },
    { key: "due", header: "Vencimientos", render: (row) => formatDueDays(row.due_days) },
  ],
  fields: [
    { name: "name", type: "text", label: "Nombre", required: true, maxLength: 100, placeholder: "Recibo a 30 y 60 días" },
    {
      name: "due_days",
      type: "number-list",
      label: "Vencimientos",
      itemLabel: "Vencimiento",
      addLabel: "Añadir vencimiento",
      suffix: "días",
      integer: true,
      min: 0,
      max: 365,
      maxItems: 12,
      hint: "Días desde la factura de cada vencimiento. Sin vencimientos = contado.",
    },
    DEFAULT_FIELD,
    ACTIVE_FIELD,
  ],
});

export const MASTER_DEFINITIONS = {
  customers,
  farms,
  items,
  silos,
  "price-lists": priceLists,
  carriers,
  trucks,
  drivers,
  "vat-rates": vatRates,
  "payment-methods": paymentMethods,
} satisfies Record<string, AnyMasterDefinition>;

export type MasterKey = keyof typeof MASTER_DEFINITIONS;

/** Muestra el límite de crédito en la ficha del cliente. */
export const formatCreditLimit = (value: number | null) => (value === null ? "Sin límite" : formatMoney(value));
