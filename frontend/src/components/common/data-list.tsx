import type { ReactNode } from "react";

export interface DataColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Columna de acciones: sin etiqueta en las tarjetas móviles. */
  isActions?: boolean;
}

/** Tabla en escritorio; en móvil, una tarjeta apilada por fila. La primera columna es el título. */
export function DataList<T>({
  rows,
  columns,
  rowKey,
}: {
  rows: T[];
  columns: DataColumn<T>[];
  rowKey: (row: T) => string;
}) {
  const [titleColumn, ...otherColumns] = columns;
  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border md:block">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              {columns.map((column) => (
                <th key={column.key} scope="col" className="px-4 py-3 font-medium">
                  {column.isActions ? <span className="sr-only">{column.header}</span> : column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr key={rowKey(row)} className="hover:bg-accent/40">
                {columns.map((column) => (
                  <td key={column.key} className="px-4 py-3 align-middle">
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-3 md:hidden">
        {rows.map((row) => (
          <li key={rowKey(row)} className="rounded-lg border bg-card p-4 shadow-sm">
            {titleColumn ? <div className="font-medium">{titleColumn.render(row)}</div> : null}
            <dl className="mt-2 space-y-1.5 text-sm">
              {otherColumns
                .filter((column) => !column.isActions)
                .map((column) => (
                  <div key={column.key} className="flex items-start justify-between gap-3">
                    <dt className="shrink-0 text-muted-foreground">{column.header}</dt>
                    <dd className="min-w-0 text-right">{column.render(row)}</dd>
                  </div>
                ))}
            </dl>
            {otherColumns
              .filter((column) => column.isActions)
              .map((column) => (
                <div key={column.key} className="mt-3 flex flex-wrap gap-2">
                  {column.render(row)}
                </div>
              ))}
          </li>
        ))}
      </ul>
    </>
  );
}
