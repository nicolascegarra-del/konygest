# API fase 2 — Pedidos de los comerciales

Prefijo `/api/v1`, módulo `ventas`. Mismas convenciones que en [api-fase1.md](api-fase1.md):
kg y €/kg como número en JSON, fechas `YYYY-MM-DD`, fechas-hora ISO UTC, listados paginados
`{items, total, offset, limit}` y errores en el formato estándar de Klyp.

## Estados

```
draft ──submit──► pending ──validate──► confirmed ──(fase 3)──► planned ► loaded ► delivered ──(fase 4)──► invoiced
  ▲                 │
  └──── rejected ◄──┘ reject (con motivo; el comercial corrige y vuelve a enviar)

cancel: desde draft, rejected, pending o confirmed → cancelled (con motivo)
```

| Estado | Etiqueta |
|---|---|
| `draft` | Borrador |
| `pending` | Pendiente de validar |
| `rejected` | Rechazado |
| `confirmed` | Confirmado |
| `planned` | Planificado |
| `loaded` | Cargado |
| `delivered` | Entregado |
| `invoiced` | Facturado |
| `cancelled` | Cancelado |

Una transición no permitida desde el estado actual → 409 `INVALID_STATUS`. Si la acción sí
existe desde ese estado pero no para este usuario (p. ej. el comercial edita un pendiente o
cancela un confirmado) → 403 `FORBIDDEN`.

## Permisos y alcance

- `pedidos.ver` — leer. Con alcance `own` (Comercial) solo ve los pedidos cuyo `sales_rep_id` es él
  **o** cuyo cliente lleva él (`customer.sales_rep_id`). Un pedido fuera de su alcance → 404.
- `pedidos.crear` — crear, editar, enviar a validar y cancelar sus pedidos (con `own`, solo
  los de su alcance y solo para sus clientes).
- `pedidos.validar` — validar, rechazar, editar pedidos pendientes y cancelar confirmados.

| Acción | Estados de partida | Quién |
|---|---|---|
| editar (`PUT`) | `draft`, `rejected` | `pedidos.crear` en su alcance |
| editar (`PUT`) | `pending` | `pedidos.validar` (oficina ajusta antes de validar) |
| `submit` | `draft`, `rejected` | `pedidos.crear` en su alcance |
| `validate` | `pending` | `pedidos.validar` |
| `reject` | `pending` | `pedidos.validar` |
| `cancel` | `draft`, `rejected`, `pending` | `pedidos.crear` en su alcance, o `pedidos.validar` |
| `cancel` | `confirmed` | `pedidos.validar` |

La ficha devuelve `allowed_actions` con las acciones que el usuario actual puede hacer ya:
subconjunto de `["edit", "submit", "validate", "reject", "cancel"]`. El frontend se guía por ella.

## Rutas

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| GET | `/orders?status=&customer_id=&sales_rep_id=&date_from=&date_to=&search=&mine=` | `pedidos.ver` | Paginado, por `requested_date` desc y `number` desc. `status` admite varios separados por coma (`draft,pending,rejected`). `search` busca por número o nombre/código de cliente. `mine=true` → solo los que lleva o ha creado el usuario. Fechas sobre `requested_date`, inclusivas |
| GET | `/orders/summary?date_from=&date_to=` | `pedidos.ver` | Por día de entrega: `[{date, orders, total_kg}]` de los pedidos `confirmed`, `planned`, `loaded` y `delivered` (respeta el alcance). Sin paginar; solo los días con pedidos, por fecha ascendente. `date_from` y `date_to` obligatorios (rango máx. 62 días, o `date_to < date_from` → 400 `VALIDATION_ERROR`) |
| GET | `/orders/{id}` | `pedidos.ver` | Ficha con líneas y `allowed_actions` |
| GET | `/orders/{id}/checks` | `pedidos.ver` | Comprobaciones de riesgo, precio y stock (ver abajo) |
| POST | `/orders` | `pedidos.crear` | Alta → 201 con la ficha. Con `"submit": true` se crea y se envía a validar en la misma llamada |
| PUT | `/orders/{id}` | ver tabla | Edición con el pedido completo (cabecera + todas las líneas; las líneas se reemplazan). Admite también `"submit": true` (se ignora si el pedido está `pending`) |
| POST | `/orders/{id}/submit` | ver tabla | → `pending` |
| POST | `/orders/{id}/validate` | `pedidos.validar` | `{notes?: string (máx. 500), force?: bool}` → `confirmed` (las `notes` van en el aviso al comercial y en la auditoría; no cambian las notas del pedido). Si el pedido supera el riesgo del cliente y `force` no es `true` → 409 `CREDIT_LIMIT_EXCEEDED` |
| POST | `/orders/{id}/reject` | `pedidos.validar` | `{reason}` (obligatorio, 1–500) → `rejected` |
| POST | `/orders/{id}/cancel` | ver tabla | `{reason}` (obligatorio, 1–500) → `cancelled` |

### Entrada (POST y PUT)

```json
{
  "customer_id": "uuid",
  "farm_id": "uuid",
  "requested_date": "2026-11-05",
  "sales_rep_id": "uuid | null",
  "notes": "",
  "submit": false,
  "lines": [
    {"item_id": "uuid", "quantity_kg": 12000, "unit_price": 0.3150, "farm_silo": "Silo 1", "notes": ""}
  ]
}
```

Reglas:
- `lines`: de 1 a 20 (fuera de rango → 422 `VALIDATION_ERROR`, como el resto de errores de formato). `position` de salida empieza en 1, en el orden enviado. `quantity_kg > 0`. No puede repetirse la misma pareja (`item_id`, `farm_silo`) → 400 `VALIDATION_ERROR` con `field: "lines.N"`.
- `item_id` debe ser un **pienso** activo → si no existe/está de baja 400 `INVALID_REFERENCE`, si es materia prima 400 `INVALID_ITEM_KIND` (`field: "lines.N.item_id"`).
- `unit_price` opcional: si se omite o es `null` se usa el precio que corresponde al cliente
  (negociado > tarifa > general, como `GET /masters/customers/{id}/price`) y `price_source` es ese
  origen. Si se envía y es distinto de ese precio, `price_source = "manual"`. Si se omite y el cliente
  no tiene precio para ese pienso → 400 `PRICE_REQUIRED` (`field: "lines.N.unit_price"`).
  `reference_price` guarda siempre el precio que correspondía (o `null`).
- `farm_silo` opcional; si se envía debe ser el nombre de uno de los silos de la explotación → si no 400 `INVALID_REFERENCE` (`lines.N.farm_silo`).
- `customer_id`: cliente activo. Con alcance `own`, debe ser suyo → si no 400 `INVALID_REFERENCE`.
- `farm_id`: explotación activa **de ese cliente** → si no 400 `INVALID_REFERENCE`.
- `requested_date` no puede ser anterior a hoy (zona `Europe/Madrid`) → 400 `VALIDATION_ERROR` (`requested_date`). En `PUT` de un pedido `pending` por oficina se aplica la misma regla.
- `sales_rep_id`: con alcance `own` se ignora y es el propio usuario. Si no, si se omite se usa el comercial del cliente.
- `amount = round(quantity_kg × unit_price, 2)`; `total_kg` y `total_amount` (sin IVA) se recalculan siempre.
- Número `PED-AAAA-NNNN` (año de creación), correlativo por empresa.

### Salida

Listado (`OrderSummary`):
`{id, number, status, customer_id, customer_code, customer_name, farm_id, farm_name, sales_rep_id, sales_rep_name, requested_date, total_kg, total_amount, line_count, has_manual_price, created_at, submitted_at, updated_at}`
(`has_manual_price` = alguna línea con precio por debajo de su `reference_price`).

Ficha (`OrderDetail`) = `OrderSummary` +
`{notes, status_reason, validated_by_name, validated_at, created_by_name, allowed_actions, lines: [{id, position, item_id, item_code, item_name, quantity_kg, unit_price, price_source, reference_price, amount, farm_silo, notes}]}`.
`validated_by_name`/`validated_at` son la última revisión de oficina: quien validó o quien rechazó.

### Comprobaciones (`GET /orders/{id}/checks`)

```json
{
  "credit": {
    "credit_limit": 30000,        // null = sin límite → exceeded siempre false
    "outstanding_amount": 12000,  // otros pedidos del cliente en confirmed/planned/loaded/delivered
    "order_amount": 4500,
    "available": 13500,           // credit_limit - outstanding - order (puede ser negativo; null sin límite)
    "exceeded": false
  },
  "prices": [                     // solo líneas con unit_price < reference_price
    {"line_id": "uuid", "item_code": "P-CEB", "item_name": "Cebo", "unit_price": 0.29, "reference_price": 0.315, "difference_pct": -7.94}
  ],
  "stock": [                      // una entrada por pienso del pedido
    {"item_id": "uuid", "item_code": "P-CEB", "item_name": "Cebo", "requested_kg": 12000, "stock_kg": 26000, "committed_kg": 8000, "short": false}
  ]
}
```
`committed_kg` = kilos del pienso en otros pedidos `confirmed` o `planned` (aún no cargados).
`short` = `requested_kg + committed_kg > stock_kg`. El stock es informativo (se puede fabricar):
no bloquea la validación. El riesgo sí, salvo `force: true`.

## Avisos

| Tipo | Cuándo | A quién |
|---|---|---|
| `pedido_pendiente` | al enviar a validar | usuarios activos con `pedidos.validar` (menos quien lo envía) |
| `pedido_confirmado` | al validar | comercial del pedido y quien lo creó (menos quien valida) |
| `pedido_rechazado` | al rechazar | comercial del pedido y quien lo creó; el cuerpo lleva el motivo |

Enlace de los avisos: `/pedidos/{id}`.

## Widgets nuevos

| Código | Permiso | Datos |
|---|---|---|
| `mis_pedidos` | `pedidos.crear` | `GET /orders?mine=true&status=draft,pending,rejected` |
| `pedidos_por_validar` | `pedidos.validar` | `GET /orders?status=pending` |
| `pedidos_semana` | `pedidos.ver` | `GET /orders/summary?date_from=<hoy>&date_to=<hoy+6>` |

## Auditoría

`pedido.crear`, `pedido.editar`, `pedido.enviar`, `pedido.validar` (con `forzado: true` si `force` ha hecho falta porque se superaba el riesgo, y `notas` si las hay), `pedido.rechazar`, `pedido.cancelar`.
