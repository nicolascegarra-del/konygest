# API fase 1 — Maestros, stock y fabricación

Prefijo `/api/v1`. Errores en el formato estándar de Klyp (ver `api-fase0.md`).
Cantidades en **kg** y precios en **€/kg**; en JSON van como **número** (en BD son `Decimal`).
Fechas-hora en ISO 8601 UTC; fechas (`planned_date`) como `YYYY-MM-DD`.
Listados paginados: `?offset=0&limit=50` (máx. 200) → `{items, total, offset, limit}`.

## Maestros (`maestros.ver` para leer, `maestros.gestionar` para escribir)

Todos los maestros siguen el mismo patrón:

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/masters/<recurso>?search=&active=true\|false&<filtros>` | Listado paginado |
| GET | `/masters/<recurso>/{id}` | Ficha |
| POST | `/masters/<recurso>` | Alta (201) |
| PUT | `/masters/<recurso>/{id}` | Edición con la ficha completa |

No hay DELETE: se da de baja con `is_active: false`. Código/nombre/matrícula duplicados → 409 `CONFLICT` con `field`.
Una clave ajena que no existe (o es de otra empresa) → 400 `INVALID_REFERENCE` con `field`.
Todas las salidas llevan además `id` y `created_at`.

| Recurso | Campos de entrada | Extras de salida | Filtros | Búsqueda |
|---|---|---|---|---|
| `vat-rates` | `name`, `rate` (%), `surcharge` (% recargo, def. 0), `is_default`, `is_active` | | | name |
| `payment-methods` | `name`, `due_days: int[]` (p. ej. `[30,60]`), `is_default`, `is_active` | | | name |
| `items` | `code`, `name`, `kind: "product"\|"raw_material"`, `description`, `vat_rate_id?`, `base_price?` (tarifa general €/kg), `min_stock_kg` (def. 0), `is_active` | | `kind` | code, name |
| `silos` | `code`, `name`, `kind: "silo"\|"warehouse"`, `capacity_kg?`, `is_active` | | `kind` | code, name |
| `price-lists` (tarifas) | `name`, `notes`, `is_active`, `lines: [{item_id, price}]` | `lines[].item_code`, `lines[].item_name` | | name |
| `customers` | `code`, `name`, `tax_id?`, `address`, `postal_code`, `city`, `province`, `phone`, `email`, `sales_rep_id?`, `price_list_id?`, `payment_method_id?`, `credit_limit?` (€), `notes`, `is_active`, `prices?: [{item_id, price}]` (precios negociados; si se omite no se tocan) | `sales_rep_name`, `farm_count`, `prices[]` con `item_code`, `item_name` | `sales_rep_id` | code, name, tax_id, city |
| `farms` (explotaciones) | `customer_id`, `name`, `rega_code`, `address`, `postal_code`, `city`, `province`, `latitude?`, `longitude?`, `silos: [{name, capacity_kg?}]`, `notes`, `is_active` | `customer_name` | `customer_id` | name, rega_code, city |
| `carriers` | `name`, `tax_id?`, `phone`, `email`, `is_own_fleet`, `is_active` | | | name |
| `trucks` | `plate` (se pasa a mayúsculas), `carrier_id?`, `compartments: number[]` (kg de cada compartimento, mín. 1), `notes`, `is_active` | `capacity_kg` (suma), `carrier_name` | `carrier_id` | plate |
| `drivers` | `full_name`, `phone`, `carrier_id?`, `is_active` | `carrier_name` | `carrier_id` | full_name |

**Alcance «propios»**: si el usuario tiene `maestros.ver` con alcance `own` (Comercial), en
`customers` solo ve los suyos (`sales_rep_id` = él) y en `farms` solo las de sus clientes; el resto
de maestros los ve todos.

Otras rutas de maestros:

- `GET /masters/lookups` (`maestros.ver`) → opciones activas para desplegables:
  `{vat_rates, payment_methods, price_lists, carriers, sales_reps, silos, items}`, cada una
  `[{id, name, code?, kind?}]` (`items[].kind` = product|raw_material, `silos[].kind`).
  `sales_reps` = usuarios activos con permiso `pedidos.crear`.
- `GET /masters/customers/{id}/price?item_id=` (`maestros.ver`) → `{price, source}` con
  `source` = `customer` (precio negociado) > `price_list` (su tarifa) > `base` (precio general) > `none` (`price: null`).

## Stock (módulo `fabrica`)

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| GET | `/stock/levels?item_id=&silo_id=&kind=product\|raw_material` | `stock.ver` | Paginado. Stock por artículo y silo (solo combinaciones con movimientos y cantidad ≠ 0): `{item_id, item_code, item_name, item_kind, silo_id, silo_code, silo_name, quantity_kg}` ordenado por silo y artículo |
| GET | `/stock/summary?search=&kind=&below_min=true` | `stock.ver` | Paginado. Total por artículo (artículos activos, también los de stock 0): `{item_id, item_code, item_name, item_kind, quantity_kg, min_stock_kg, below_min}` |
| GET | `/stock/movements?item_id=&silo_id=&kind=&date_from=&date_to=` | `stock.ver` | Paginado, más reciente primero: `{id, item_id, item_code, item_name, silo_id, silo_code, silo_name, kind, quantity_kg, lot, occurred_at, source_type, source_id, notes, user_name}` |
| GET | `/stock/receipts` | `stock.ver` | Paginado. Entradas de materia prima: `{id, number, item_id, item_name, silo_id, silo_name, supplier, delivery_note, plate, gross_kg, tare_kg, net_kg, received_at, notes, user_name}` |
| POST | `/stock/receipts` | `stock.ajustar` | `{item_id, silo_id, supplier, delivery_note, plate, gross_kg, tare_kg, received_at?, notes}` → 201 con la entrada. `net_kg = gross_kg − tare_kg` (> 0). Solo materias primas |
| POST | `/stock/adjustments` | `stock.ajustar` | `{item_id, silo_id, quantity_kg (con signo, ≠ 0), reason (obligatorio)}` → 201 con el movimiento |
| POST | `/stock/inventory` | `stock.ajustar` | `{lines: [{item_id, silo_id, counted_kg ≥ 0}], notes}` → 201 `{movements: [...]}` con un movimiento `inventory` por cada línea con diferencia |

Tipos de movimiento (`kind`): `raw_material_in`, `production`, `consumption`, `load_out`, `adjustment`, `inventory`.
Un movimiento que dejaría negativo el stock de un artículo en un silo → 409 `INSUFFICIENT_STOCK` (salvo inventario,
que fija el valor contado). Artículo o silo inactivo / inexistente → 400 `INVALID_REFERENCE`.
Cuando el total de un artículo cruza hacia abajo su `min_stock_kg` se envía el aviso `stock_bajo` a quien tenga `stock.ajustar`.

## Fabricación (módulo `fabrica`)

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| GET | `/production/orders?status=&date_from=&date_to=&item_id=` | `fabricacion.ver` | Paginado, por fecha prevista desc. |
| GET | `/production/orders/{id}` | `fabricacion.ver` | |
| POST | `/production/orders` | `fabricacion.gestionar` | `{item_id (pienso), silo_id, planned_kg > 0, planned_date, notes}` → 201 |
| PUT | `/production/orders/{id}` | `fabricacion.gestionar` | Mismos campos; solo en `planned` (si no, 409 `INVALID_STATUS`) |
| POST | `/production/orders/{id}/start` | `fabricacion.gestionar` | `planned` → `in_progress` |
| POST | `/production/orders/{id}/finish` | `fabricacion.gestionar` | `{produced_kg > 0, silo_id?}`; desde `planned` o `in_progress` → `done` y crea el movimiento `production` |
| POST | `/production/orders/{id}/cancel` | `fabricacion.gestionar` | `planned`/`in_progress` → `cancelled` |

Salida: `{id, number (OF-AAAA-NNNN), item_id, item_code, item_name, silo_id, silo_name, planned_kg, produced_kg, status, planned_date, started_at, finished_at, notes, created_by_name, created_at}`.
Estados: `planned`, `in_progress`, `done`, `cancelled`.

## Widgets nuevos de la pantalla inicial

| Código | Permiso | Datos |
|---|---|---|
| `stock_por_silo` | `stock.ver` | `GET /stock/levels` |
| `roturas_stock` | `stock.ver` | `GET /stock/summary?below_min=true` |
| `fabricacion_hoy` | `fabricacion.ver` | `GET /production/orders?date_from=<hoy>&date_to=<hoy>` |

## Avisos nuevos

`stock_bajo` (en la app y push por defecto).
