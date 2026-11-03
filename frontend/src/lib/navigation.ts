import {
  Activity,
  Bell,
  Building2,
  Gauge,
  Home,
  Mail,
  ShieldCheck,
  Users,
  UserCog,
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

/** Menú de la empresa. Las fases siguientes añaden aquí sus grupos (pedidos, fábrica...). */
const TENANT_NAV: NavGroup[] = [
  { label: null, items: [{ href: "/inicio", label: "Inicio", icon: Home }] },
  {
    label: "Ajustes",
    items: [
      { href: "/ajustes/empresa", label: "Empresa", icon: Building2, permission: "empresa.configurar" },
      { href: "/ajustes/usuarios", label: "Usuarios", icon: Users, permission: "usuarios.ver" },
      { href: "/ajustes/roles", label: "Roles y permisos", icon: UserCog, permission: "usuarios.ver" },
      { href: "/ajustes/avisos", label: "Avisos", icon: Bell, permission: "notificaciones.configurar" },
      { href: "/ajustes/email", label: "Correo saliente", icon: Mail, permission: "empresa.configurar" },
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

/** ¿Está activo el enlace para la ruta actual? */
export function isActivePath(pathname: string, href: string): boolean {
  if (href === "/admin" || href === "/inicio" || href === "/cuenta") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}
