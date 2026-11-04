"""Rutas de facturación, abonos y registro Verifactu (contrato en docs/api-fase4.md)."""

from datetime import date
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from sqlmodel import Session

from app.core.deps import (
    CurrentUser,
    TenantDbDep,
    TenantUserDep,
    require_module,
    require_permission,
)
from app.core.errors import AppError
from app.core.pagination import Page, PageDep
from app.modules.invoicing import service
from app.modules.invoicing.models import Invoice, InvoiceKind
from app.modules.invoicing.schemas import (
    BulkCreate,
    BulkOut,
    CancelIn,
    ChainCheck,
    CreditNoteIn,
    InvoiceCreate,
    InvoiceDetail,
    InvoiceSummary,
    InvoiceUpdate,
    IssueIn,
    MonthSummary,
    PendingCustomer,
    VerifactuRecordOut,
)
from app.modules.platform.audit import audit

router = APIRouter(tags=["Facturación"], dependencies=[Depends(require_module("facturacion"))])

View = Depends(require_permission("facturas.ver"))
Issue = Depends(require_permission("facturas.emitir"))
Credit = Depends(require_permission("facturas.abonar"))

_ERRORS = {
    400: {"description": "Datos no válidos: VALIDATION_ERROR, INVALID_REFERENCE"},
    403: {"description": "Sin permiso para esta acción"},
    404: {"description": "La factura no existe o está fuera de tu alcance"},
    409: {"description": "INVALID_STATUS: no se puede desde el estado actual"},
}
_DRAFT_ERRORS = {
    **_ERRORS,
    409: {
        "description": "INVALID_STATUS, ORDER_NOT_INVOICEABLE, VAT_NOT_CONFIGURED o "
        "CREDIT_EXCEEDS_INVOICE"
    },
}
_ISSUE_ERRORS = {
    **_ERRORS,
    409: {
        "description": "INVALID_STATUS, ISSUE_DATE_OUT_OF_ORDER, COMPANY_FISCAL_DATA_MISSING, "
        "CUSTOMER_TAX_ID_MISSING, EMPTY_INVOICE, VAT_NOT_CONFIGURED, ORDER_NOT_INVOICEABLE o "
        "CREDIT_EXCEEDS_INVOICE"
    },
}
_PDF = {
    200: {"content": {"application/pdf": {}}, "description": "PDF"},
    404: _ERRORS[404],
    409: {"description": "INVALID_STATUS: los borradores no tienen PDF"},
    503: {"description": "PDF_UNAVAILABLE: el servidor no puede generar PDF ahora"},
}


def _audit(db: Session, action: str, user: CurrentUser, invoice: Invoice, **data) -> None:
    audit(
        db,
        action,
        user=user,
        entity="sales_invoice",
        entity_id=invoice.id,
        data={"numero": invoice.number, "tipo": invoice.kind.value, **data},
    )


def _validation(message: str, field: str) -> AppError:
    return AppError(422, "VALIDATION_ERROR", message, field)


# ─── Pendiente y resumen ───────────────────────────


@router.get(
    "/invoicing/pending",
    summary="Pendiente de facturar",
    description=(
        "Pedidos entregados sin factura (ni borrador) agrupados por cliente, el de la entrega "
        "más antigua primero. Paginado por cliente. Fechas sobre la fecha de entrega; `search` "
        "por número de pedido o cliente. Kilos reales de la pesada y base estimada."
    ),
    response_model=Page[PendingCustomer],
)
def pending(
    db: TenantDbDep,
    page: PageDep,
    customer_id: UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    search: str | None = None,
    _: CurrentUser = Issue,
) -> Page[PendingCustomer]:
    items, total = service.pending(db, page, customer_id, date_from, date_to, search)
    return Page(items=items, total=total, offset=page.offset, limit=page.limit)


@router.get(
    "/invoicing/summary",
    summary="Facturación del mes",
    description=(
        "Solo emitidas (no anuladas) y con el alcance del usuario. `credit_total` va en negativo "
        "(como los abonos); `net_total` = facturado + abonos. `month` AAAA-MM (por defecto el "
        "actual)."
    ),
    response_model=MonthSummary,
    responses={400: _ERRORS[400]},
)
def invoicing_summary(
    db: TenantDbDep, month: str | None = None, user: CurrentUser = View
) -> MonthSummary:
    return service.month_summary(db, user, month)


# ─── Facturas ──────────────────────────────────────


@router.post(
    "/invoices",
    summary="Borrador de factura",
    description=(
        "Desde pedidos entregados del cliente: una línea por línea de pedido y albarán con los "
        "kg reales, el precio del pedido y el IVA del pienso (o el tipo por defecto)."
    ),
    response_model=InvoiceDetail,
    status_code=201,
    responses=_DRAFT_ERRORS,
)
def create_invoice(
    data: InvoiceCreate, db: TenantDbDep, user: CurrentUser = Issue
) -> InvoiceDetail:
    invoice = service.create_invoice(
        db, user, data.customer_id, data.order_ids, data.issue_date, data.notes
    )
    _audit(db, "factura.crear", user, invoice, pedidos=len(data.order_ids))
    db.commit()
    return service.invoice_detail(db, user, invoice.id)


@router.post(
    "/invoices/bulk",
    summary="Borradores por cliente",
    description="Un borrador por cliente con todos sus pedidos entregados del periodo.",
    response_model=BulkOut,
    status_code=201,
    responses=_DRAFT_ERRORS,
)
def bulk_create(data: BulkCreate, db: TenantDbDep, user: CurrentUser = Issue) -> BulkOut:
    invoices = service.bulk_create(
        db, user, data.date_from, data.date_to, data.customer_ids, data.issue_date
    )
    for invoice in invoices:
        _audit(db, "factura.crear", user, invoice, masiva=True)
    db.commit()
    return BulkOut(created=service.summaries(db, [i.id for i in invoices]))


@router.get(
    "/invoices",
    summary="Facturas y abonos",
    description=(
        "Borradores primero; después por fecha de expedición y número, de más reciente a más "
        "antigua. `status` admite varios separados por coma. `search` por número o cliente. "
        "El comercial solo ve las de sus clientes."
    ),
    response_model=Page[InvoiceSummary],
)
def list_invoices(
    db: TenantDbDep,
    page: PageDep,
    kind: InvoiceKind | None = None,
    status: str | None = None,
    customer_id: UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    search: str | None = None,
    user: CurrentUser = View,
) -> Page[InvoiceSummary]:
    items, total = service.list_invoices(
        db,
        user,
        page,
        kind,
        service.parse_statuses(status),
        customer_id,
        date_from,
        date_to,
        search,
    )
    return Page(items=items, total=total, offset=page.offset, limit=page.limit)


@router.get(
    "/invoices/{invoice_id}",
    summary="Ficha de una factura o abono",
    description="Líneas, desglose, vencimientos, abonos, registro Verifactu y `allowed_actions`.",
    response_model=InvoiceDetail,
    responses={404: _ERRORS[404]},
)
def get_invoice(invoice_id: UUID, db: TenantDbDep, user: CurrentUser = View) -> InvoiceDetail:
    return service.invoice_detail(db, user, invoice_id)


@router.put(
    "/invoices/{invoice_id}",
    summary="Editar un borrador",
    description=(
        "Factura (`facturas.emitir`): `{order_ids, issue_date?, notes?}` y se recalculan las "
        "líneas. Abono (`facturas.abonar`): `{invoice_type, rectification_reason, full? | "
        "lines, issue_date?, notes?}`."
    ),
    response_model=InvoiceDetail,
    responses=_DRAFT_ERRORS,
)
def update_invoice(
    invoice_id: UUID, data: InvoiceUpdate, db: TenantDbDep, user: TenantUserDep
) -> InvoiceDetail:
    invoice, _customer = service.get_for_update(db, user, invoice_id)
    service.ensure_manage(user, invoice)
    if invoice.kind == InvoiceKind.INVOICE:
        if not data.order_ids:
            raise _validation("Indica los pedidos de la factura.", "order_ids")
        service.update_invoice(db, invoice, data.order_ids, data.issue_date, data.notes)
    else:
        if data.rectification_reason is None:
            raise _validation("Indica el motivo de la rectificación.", "rectification_reason")
        if not data.full and not data.lines:
            raise _validation("Indica las líneas que se abonan o `full: true`.", "lines")
        invoice.rectification_reason = data.rectification_reason
        invoice.invoice_type = data.invoice_type or invoice.invoice_type
        if data.issue_date:
            invoice.issue_date = data.issue_date
        invoice.notes = data.notes
        service.fill_credit_note(
            db, invoice, service.rectified_of(db, invoice), data.full, data.lines
        )
    _audit(db, "factura.editar", user, invoice)
    db.commit()
    return service.invoice_detail(db, user, invoice.id)


@router.delete(
    "/invoices/{invoice_id}",
    summary="Borrar un borrador",
    status_code=204,
    responses=_ERRORS,
)
def delete_invoice(invoice_id: UUID, db: TenantDbDep, user: TenantUserDep) -> Response:
    invoice, customer = service.get_for_update(db, user, invoice_id)
    service.ensure_manage(user, invoice)
    _audit(db, "factura.borrar", user, invoice, cliente=customer.code)
    service.delete_draft(db, invoice)
    db.commit()
    return Response(status_code=204)


@router.post(
    "/invoices/{invoice_id}/issue",
    summary="Emitir",
    description=(
        "Borrador → emitida: número F-/R-AAAA-NNNN, datos congelados, registro de alta "
        "Verifactu encadenado, pedidos a `invoiced`, PDF (si se puede) y aviso al comercial."
    ),
    response_model=InvoiceDetail,
    responses=_ISSUE_ERRORS,
)
def issue_invoice(
    invoice_id: UUID, db: TenantDbDep, user: TenantUserDep, data: IssueIn | None = None
) -> InvoiceDetail:
    invoice, _customer = service.get_for_update(db, user, invoice_id)
    service.ensure_manage(user, invoice)
    service.issue(db, user, invoice, data.issue_date if data else None)
    _audit(db, "factura.emitir", user, invoice, total=float(invoice.total))
    db.commit()
    return service.invoice_detail(db, user, invoice.id)


@router.post(
    "/invoices/{invoice_id}/credit-note",
    summary="Borrador de abono",
    description=(
        "Rectifica una factura emitida por diferencias (líneas en negativo). `full: true` abona "
        "todo lo pendiente; por línea, `quantity_kg` (kg devueltos al mismo precio) o `amount` "
        "(descuento en €)."
    ),
    response_model=InvoiceDetail,
    status_code=201,
    responses={**_DRAFT_ERRORS, 409: {"description": "INVALID_STATUS o CREDIT_EXCEEDS_INVOICE"}},
)
def create_credit_note(
    invoice_id: UUID, data: CreditNoteIn, db: TenantDbDep, user: CurrentUser = Credit
) -> InvoiceDetail:
    original, _customer = service.get_for_update(db, user, invoice_id)
    credit = service.create_credit_note(
        db,
        user,
        original,
        data.invoice_type,
        data.rectification_reason,
        data.full,
        data.lines,
        data.issue_date,
        data.notes,
    )
    _audit(db, "factura.abonar", user, credit, factura=original.number, total=float(credit.total))
    db.commit()
    return service.invoice_detail(db, user, credit.id)


@router.post(
    "/invoices/{invoice_id}/cancel",
    summary="Anular una factura emitida",
    description=(
        "Solo facturas emitidas sin abonos emitidos: registro de anulación Verifactu y sus "
        "pedidos vuelven a `delivered`."
    ),
    response_model=InvoiceDetail,
    responses={**_ERRORS, 409: {"description": "INVALID_STATUS o HAS_CREDIT_NOTES"}},
)
def cancel_invoice(
    invoice_id: UUID, data: CancelIn, db: TenantDbDep, user: CurrentUser = Credit
) -> InvoiceDetail:
    invoice, _customer = service.get_for_update(db, user, invoice_id)
    service.ensure_cancel(user, invoice)
    service.cancel(db, user, invoice, data.reason)
    _audit(db, "factura.anular", user, invoice, motivo=data.reason)
    db.commit()
    return service.invoice_detail(db, user, invoice.id)


@router.get(
    "/invoices/{invoice_id}/pdf",
    summary="PDF de la factura o abono",
    response_class=Response,
    responses=_PDF,
)
def invoice_pdf(invoice_id: UUID, db: TenantDbDep, user: CurrentUser = View) -> Response:
    invoice, _customer = service.get_for_update(db, user, invoice_id)
    content = service.invoice_pdf(db, invoice)
    db.commit()  # puede haberse generado y guardado ahora
    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{invoice.number}.pdf"'},
    )


# ─── Registro Verifactu ────────────────────────────


@router.get(
    "/verifactu/records",
    summary="Registro de facturación Verifactu",
    description=(
        "Altas y anulaciones de la empresa por `sequence` descendente. Fechas sobre la de "
        "generación del registro (hora de Madrid). Requiere `facturas.ver` con alcance todo."
    ),
    response_model=Page[VerifactuRecordOut],
    responses={403: _ERRORS[403]},
)
def list_records(
    db: TenantDbDep,
    page: PageDep,
    invoice_id: UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    user: CurrentUser = View,
) -> Page[VerifactuRecordOut]:
    service.ensure_all_scope(user)
    items, total = service.list_records(db, page, invoice_id, date_from, date_to)
    return Page(items=items, total=total, offset=page.offset, limit=page.limit)


@router.get(
    "/verifactu/verify",
    summary="Comprobar la cadena de huellas",
    description="Recalcula todas las huellas de la empresa y lista los registros que no cuadran.",
    response_model=ChainCheck,
    responses={403: _ERRORS[403]},
)
def verify_chain(db: TenantDbDep, user: CurrentUser = View) -> ChainCheck:
    service.ensure_all_scope(user)
    assert user.tenant_id is not None
    return service.verify(db, user.tenant_id)
