import { cn } from "@/lib/utils";

/** Marca Konygest. El logo usa Nunito SemiBold (tipografía reservada a la marca). */
export function Logo({ className, onDark = false }: { className?: string; onDark?: boolean }) {
  return (
    <span
      className={cn(
        "font-logo text-xl font-semibold tracking-tight",
        onDark ? "text-white" : "text-heading",
        className,
      )}
    >
      Kony<span className="text-klyp-accent dark:text-[#7db2f0]">gest</span>
    </span>
  );
}
