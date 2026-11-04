# API fase 3 — Logística: cargas, orden de carga, pesada y albarán

Prefijo `/api/v1`, módulo `logistica`. Mismas convenciones que en [api-fase1.md](api-fase1.md)
y [api-fase2.md](api-fase2.md).

## Conceptos

- **Carga** (`truck_load`, número `CAR-AAAA-NNNN`): un viaje de un camión en un día.
- **Parada** (`load_stop`): un pedido de la carga, con su **orden de descarga** (`sequence`, desde 1).
  Cada parada tendrá su **albarán** (`ALB-AAAA-NNNN`) al registrar la carga.
- **Reparto** (`load_item`): kilos de una línea de pedido en un **compartimento** del camión
  (`compartment`, desde 1, índice en `truck.compartments`).
  - Un compartimento lleva **una sola línea de pedido** (no se mezclan piensos ni clientes).
  - Una línea puede ocupar varios compartimentos.
  - La suma de `planned_kg` de una línea debe ser exactamente su `quantity_kg` (los pedidos no se parten entre cargas).
  - Los kilos de un compartimento no pueden superar su capacidad.

## Estados de la carga

```
planned ──release──► ready ──load (pesada)──► loaded ──deliver (todas las paradas)──► delivered
   │                  │
   └──── cancel ◄─────┘   (con motivo; sus pedidos vuelven a confirmed)
```

| Estado | Etiqueta | Pedidos de la carga |
|---|---|---|
| `planned` | Planificada | `planned` |
| `ready` | Lista para cargar (orden de carga emitida) | `planned` |
| `loaded` | Cargada / en ruta | `loaded` |
| `delivered` | Entregada | `delivered` (cada uno al confirmar su parada) |
| `cancelled` | Cancelada | vuelven a `confirmed` |

Transición no permitida → 409 `INVALID_STATUS`. La ficha lleva `allowed_actions`:
subconjunto de `["edit", "release", "unrelease", "load", "deliver", "cancel"]` según estado y permisos.

## Permisos

- `logistica.ver`: ver cargas, el tablero y descargar PDF.
- `logistica.planificar`: crear y editar cargas, emitirlas a fábrica (`release`), devolverlas a
  planificación (`unrelease`, de `ready` a `planned`), cancelarlas y confirmar entregas.
- `cargas.pesar`: registrar la pesada real (`load`) y confirmar entregas.

## Rutas

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| GET | `/logistics/pending-orders?date_to=&search=` | `logistica.ver` | Pedidos `confirmed` sin carga, con `requested_date <= date_to` (por defecto hoy + 7). Orden: `requested_date`, número. Paginado |
| GET | `/loads?date=&date_from=&date_to=&status=&truck_id=` | `logistica.ver` | Paginado, por `load_date` desc y número desc. `status` admite varios separados por coma |
| GET | `/loads/{id}` | `logistica.ver` | Ficha completa |
| POST | `/loads` | `logistica.planificar` | Alta → 201 (`planned`) |
| PUT | `/loads/{id}` | `logistica.planificar` | Edición completa (paradas y reparto se reemplazan). Solo `planned` |
| POST | `/loads/{id}/release` | `logistica.planificar` | `planned` → `ready`. Avisa `carga_lista` a quien tenga `cargas.pesar` |
| POST | `/loads/{id}/unrelease` | `logistica.planificar` | `ready` → `planned` |
| POST | `/loads/{id}/load` | `cargas.pesar` | Registrar pesada: `ready` → `loaded` (ver abajo) |
| POST | `/loads/{id}/stops/{stop_id}/deliver` | `logistica.planificar` o `cargas.pesar` | Confirmar la entrega de una parada (`loaded`) |
| POST | `/loads/{id}/cancel` | `logistica.planificar` | `{reason}` → `cancelled`, desde `planned` o `ready` |
| GET | `/loads/{id}/loading-order.pdf` | `logistica.ver` | Orden de carga en PDF (se genera al vuelo; desde `planned`; cancelada → 409 `INVALID_STATUS`) |
| GET | `/loads/{id}/stops/{stop_id}/delivery-note.pdf` | `logistica.ver` | Albarán en PDF (guardado al registrar la carga; 404 si aún no existe) |

Los PDF responden `application/pdf` con `Content-Disposition: inline; filename="CAR-2026-0001.pdf"`.
Si el servidor no puede generar PDF → 503 `PDF_UNAVAILABLE`.

### Alta y edición (POST / PUT)

```json
{
  "load_date": "2026-11-05",
  "truck_id": "uuid",
  "driver_id": "uuid | null",
  "notes": "",
  "stops": [
    {"order_id": "uuid", "sequence": 1},
    {"order_id": "uuid", "sequence": 2}
  ],
  "items": [
    {"order_line_id": "uuid", "compartment": 1, "planned_kg": 8000},
    {"order_line_id": "uuid", "compartment": 2, "planned_kg": 4000}
  ]
}
```

Reglas:
- `load_date` no anterior a hoy (Europe/Madrid) → 400 `VALIDATION_ERROR` (`load_date`).
- `truck_id`: camión activo → si no 400 `INVALID_REFERENCE`. `driver_id`: conductor activo o `null`.
- `stops`: de 1 a 10; `sequence` 1..N sin repetir; `order_id` sin repetir (si no 400 `VALIDATION_ERROR`, `field: "stops"`). Cada pedido debe estar
  `confirmed` y sin otra carga activa (o ya en esta carga, al editar) → si no 409 `ORDER_NOT_PLANNABLE`
  con `field: "stops.N.order_id"`. Pedido inexistente o fuera de alcance → 400 `INVALID_REFERENCE`.
- `items` **opcional**: si se omite o es `[]`, el servidor reparte automáticamente en el orden de las
  paradas (rellena compartimentos en orden, partiendo una línea si no cabe, sin mezclar líneas).
  Si no cabe todo → 409 `LOAD_DOES_NOT_FIT` (mensaje con kg que faltan).
- Si se envía `items`:
  - cada `order_line_id` debe pertenecer a un pedido de `stops` → si no 400 `INVALID_REFERENCE` (`items.N.order_line_id`);
  - `compartment` en 1..nº de compartimentos del camión y sin repetir → si no 400 `VALIDATION_ERROR` (`items.N.compartment`);
  - suma por compartimento ≤ capacidad → si no 409 `COMPARTMENT_OVERFLOW` (`field: "items.N"`);
  - suma por línea == `quantity_kg` de la línea → si no 400 `VALIDATION_ERROR` (`field: "items"`, mensaje con la línea).
- Al crear o editar, los pedidos que entran pasan a `planned` y los que salen vuelven a `confirmed`.

### Registrar la pesada (`POST /loads/{id}/load`)

```json
{
  "gross_kg": 38420,
  "tare_kg": 14200,
  "items": [
    {"item_id": "uuid del load_item", "actual_kg": 7980, "silo_id": "uuid", "lot": null}
  ]
}
```

- `items`: exactamente un elemento por cada `load_item` de la carga → si no 400 `VALIDATION_ERROR` (`items`).
- `actual_kg > 0` (como el resto de validaciones de formato, 422 `VALIDATION_ERROR`). `silo_id`: silo activo de fábrica de donde sale el pienso → si no 400 `INVALID_REFERENCE` (`items.N.silo_id`).
- `gross_kg`/`tare_kg` opcionales (si van los dos, `gross > tare`).
- Efectos, en una sola transacción:
  1. Un movimiento de stock `load_out` (negativo) por cada `load_item`, con `source_type="truck_load"` y `source_id` = id de la carga.
     Si no hay stock suficiente en ese silo → 409 `INSUFFICIENT_STOCK` y no se registra nada.
  2. Cada parada recibe su número de albarán `ALB-AAAA-NNNN` y se genera y guarda el PDF.
     Si no se puede generar PDF, la carga se registra igualmente y el albarán queda pendiente de
     generar (`delivery_note_ready: false`); se genera al pedirlo.
  3. Carga → `loaded` (`loaded_at`, `loaded_by`), pedidos → `loaded`.
  4. Aviso `carga_cargada` a quien tenga `logistica.planificar` (enlace a la carga) y a los comerciales
     de los pedidos (uno por pedido, enlace al pedido: el comercial no tiene acceso a logística).

### Confirmar entrega (`POST /loads/{id}/stops/{stop_id}/deliver`)

`{received_by: string (opcional, máx 200), delivered_at?: datetime (por defecto ahora), notes?: string}`.
Solo con la carga `loaded` y la parada sin entregar → si no 409 `INVALID_STATUS`.
El pedido pasa a `delivered` y se avisa `pedido_entregado` a su comercial. Cuando todas las
paradas están entregadas, la carga pasa a `delivered`.

## Salida

Listado (`LoadSummary`):
`{id, number, load_date, status, truck_id, truck_plate, carrier_name, driver_id, driver_name, capacity_kg, planned_kg, stop_count, customers: [string], created_at, updated_at}`
(`customers` = nombres de cliente en el orden de descarga).

Ficha (`LoadDetail`) = `LoadSummary` + `{notes, status_reason, gross_kg, tare_kg, released_at, loaded_at, loaded_by_name, delivered_at, created_by_name, allowed_actions, compartments: [capacidad kg...], stops: [...], items: [...]}`:

- `stops[]`: `{id, sequence, order_id, order_number, order_status, customer_name, farm_name, farm_rega, farm_city, requested_date, total_kg, delivery_note_number, delivery_note_ready, delivered_at, received_by, delivery_notes}`
- `items[]`: `{id, stop_id, order_line_id, compartment, item_id, item_code, item_name, farm_silo, planned_kg, actual_kg, silo_id, silo_name, lot}` ordenados por compartimento.

`pending-orders` devuelve `OrderSummary` de la fase 2 más `lines: [{id, item_id, item_code, item_name, quantity_kg, farm_silo}]` y `farm_city`.

## Avisos

| Tipo | Cuándo | A quién |
|---|---|---|
| `carga_lista` | `release` | usuarios con `cargas.pesar` (menos quien actúa) |
| `carga_cargada` | `load` | usuarios con `logistica.planificar` y comerciales de los pedidos (menos quien actúa) |
| `pedido_entregado` | `deliver` | comercial del pedido (menos quien actúa) |

Enlace: `/logistica/cargas/{id}`, salvo en los avisos a comerciales (`carga_cargada` de su pedido y
`pedido_entregado`), que enlazan a `/pedidos/{order_id}` porque el comercial no ve logística.

## Widgets

| Código | Permiso | Datos |
|---|---|---|
| `cargas_hoy` | `logistica.ver` | `GET /loads?date=<hoy>` |
| `cargas_por_cargar` | `cargas.pesar` | `GET /loads?status=ready` |

## Auditoría

`carga.crear`, `carga.editar`, `carga.emitir`, `carga.devolver`, `carga.cargar`, `carga.entregar` (por parada), `carga.cancelar`.
