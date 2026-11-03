import "@testing-library/jest-dom/vitest";

// jsdom no implementa ResizeObserver y algunos primitivos de Radix (Switch) lo usan.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
