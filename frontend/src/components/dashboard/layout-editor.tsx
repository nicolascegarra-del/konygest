"use client";

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import type { WidgetCatalogEntry, WidgetItem, WidgetSize } from "@/types/api";

import { WIDGET_SIZE_LABELS } from "./types";

interface LayoutEditorProps {
  layout: WidgetItem[];
  catalog: WidgetCatalogEntry[];
  onChange: (layout: WidgetItem[]) => void;
}

interface SortableRowProps {
  item: WidgetItem;
  entry: WidgetCatalogEntry | undefined;
  index: number;
  total: number;
  onSize: (size: WidgetSize) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}

function SortableRow({ item, entry, index, total, onSize, onRemove, onMove }: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.widget });
  const name = entry?.name ?? item.widget;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3 ${isDragging ? "z-10 shadow-lg" : ""}`}
      data-testid={`layout-row-${item.widget}`}
    >
      <button
        type="button"
        className="inline-flex size-11 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:bg-accent active:cursor-grabbing"
        aria-label={`Arrastrar ${name}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" aria-hidden />
      </button>
      <div className="min-w-0 flex-1 basis-40">
        <p className="truncate text-sm font-medium">{name}</p>
        {entry?.description ? <p className="truncate text-xs text-muted-foreground">{entry.description}</p> : null}
      </div>
      <Select
        aria-label={`Tamaño de ${name}`}
        value={item.size}
        onChange={(event) => onSize(event.target.value as WidgetSize)}
        className="w-32"
      >
        {(Object.keys(WIDGET_SIZE_LABELS) as WidgetSize[]).map((size) => (
          <option key={size} value={size}>
            {WIDGET_SIZE_LABELS[size]}
          </option>
        ))}
      </Select>
      <div className="flex items-center">
        <Button variant="ghost" size="icon" disabled={index === 0} onClick={() => onMove(-1)} aria-label={`Subir ${name}`}>
          <ArrowUp aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          disabled={index === total - 1}
          onClick={() => onMove(1)}
          aria-label={`Bajar ${name}`}
        >
          <ArrowDown aria-hidden />
        </Button>
        <Button variant="ghost" size="icon" onClick={onRemove} aria-label={`Quitar ${name}`}>
          <Trash2 aria-hidden />
        </Button>
      </div>
    </li>
  );
}

/**
 * Editor del orden, tamaño y contenido de la pantalla inicial. Se usa en /inicio (personalizar)
 * y en el editor de roles (pantalla inicial por defecto del rol).
 */
export function LayoutEditor({ layout, catalog, onChange }: LayoutEditorProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const catalogByCode = new Map(catalog.map((entry) => [entry.code, entry]));
  const available = catalog.filter((entry) => !layout.some((item) => item.widget === entry.code));

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = layout.findIndex((item) => item.widget === active.id);
    const to = layout.findIndex((item) => item.widget === over.id);
    if (from < 0 || to < 0) return;
    onChange(arrayMove(layout, from, to));
  }

  function move(index: number, direction: -1 | 1): void {
    const target = index + direction;
    if (target < 0 || target >= layout.length) return;
    onChange(arrayMove(layout, index, target));
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby="layout-current">
        <h2 id="layout-current" className="mb-2 text-sm font-semibold">
          En la pantalla ({layout.length})
        </h2>
        {layout.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No hay widgets. Añade alguno del catálogo.
          </p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={layout.map((item) => item.widget)} strategy={verticalListSortingStrategy}>
              <ul className="space-y-2">
                {layout.map((item, index) => (
                  <SortableRow
                    key={item.widget}
                    item={item}
                    entry={catalogByCode.get(item.widget)}
                    index={index}
                    total={layout.length}
                    onSize={(size) => onChange(layout.map((current) => (current === item ? { ...current, size } : current)))}
                    onRemove={() => onChange(layout.filter((current) => current !== item))}
                    onMove={(direction) => move(index, direction)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </section>

      <section aria-labelledby="layout-catalog">
        <h2 id="layout-catalog" className="mb-2 text-sm font-semibold">
          Catálogo
        </h2>
        {available.length === 0 ? (
          <p className="text-sm text-muted-foreground">Ya has añadido todos los widgets disponibles.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {available.map((entry) => (
              <li key={entry.code} className="flex items-center gap-3 rounded-lg border p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{entry.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{entry.description}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onChange([...layout, { widget: entry.code, size: "md" }])}
                  aria-label={`Añadir ${entry.name}`}
                >
                  <Plus aria-hidden /> Añadir
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
