import {
  Activity,
  ArrowLeftRight,
  Bell,
  Boxes,
  CalendarDays,
  Building,
  Building2,
  ClipboardCheck,
  ClipboardList,
  Contact,
  CreditCard,
  FilePlus2,
  FolderCog,
  FileClock,
  FileText,
  Link2,
  Factory,
  Gauge,
  Home,
  IdCard,
  Mail,
  Package,
  PackagePlus,
  Percent,
  Scale,
  ShieldCheck,
  Tags,
  Tractor,
  Truck,
  Users,
  UserCog,
  Warehouse,
  type LucideIcon,
} from "lucide-react";

import type { Me } from "@/types/api";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Permiso necesario (clave en `me.permissions`). */
  permission?: string;
  /** Módulo que debe estar activo en la empresa. */
  module?: string;
}

export interface NavGroup {
  label: string | null;
  items: NavItem[];
}

/** Menú de la empresa. Las fases siguientes añaden aquí sus grupos (pedidos, CRM...). */
const TENANT_NAV: NavGroup[] = [
  { label: null, items: [{ href: "/inicio", label: "Inicio", icon: Home }] },
  {
    label: "Pedidos",
    items: [
      { href: "/pedidos", label: "Pedidos", icon: ClipboardList, permission: "pedidos.ver", module: "ventas" },
      { href: "/pedidos/nuevo", label: "Nuevo pedido", icon: FilePlus2, permission: "pedidos.crear", module: "ventas" },
      { href: "/pedidos/validar", label: "Por validar", icon: ClipboardCheck, permission: "pedidos.validar", module: "ventas" },
    ],
  },
  {
    label: "Logística",
    items: [
      { href: "/logistica", label: "Planificación", icon: CalendarDays, permission: "logistica.ver", module: "logistica" },
      { href: "/logistica/cargas", label: "Cargas", icon: Truck, permission: "logistica.ver", module: "logistica" },
    ],
  },
  {
    label: "Facturación",
    items: [
      { href: "/facturacion/pendiente", label: "Pendiente de facturar", icon: FileClock, permission: "facturas.emitir", module: "facturacion" },
      { href: "/facturacion/facturas", label: "Facturas", icon: FileText, permission: "facturas.ver", module: "facturacion" },
      { href: "/facturacion/verifactu", label: "Verifactu", icon: Link2, permission: "facturas.ver", module: "facturacion" },
    ],
  },
  {
    label: "Maestros",
    items: [
      { href: "/maestros/clientes", label: "Clientes", icon: Contact, permission: "maestros.ver" },
      { href: "/maestros/explotaciones", label: "Explotaciones", icon: Tractor, permission: "maestros.ver" },
      { href: "/maestros/articulos", label: "Artículos", icon: Package, permission: "maestros.ver" },
      { href: "/maestros/silos", label: "Silos y almacenes", icon: Warehouse, permission: "maestros.ver" },
      { href: "/maestros/tarifas", label: "Tarifas", icon: Tags, permission: "maestros.ver" },
      { href: "/maestros/transportistas", label: "Transportistas", icon: Building, permission: "maestros.ver" },
      { href: "/maestros/camiones", label: "Camiones", icon: Truck, permission: "maestros.ver" },
      { href: "/maestros/conductores", label: "Conductores", icon: IdCard, permission: "maestros.ver" },
      { href: "/maestros/iva", label: "Tipos de IVA", icon: Percent, permission: "maestros.ver" },
      { href: "/maestros/formas-pago", label: "Formas de pago", icon: CreditCard, permission: "maestros.ver" },
    ],
  },
  {
    label: "Fábrica",
    items: [
      { href: "/fabrica/stock", label: "Stock", icon: Boxes, permission: "stock.ver", module: "fabrica" },
      { href: "/fabrica/movimientos", label: "Movimientos", icon: ArrowLeftRight, permission: "stock.ver", module: "fabrica" },
      { href: "/fabrica/entradas", label: "Entradas de MP", icon: PackagePlus, permission: "stock.ver", module: "fabrica" },
      { href: "/fabrica/fabricacion", label: "Fabricación", icon: Factory, permission: "fabricacion.ver", module: "fabrica" },
      { href: "/fabrica/cargas", label: "Cargas por pesar", icon: Scale, permission: "cargas.pesar", module: "logistica" },
    ],
  },
  {
    label: "Ajustes",
    items: [
      { href: "/ajustes/empresa", label: "Empresa", icon: Building2, permission: "empresa.configurar" },
      { href: "/ajustes/usuarios", label: "Usuarios", icon: Users, permission: "usuarios.ver" },
      { href: "/ajustes/roles", label: "Roles y permisos", icon: UserCog, permission: "usuarios.ver" },
      { href: "/ajustes/avisos", label: "Avisos", icon: Bell, permission: "notificaciones.configurar" },
      { href: "/ajustes/email", label: "Correo saliente", icon: Mail, permission: "empresa.configurar" },
      { href: "/ajustes/documentos", label: "Documentos", icon: FolderCog, permission: "empresa.configurar" },
      { href: "/ajustes/actividad", label: "Actividad", icon: Activity, permission: "auditoria.ver" },
    ],
  },
];

const PLATFORM_NAV: NavGroup[] = [
  {
    label: "Panel de Klyp",
    items: [
      { href: "/admin", label: "Resumen", icon: Gauge },
      { href: "/admin/empresas", label: "Empresas", icon: Building2 },
      { href: "/admin/email", label: "Correo global", icon: Mail },
    ],
  },
];

export const ACCOUNT_NAV: NavGroup = {
  label: "Mi cuenta",
  items: [
    { href: "/cuenta", label: "Perfil", icon: UserCog },
    { href: "/cuenta/seguridad", label: "Seguridad", icon: ShieldCheck },
    { href: "/cuenta/avisos", label: "Mis avisos", icon: Bell },
  ],
};

function isVisible(item: NavItem, me: Me): boolean {
  if (item.permission && !(item.permission in me.permissions)) return false;
  if (item.module && !me.modules.includes(item.module)) return false;
  return true;
}

/** Menú de la zona de empresa según permisos y módulos activos. */
export function buildTenantNav(me: Me): NavGroup[] {
  return TENANT_NAV.map((group) => ({ ...group, items: group.items.filter((item) => isVisible(item, me)) })).filter(
    (group) => group.items.length > 0,
  );
}

export function buildPlatformNav(): NavGroup[] {
  return PLATFORM_NAV;
}

function matchesPath(pathname: string, href: string): boolean {
  if (href === "/admin" || href === "/inicio" || href === "/cuenta" || href === "/logistica") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * ¿Está activo el enlace para la ruta actual? Si se pasan los enlaces hermanos, gana el más
 * específico: en `/pedidos/nuevo` se marca «Nuevo pedido» y no también «Pedidos».
 */
export function isActivePath(pathname: string, href: string, siblingHrefs: string[] = []): boolean {
  if (!matchesPath(pathname, href)) return false;
  return !siblingHrefs.some(
    (other) => other !== href && other.length > href.length && other.startsWith(href) && matchesPath(pathname, other),
  );
}
