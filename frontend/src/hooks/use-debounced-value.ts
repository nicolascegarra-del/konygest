"use client";

import { useEffect, useState } from "react";

/** Devuelve `value` tras `delayMs` sin cambios (para búsquedas que consultan la API). */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
