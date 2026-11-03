import type { WidgetSize } from "@/types/api";

export interface WidgetProps {
  size: WidgetSize;
}

export const WIDGET_SIZE_LABELS: Record<WidgetSize, string> = {
  sm: "Pequeño",
  md: "Mediano",
  lg: "Grande",
};
