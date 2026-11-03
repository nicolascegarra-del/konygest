"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";

const noopSubscribe = () => () => {};

/** true solo en el cliente: el servidor no conoce el tema guardado en el navegador. */
function useIsClient(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

export function ThemeToggle({ className, onNavy = false }: { className?: string; onNavy?: boolean }) {
  const { resolvedTheme, setTheme } = useTheme();
  // En el servidor y en la primera pasada del cliente se pinta siempre lo mismo (modo claro),
  // para que la hidratación coincida; después se muestra el tema real.
  const isDark = useIsClient() && resolvedTheme === "dark";
  return (
    <Button
      variant="ghost"
      size="icon"
      className={onNavy ? `text-white hover:bg-white/10 hover:text-white ${className ?? ""}` : className}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
    >
      {isDark ? <Sun aria-hidden /> : <Moon aria-hidden />}
    </Button>
  );
}
