# API fase 4 — Facturación, abonos y registro Verifactu

Prefijo `/api/v1`, módulo `facturacion`. Mismas convenciones que en las fases anteriores
(kg y € como número, fechas `YYYY-MM-DD`, listados paginados, errores estándar Klyp,
`allowed_actions` en las fichas, «hoy» en Europe/Madrid).

## Conceptos

- **Factura** (`sales_invoice`, `kind = "invoice"`, tipo Verifactu `F1`): se crea desde los
  **pedidos entregados** de un cliente (`orders.status = delivered`, sin factura). Cada línea de
  pedido entregada da una línea de factura con los **kg reales** (suma de `actual_kg` de sus
  compartimentos), el precio del pedido y el IVA del pienso (`item.vat_rate_id`, si no tiene el
  tipo marcado `is_default`; si no hay ninguno → 409 `VAT_NOT_CONFIGURED`). Si el cliente tiene
  `equivalence_surcharge`, se aplica el recargo del tipo (`vat_rate.surcharge`).
- **Abono / rectificativa** (`kind = "credit_note"`): rectifica una factura emitida. Por
  diferencias: sus líneas e importes van **en negativo**. Tipos Verifactu: `R1` (error fundado en
  derecho y art. 80.1, 80.2 y 80.6 LIVA — el habitual para devoluciones, descuentos o precios mal
  aplicados), `R4` (resto de causas). Por defecto `R1`.
- **Series y números**: `F-AAAA-NNNN` (facturas) y `R-AAAA-NNNN` (abonos), correlativos por
  empresa y año de expedición. El número se asigna **al emitir**; los borradores no tienen número.
- **Estados**: `draft` → `issued` → (`cancelled` solo por anulación). Los borradores se editan y
  se borran; las emitidas **no se editan nunca**.
- **Registro Verifactu** (`verifactu_record`): al **emitir** se crea un registro de **alta**; al
  **anular**, uno de **anulación**. Huella SHA-256 encadenada a la del registro anterior de la
  empresa (una sola cadena para altas y anulaciones), con `app/modules/verifactu/hashing.py`.
  Libro inmutable (la API solo puede leer e insertar). La cadena se serializa por empresa con un
  `pg_advisory_xact_lock`. `send_status = "not_sent"` (el envío a la AEAT es la fase 7).
- **QR**: URL de cotejo con `app/modules/verifactu/qr.py` (`qr_url` con el NIF de la empresa,
  número, fecha y total), entorno según `VERIFACTU_ENVIRONMENT` (`test` por defecto, `production`),
  impreso en el PDF con el texto «QR tributario:» y «VERI*FACTU».
- **Datos fiscales**: la empresa debe tener `tax_id` (NIF) y dirección para emitir → si faltan,
  409 `COMPANY_FISCAL_DATA_MISSING` (con `field`). El cliente debe tener `tax_id` → si no,
  409 `CUSTOMER_TAX_ID_MISSING`.
- **Vencimientos**: de la forma de pago del cliente (`due_days`), repartiendo el total en partes
  iguales (el último absorbe el redondeo). Sin forma de pago → un vencimiento a la fecha de factura.
- **Redondeo**: cada línea a 2 decimales; por tipo de IVA, base = suma de líneas, cuota =
  `round(base × tipo / 100, 2)`; total = bases + cuotas + recargos.
- **PDF**: se genera al emitir con `documents.render_invoice` y se guarda con
  `documents.store(kind="invoice"|"credit_note", number=...)`; se sirve con `documents.fetch`
  (se regenera desde la BD si falta). Si WeasyPrint no está disponible, la emisión sigue y el PDF
  se genera al pedirlo (503 `PDF_UNAVAILABLE` si tampoco entonces).
- Al emitir una factura, sus pedidos pasan a `invoiced`. Al anularla, vuelven a `delivered`.
  Un abono no cambia el estado de los pedidos.

## Permisos

- `facturas.ver` (alcance `own` para Comercial: solo facturas de sus clientes).
- `facturas.emitir`: crear, editar y borrar borradores de factura, emitir facturas, regenerar PDF.
- `facturas.abonar`: crear, editar, borrar y emitir abonos; anular facturas emitidas.

`allowed_actions` ⊆ `["edit", "delete", "issue", "credit_note", "cancel"]`.

## Rutas

| Método | Ruta | Permiso | Descripción |
|---|---|---|---|
| GET | `/invoicing/pending?customer_id=&date_from=&date_to=&search=` | `facturas.emitir` | Pendiente de facturar agrupado por cliente: `[{customer_id, customer_code, customer_name, order_count, total_kg, estimated_base, oldest_delivery, orders: [{id, number, delivered_at, total_kg, amount}]}]`. Fechas sobre la fecha de entrega. Paginado por cliente |
| POST | `/invoices` | `facturas.emitir` | Borrador de factura: `{customer_id, order_ids: [uuid] (1..200), issue_date?, notes?}` → 201 ficha. Pedido no entregado, ya facturado, de otro cliente o fuera de alcance → 409 `ORDER_NOT_INVOICEABLE` (`field: "order_ids.N"`) |
| POST | `/invoices/bulk` | `facturas.emitir` | `{date_from?, date_to, customer_ids?: [uuid], issue_date?}` → 201 `{created: [InvoiceSummary]}`: un borrador por cliente con todos sus pedidos entregados del periodo |
| GET | `/invoices?kind=&status=&customer_id=&date_from=&date_to=&search=` | `facturas.ver` | Paginado por `issue_date` desc y número desc (borradores primero). `status` admite varios. `search` por número o cliente |
| GET | `/invoices/{id}` | `facturas.ver` | Ficha |
| PUT | `/invoices/{id}` | `facturas.emitir` (factura) / `facturas.abonar` (abono) | Solo `draft`. Factura: `{order_ids, issue_date?, notes?}` (vuelve a calcular las líneas). Abono: `{lines: [...], rectification_reason, invoice_type, issue_date?, notes?}` |
| DELETE | `/invoices/{id}` | ídem | Solo `draft` → 204 |
| POST | `/invoices/{id}/issue` | ídem | `draft` → `issued` (ver «Emitir») |
| POST | `/invoices/{id}/credit-note` | `facturas.abonar` | Borrador de abono de una factura `issued`: `{invoice_type?: "R1"|"R4", rectification_reason (1..500), full?: bool, lines?: [{invoice_line_id, quantity_kg?: number > 0, amount?: number > 0}]}`. `full: true` abona todo lo pendiente de abonar. Por línea: `quantity_kg` (kg devueltos, al mismo precio) **o** `amount` (descuento en €). No se puede abonar más de lo facturado menos lo ya abonado → 409 `CREDIT_EXCEEDS_INVOICE` |
| POST | `/invoices/{id}/cancel` | `facturas.abonar` | `{reason}` (1..500): anula una factura `issued` sin abonos emitidos → `cancelled`, registro de anulación Verifactu, pedidos a `delivered`. Con abonos → 409 `HAS_CREDIT_NOTES` |
| GET | `/invoices/{id}/pdf` | `facturas.ver` | PDF (`inline; filename="F-2026-0001.pdf"`); 409 `INVALID_STATUS` si es borrador; 503 `PDF_UNAVAILABLE` |
| GET | `/verifactu/records?invoice_id=&date_from=&date_to=` | `facturas.ver` (alcance all) | Paginado por `sequence` desc: `{id, sequence, record_type, invoice_id, invoice_number, issue_date, invoice_type, total_tax, total_amount, generated_at, previous_hash, hash, send_status}` |
| GET | `/verifactu/verify` | `facturas.ver` (alcance all) | Recalcula toda la cadena de la empresa: `{ok, records, broken: [{sequence, invoice_number}]}` |
| GET | `/tenant` / `PATCH /tenant` | (fase 0) | Añaden `legal_name, address, postal_code, city, province, feed_registration` |
| maestros `customers` | (fase 1) | | Añade `equivalence_surcharge: bool` (def. `false`) |

### Emitir (`POST /invoices/{id}/issue`)

`{issue_date?}` (por defecto la del borrador; no futura y no anterior a la última emitida de la
misma serie → 409 `ISSUE_DATE_OUT_OF_ORDER`, para mantener la correlación número–fecha).
En una transacción: comprueba datos fiscales, recalcula y congela importes, asigna número,
guarda `customer_snapshot`, `due_dates`, `tax_breakdown`, crea el registro de alta Verifactu
(`InvoiceRecord(issuer_nif, number, issue_date, invoice_type, total_tax = IVA + recargo, total,
generated_at = ahora con zona)`), pasa los pedidos a `invoiced`, genera y guarda el PDF (si se
puede) y avisa `factura_emitida` al comercial del cliente. Una factura con total 0 → 409 `EMPTY_INVOICE`.

## Salida

`InvoiceSummary`: `{id, kind, number, invoice_type, status, customer_id, customer_code, customer_name, issue_date, total_kg, taxable_base, vat_amount, surcharge_amount, total, rectified_invoice_id, rectified_number, created_at, issued_at}`.

`InvoiceDetail` = `InvoiceSummary` + `{notes, status_reason, rectification_reason, period_from, period_to, customer_snapshot, payment_method_name, due_dates: [{date, amount}], tax_breakdown: [{vat_rate, surcharge_rate, base, vat, surcharge}], lines: [{id, position, order_id, order_number, item_code, description, delivery_note_number, delivery_date, quantity_kg, unit_price, vat_rate, surcharge_rate, amount, credited_kg, credited_amount}], credit_notes: [InvoiceSummary], verifactu: {hash, previous_hash, generated_at, qr_url} | null, pdf_ready, issued_by_name, created_by_name, allowed_actions}`
(`credited_*`: lo ya abonado de esa línea en abonos emitidos).

## Avisos y widgets

| Aviso | Cuándo | A quién |
|---|---|---|
| `factura_emitida` | al emitir factura o abono | comercial del cliente (menos quien emite) |

| Widget | Permiso | Datos |
|---|---|---|
| `facturacion_mes` | `facturas.ver` | `GET /invoicing/summary?month=AAAA-MM` → `{month, invoiced_total, credit_total, net_total, invoice_count, previous_month_net}` (solo emitidas; respeta alcance) |
| `pendiente_facturar` | `facturas.emitir` | `GET /invoicing/pending?limit=5` |

## Auditoría

`factura.crear`, `factura.editar`, `factura.borrar`, `factura.emitir`, `factura.abonar` (crear abono), `factura.anular`.

## Precisiones de la implementación

Detalles que el backend fija y que el contrato de arriba no decía:

- **Pendiente de facturar** excluye también los pedidos que ya están en un **borrador** de
  factura: un pedido solo puede estar en una factura en borrador o emitida a la vez
  (crear o editar un borrador con un pedido de otro borrador → 409 `ORDER_NOT_INVOICEABLE`).
  También es `ORDER_NOT_INVOICEABLE` un pedido entregado sin kilos pesados. `POST /invoices/bulk`
  solo recoge pedidos pendientes (no los que están en borradores).
- `delivered_at` de `pending` es la **fecha** (Madrid) de la última parada entregada del pedido.
- **Abono por importe** (`amount`): la línea sale con `quantity_kg = 0`, `unit_price = 0`,
  `amount` negativo y descripción «Descuento · …». `full: true` abona, por línea, los kg y el
  importe que quedan. Al **emitir** un abono se vuelve a comprobar el límite contra los abonos
  ya emitidos (dos borradores que juntos superan lo facturado: el segundo da 409
  `CREDIT_EXCEEDS_INVOICE`, `field: "lines"`).
- Una línea de abono con `amount` igual a **todo lo pendiente** de esa línea (y kg pendientes)
  se guarda como devolución total (kg pendientes al precio de la línea), igual que `full`.
  Así el frontend puede pedir el abono total línea a línea. Las líneas de la ficha llevan
  `rectified_line_id` (la línea de la factura original; `null` en facturas).
- `customer_snapshot` = `{code, name, tax_id, address, postal_code, city, province}` (el cliente
  no tiene razón social aparte: no hay `legal_name`).
- `POST /invoices/{id}/credit-note` admite además `issue_date?` y `notes?`; el `PUT` de un abono
  admite `full?` igual que el alta (`lines` o `full`; sin `rectification_reason` → 422).
- El cuerpo de `POST /invoices/{id}/issue` es opcional.
- Solo se anulan **facturas** (`kind = invoice`); un abono emitido no se anula (409
  `INVALID_STATUS`). Los borradores de abono de una factura anulada ya no se pueden emitir.
- `COMPANY_FISCAL_DATA_MISSING` lleva `field` = `tax_id` (también si el NIF no tiene 9
  caracteres), `address`, `postal_code` o `city`. `CUSTOMER_TAX_ID_MISSING` lleva
  `field: "customer_id"`. `ISSUE_DATE_OUT_OF_ORDER` lleva `field: "issue_date"`.
- **Vencimientos** también en los abonos (en negativo), con la forma de pago del cliente.
- `GET /invoicing/summary`: `credit_total` va **en negativo** (suma de los abonos emitidos) y
  `net_total = invoiced_total + credit_total`; `invoice_count` cuenta solo facturas.
- `GET /verifactu/records`: `date_from`/`date_to` filtran por la fecha (Madrid) de generación
  del registro. `/verifactu/verify` marca además los registros cuyo `previous_hash` no es la
  huella del anterior o cuya `sequence` salta.
- `generated_at` (FechaHoraHusoGenRegistro) se genera en hora de Madrid al segundo; la huella
  se recalcula con esa misma representación.
- El aviso `factura_emitida` enlaza a `/facturacion/facturas/{id}`.
- `PATCH /tenant`: los campos fiscales con `null` se guardan vacíos.
