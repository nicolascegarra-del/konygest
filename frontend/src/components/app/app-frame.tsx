"use client";

import { useQueryClient } from "@tanstack/react-query";
import { LogOut, Menu, ShieldCheck, UserCog, Bell, User as UserIcon, Lock } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { NotificationBell } from "@/components/app/notification-bell";
import { Logo } from "@/components/common/logo";
import { ThemeToggle } from "@/components/common/theme-toggle";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { logout, reloadMe } from "@/lib/auth";
import { friendlyMessage } from "@/lib/errors";
import { initials } from "@/lib/format";
import { ACCOUNT_NAV, isActivePath, type NavGroup } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";
import type { Me } from "@/types/api";

function NavLinks({ groups, onNavigate }: { groups: NavGroup[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Principal" className="space-y-5">
      {groups.map((group) => (
        <div key={group.label ?? "root"}>
          {group.label ? (
            <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wide text-sidebar-foreground/60">
              {group.label}
            </p>
          ) : null}
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = isActivePath(
                pathname,
                item.href,
                group.items.map((sibling) => sibling.href),
              );
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-11 items-center gap-3 rounded-md px-3 text-sm text-sidebar-foreground/85 hover:bg-white/10 hover:text-white",
                      active && "bg-klyp-accent text-white hover:bg-klyp-accent",
                    )}
                  >
                    <item.icon className="size-4 shrink-0" aria-hidden />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function SidebarBrand({ subtitle }: { subtitle: string | null }) {
  return (
    <div className="px-3 pb-4">
      <Logo onDark />
      {subtitle ? <p className="mt-0.5 truncate text-xs text-sidebar-foreground/70">{subtitle}</p> : null}
    </div>
  );
}

function StatusBanners({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);

  async function leaveSupport(): Promise<void> {
    setLeaving(true);
    try {
      const restored = useAuthStore.getState().exitSupport();
      if (!restored) throw new Error("Sin sesión propia que restaurar");
      queryClient.clear();
      await reloadMe();
      router.replace("/admin");
    } catch (error) {
      toast.error(friendlyMessage(error));
    } finally {
      setLeaving(false);
    }
  }

  return (
    <>
      {me.support_mode ? (
        <div className="flex flex-wrap items-center justify-between gap-2 bg-warning px-4 py-2 text-sm font-medium text-black" role="status">
          <span className="flex items-center gap-2">
            <ShieldCheck className="size-4" aria-hidden />
            Modo soporte{me.tenant ? `: estás dentro de ${me.tenant.name}` : ""}. Tus acciones quedan registradas.
          </span>
          <Button size="sm" variant="secondary" loading={leaving} onClick={leaveSupport}>
            Salir del modo soporte
          </Button>
        </div>
      ) : null}
      {me.read_only ? (
        <div className="flex items-center gap-2 bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground" role="status">
          <Lock className="size-4 shrink-0" aria-hidden />
          La suscripción tiene un pago pendiente: la cuenta está en solo lectura.
        </div>
      ) : null}
    </>
  );
}

function UserMenu({ me }: { me: Me }) {
  const router = useRouter();
  const queryClient = useQueryClient();

  async function handleLogout(): Promise<void> {
    try {
      await logout();
    } catch (error) {
      toast.error(friendlyMessage(error));
    } finally {
      queryClient.clear();
      router.replace("/login");
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="gap-2 px-2" aria-label="Menú de usuario">
          <span className="flex size-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
            {initials(me.full_name)}
          </span>
          <span className="hidden max-w-40 truncate text-sm md:inline">{me.full_name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          <span className="block truncate">{me.full_name}</span>
          <span className="block truncate text-xs font-normal text-muted-foreground">{me.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push("/cuenta")}>
          <UserIcon aria-hidden /> Perfil
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => router.push("/cuenta/seguridad")}>
          <UserCog aria-hidden /> Seguridad
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => router.push("/cuenta/avisos")}>
          <Bell aria-hidden /> Mis avisos
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void handleLogout()}>
          <LogOut aria-hidden /> Cerrar sesión
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Marco común de la zona autenticada: sidebar en escritorio, menú hamburguesa en móvil. */
export function AppFrame({
  groups,
  subtitle,
  withBell = true,
  children,
}: {
  groups: NavGroup[];
  subtitle: string | null;
  withBell?: boolean;
  children: ReactNode;
}) {
  const me = useAuthStore((state) => state.user);
  const [menuOpen, setMenuOpen] = useState(false);
  if (!me) return null;

  const allGroups = [...groups, ACCOUNT_NAV];

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_1fr]">
      <aside className="hidden bg-sidebar p-3 pt-5 text-sidebar-foreground lg:sticky lg:top-0 lg:block lg:h-dvh lg:overflow-y-auto">
        <SidebarBrand subtitle={subtitle} />
        <NavLinks groups={allGroups} />
      </aside>
      <div className="flex min-w-0 flex-col">
        <StatusBanners me={me} />
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-2 border-b bg-background/95 px-3 backdrop-blur md:px-6">
          <div className="flex items-center gap-1 lg:hidden">
            <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
              <Button variant="ghost" size="icon" onClick={() => setMenuOpen(true)} aria-label="Abrir menú">
                <Menu aria-hidden />
              </Button>
              <DialogContent side="left" className="bg-sidebar text-sidebar-foreground">
                <DialogTitle className="sr-only">Menú de navegación</DialogTitle>
                <div className="p-3 pt-6">
                  <SidebarBrand subtitle={subtitle} />
                  <NavLinks groups={allGroups} onNavigate={() => setMenuOpen(false)} />
                </div>
              </DialogContent>
            </Dialog>
            <Logo className="text-lg" />
          </div>
          <p className="hidden truncate text-sm text-muted-foreground lg:block">{subtitle}</p>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            {withBell ? <NotificationBell /> : null}
            <UserMenu me={me} />
          </div>
        </header>
        <main className="flex-1 p-3 md:p-6">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
