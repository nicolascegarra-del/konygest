import type { ComponentType } from "react";

import { ProductionTodayWidget, StockBySiloWidget, StockShortagesWidget } from "./factory-widgets";
import {
  CompanySummaryWidget,
  NotificationsWidget,
  QuickLinksWidget,
  WelcomeWidget,
} from "./widgets";
import type { WidgetProps } from "./types";

/**
 * Registro de widgets de la pantalla inicial: código del backend -> componente.
 * Para añadir un widget en una fase nueva: crea el componente, regístralo aquí con el mismo
 * `code` que el catálogo del backend (app/core/catalog.py) y ya aparece en /inicio.
 * Los códigos sin componente se ignoran al pintar (el backend puede ir por delante).
 */
export const WIDGET_REGISTRY: Record<string, ComponentType<WidgetProps>> = {
  bienvenida: WelcomeWidget,
  accesos_rapidos: QuickLinksWidget,
  notificaciones: NotificationsWidget,
  resumen_empresa: CompanySummaryWidget,
  stock_por_silo: StockBySiloWidget,
  roturas_stock: StockShortagesWidget,
  fabricacion_hoy: ProductionTodayWidget,
};

export function hasWidget(code: string): boolean {
  return code in WIDGET_REGISTRY;
}
