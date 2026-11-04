"""Facturación: cálculo de facturas desde los pedidos entregados, abonos, emisión con
numeración y registro Verifactu encadenado, anulación, consultas y PDF.

Las rutas solo orquestan: aquí se decide qué acciones admite cada factura
(`allowed_actions`) con las mismas comprobaciones que las autorizan.

Concurrencia: emitir y anular toman un `pg_advisory_xact_lock` por empresa antes de
leer el último registro Verifactu, la última fecha emitida y el número. Así la cadena de
huellas, el correlativo y la correlación número–fecha nunca se cruzan entre dos
peticiones simultáneas. Las filas propias (borrador, pedidos) se bloquean con
`FOR UPDATE`; la factura rectificada de un abono no se bloquea por fila porque la
protege el mismo lock de empresa (anular también lo toma) y así no hay interbloqueos.
"""

import logging
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import Date, case, cast, func, or_, text
from sqlalchemy.orm import aliased
from sqlmodel import Session, col, delete, select

from app.core.catalog import Scope
from app.core.config import get_settings
from app.core.deps import CurrentUser
from app.core.errors import AppError, bad_request, forbidden, not_found
from app.core.pagination import PageParams, paginate
from app.core.security import utcnow
from app.core.sequence import next_number
from app.modules import documents
from app.modules.documents.types import (
    CompanyInfo,
    InvoiceCustomerDoc,
    InvoiceData,
    InvoiceLineDoc,
    TaxBreakdownDoc,
)
from app.modules.invoicing.models import (
    Invoice,
    InvoiceKind,
    InvoiceLine,
    InvoiceStatus,
    VerifactuRecord,
    VerifactuRecordType,
)
from app.modules.invoicing.schemas import (
    BrokenRecord,
    ChainCheck,
    CreditLineIn,
    InvoiceAction,
    InvoiceDetail,
    InvoiceLineOut,
    InvoiceSummary,
    MonthSummary,
    PendingCustomer,
    PendingOrder,
    VerifactuInfo,
    VerifactuRecordOut,
)
from app.modules.logistics.models import LoadItem, LoadStop
from app.modules.masters.models import Customer, Item, PaymentMethod, VatRate
from app.modules.notifications.service import notify
from app.modules.orders.models import Order, OrderLine, OrderStatus
from app.modules.orders.service import today_madrid
from app.modules.tenants.models import Tenant
from app.modules.users.models import User
from app.modules.verifactu import qr
from app.modules.verifactu.hashing import (
    CancellationRecord,
    ChainedRecord,
    InvoiceRecord,
    InvoiceType,
    chain_hash,
    verify_chain,
)

logger = logging.getLogger("konygest.invoicing")

ZERO = Decimal(0)
CENT = Decimal("0.01")
MADRID = ZoneInfo("Europe/Madrid")
SOURCE_TYPE = "sales_invoice"
SERIES = {InvoiceKind.INVOICE: "F", InvoiceKind.CREDIT_NOTE: "R"}
# Facturas que «ocupan» sus pedidos: un pedido solo puede estar en una de ellas
ACTIVE_STATUSES = (InvoiceStatus.DRAFT, InvoiceStatus.ISSUED)
# Emitidas alguna vez (cuentan para la correlación número–fecha)
NUMBERED_STATUSES = (InvoiceStatus.ISSUED, InvoiceStatus.CANCELLED)

STATUS_LABELS = {
    InvoiceStatus.DRAFT: "en borrador",
    InvoiceStatus.ISSUED: "emitida",
    InvoiceStatus.CANCELLED: "anulada",
}


def money(value: Decimal) -> Decimal:
    """Redondeo a céntimos, mitad hacia arriba (simétrico en negativos)."""
    return value.quantize(CENT, ROUND_HALF_UP)


def madrid_date(value: datetime | None) -> date | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(MADRID).date()


def _fmt(value: Decimal) -> str:
    """1234.5 → "1.234,50" (formato es-ES) para los textos de los avisos."""
    return f"{value:,.2f}".replace(",", "_").replace(".", ",").replace("_", ".")


def _link(invoice: Invoice) -> str:
    return f"/facturacion/facturas/{invoice.id}"


def _label(invoice: Invoice) -> str:
    if invoice.number:
        noun = "El abono" if invoice.kind == InvoiceKind.CREDIT_NOTE else "La factura"
        return f"{noun} {invoice.number}"
    return "El borrador"


# ─── Alcance y permisos ────────────────────────────


def own_scope(user: CurrentUser) -> bool:
    """Comercial: solo ve las facturas de los clientes que lleva."""
    return user.scope("facturas.ver") == Scope.OWN


def manage_permission(invoice: Invoice) -> str:
    return "facturas.abonar" if invoice.kind == InvoiceKind.CREDIT_NOTE else "facturas.emitir"


def _visible(user: CurrentUser, customer_rep_id: UUID | None) -> bool:
    if own_scope(user):
        return customer_rep_id == user.id
    return True


def invalid_status(invoice: Invoice) -> AppError:
    return AppError(
        409,
        "INVALID_STATUS",
        f"{_label(invoice)} está {STATUS_LABELS[invoice.status]}; no se puede hacer esta acción.",
    )


def ensure_manage(user: CurrentUser, invoice: Invoice) -> None:
    """Editar, borrar y emitir un borrador: 409 si ya no es borrador; 403 sin permiso."""
    if invoice.status != InvoiceStatus.DRAFT:
        raise invalid_status(invoice)
    if not user.can(manage_permission(invoice)):
        raise forbidden()


def get_for_update(db: Session, user: CurrentUser, invoice_id: UUID) -> tuple[Invoice, Customer]:
    """Factura con su fila bloqueada; 404 si no existe o está fuera del alcance."""
    invoice = db.exec(select(Invoice).where(Invoice.id == invoice_id).with_for_update()).first()
    if invoice is None:
        raise not_found("No se encuentra la factura.")
    customer = db.get(Customer, invoice.customer_id)
    assert customer is not None  # FK RESTRICT
    if not _visible(user, customer.sales_rep_id):
        raise not_found("No se encuentra la factura.")
    return invoice, customer


def _tenant_lock(db: Session, tenant_id: UUID) -> None:
    """Serializa emisiones y anulaciones de la empresa hasta el fin de la transacción."""
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"verifactu:{tenant_id}"},
    )


# ─── Cálculo de líneas e importes ──────────────────


@dataclass
class _Delivered:
    order: Order
    line: OrderLine
    stop: LoadStop
    item: Item
    kg: Decimal


def _delivered_lines(db: Session, order_ids: list[UUID]) -> list[_Delivered]:
    """Kilos realmente entregados por línea de pedido y parada (albarán), en orden de
    entrega. Solo cuentan los compartimentos pesados de paradas entregadas."""
    if not order_ids:
        return []
    rows = db.exec(
        select(Order, OrderLine, LoadStop, Item, func.sum(LoadItem.actual_kg))
        .join(OrderLine, OrderLine.id == LoadItem.order_line_id)
        .join(Order, Order.id == OrderLine.order_id)
        .join(LoadStop, LoadStop.id == LoadItem.stop_id)
        .join(Item, Item.id == OrderLine.item_id)
        .where(
            col(Order.id).in_(order_ids),
            col(LoadItem.actual_kg).is_not(None),
            col(LoadStop.delivered_at).is_not(None),
        )
        .group_by(Order.id, OrderLine.id, LoadStop.id, Item.id)
        .order_by(
            col(LoadStop.delivered_at), col(Order.number), col(OrderLine.position), LoadStop.id
        )
    ).all()
    return [
        _Delivered(order, line, stop, item, Decimal(kg))
        for order, line, stop, item, kg in rows
        if kg and kg > 0
    ]


def _vat_rates(db: Session, tenant_id: UUID) -> tuple[dict[UUID, VatRate], VatRate | None]:
    rates = {r.id: r for r in db.exec(select(VatRate).where(VatRate.tenant_id == tenant_id)).all()}
    default = next(
        (r for r in sorted(rates.values(), key=lambda r: r.name) if r.is_default and r.is_active),
        None,
    )
    return rates, default


def _vat_not_configured(item: Item) -> AppError:
    return AppError(
        409,
        "VAT_NOT_CONFIGURED",
        f"{item.code} no tiene tipo de IVA y no hay uno marcado por defecto: "
        "configúralo en Maestros › IVA.",
    )


def build_invoice_lines(
    db: Session, invoice: Invoice, customer: Customer, orders: list[Order]
) -> list[InvoiceLine]:
    """Una línea de factura por línea de pedido entregada y albarán, con los kg reales.

    Raises:
        AppError 409 ORDER_NOT_INVOICEABLE: un pedido sin kilos entregados.
        AppError 409 VAT_NOT_CONFIGURED: pienso sin IVA y sin tipo por defecto.
    """
    delivered = _delivered_lines(db, [o.id for o in orders])
    with_lines = {d.order.id for d in delivered}
    for index, order in enumerate(orders):
        if order.id not in with_lines:
            raise _not_invoiceable(order, index, "no tiene kilos entregados")
    rates, default = _vat_rates(db, invoice.tenant_id)
    lines: list[InvoiceLine] = []
    for position, d in enumerate(delivered, start=1):
        vat = rates.get(d.item.vat_rate_id) if d.item.vat_rate_id else None
        vat = vat or default
        if vat is None:
            raise _vat_not_configured(d.item)
        note = d.stop.delivery_note_number
        description = f"{d.item.name} · Albarán {note}" if note else d.item.name
        lines.append(
            InvoiceLine(
                tenant_id=invoice.tenant_id,
                invoice_id=invoice.id,
                position=position,
                order_id=d.order.id,
                order_line_id=d.line.id,
                load_stop_id=d.stop.id,
                item_id=d.item.id,
                item_code=d.item.code,
                description=description[:300],
                delivery_note_number=note,
                delivery_date=madrid_date(d.stop.delivered_at),
                quantity_kg=d.kg,
                unit_price=d.line.unit_price,
                vat_rate=vat.rate,
                surcharge_rate=vat.surcharge if customer.equivalence_surcharge else ZERO,
                amount=money(d.kg * d.line.unit_price),
            )
        )
    return lines


def tax_breakdown(lines: list[InvoiceLine]) -> list[dict[str, Decimal]]:
    """Por tipo de IVA (y recargo): base = suma de líneas, cuota = round(base × tipo)."""
    groups: dict[tuple[Decimal, Decimal], Decimal] = defaultdict(Decimal)
    for line in lines:
        groups[(Decimal(line.vat_rate), Decimal(line.surcharge_rate))] += Decimal(line.amount)
    result = []
    for (vat_rate, surcharge_rate), base in sorted(groups.items(), reverse=True):
        result.append(
            {
                "vat_rate": vat_rate,
                "surcharge_rate": surcharge_rate,
                "base": base,
                "vat": money(base * vat_rate / 100),
                "surcharge": money(base * surcharge_rate / 100),
            }
        )
    return result


def apply_totals(invoice: Invoice, lines: list[InvoiceLine]) -> None:
    breakdown = tax_breakdown(lines)
    invoice.total_kg = sum((Decimal(ln.quantity_kg) for ln in lines), ZERO)
    invoice.taxable_base = sum((b["base"] for b in breakdown), ZERO)
    invoice.vat_amount = sum((b["vat"] for b in breakdown), ZERO)
    invoice.surcharge_amount = sum((b["surcharge"] for b in breakdown), ZERO)
    invoice.total = invoice.taxable_base + invoice.vat_amount + invoice.surcharge_amount
    invoice.tax_breakdown = [{k: float(v) for k, v in b.items()} for b in breakdown]


def due_dates(issue_date: date, total: Decimal, days: list[int]) -> list[dict[str, Any]]:
    """Reparte el total en partes iguales; el último vencimiento absorbe el redondeo."""
    days = sorted(int(d) for d in days if int(d) >= 0) or [0]
    part = money(total / len(days))
    result = []
    for index, offset in enumerate(days):
        amount = part if index < len(days) - 1 else total - part * (len(days) - 1)
        result.append(
            {"date": (issue_date + timedelta(days=offset)).isoformat(), "amount": float(amount)}
        )
    return result


def customer_snapshot(customer: Customer) -> dict[str, Any]:
    return {
        "code": customer.code,
        "name": customer.name,
        "tax_id": customer.tax_id,
        "address": customer.address,
        "postal_code": customer.postal_code,
        "city": customer.city,
        "province": customer.province,
    }


def _apply_customer(db: Session, invoice: Invoice, customer: Customer) -> None:
    """Datos del cliente, forma de pago y vencimientos (se congelan al emitir)."""
    invoice.customer_snapshot = customer_snapshot(customer)
    method = (
        db.get(PaymentMethod, customer.payment_method_id) if customer.payment_method_id else None
    )
    invoice.payment_method_name = method.name if method else ""
    invoice.due_dates = due_dates(
        invoice.issue_date, Decimal(invoice.total), method.due_days if method else []
    )


def _replace_lines(db: Session, invoice: Invoice, lines: list[InvoiceLine]) -> None:
    db.exec(delete(InvoiceLine).where(col(InvoiceLine.invoice_id) == invoice.id))
    db.add_all(lines)


# ─── Pedidos facturables ───────────────────────────


def _not_invoiceable(order: Order | None, index: int, reason: str) -> AppError:
    name = f"El pedido {order.number}" if order else "El pedido"
    return AppError(
        409,
        "ORDER_NOT_INVOICEABLE",
        f"{name} no se puede facturar: {reason}.",
        f"order_ids.{index}",
    )


def _orders_in_invoices(exclude_invoice_id: UUID | None = None):
    """Pedidos que ya están en una factura en borrador o emitida."""
    query = (
        select(InvoiceLine.order_id)
        .join(Invoice, Invoice.id == InvoiceLine.invoice_id)
        .where(
            Invoice.kind == InvoiceKind.INVOICE,
            col(Invoice.status).in_(ACTIVE_STATUSES),
            col(InvoiceLine.order_id).is_not(None),
        )
    )
    if exclude_invoice_id is not None:
        query = query.where(Invoice.id != exclude_invoice_id)
    return query


def lock_orders(
    db: Session, customer: Customer, order_ids: list[UUID], invoice_id: UUID | None = None
) -> list[Order]:
    """Bloquea y comprueba los pedidos que se van a facturar (en el orden recibido)."""
    if len(set(order_ids)) != len(order_ids):
        raise bad_request("VALIDATION_ERROR", "Hay pedidos repetidos.", "order_ids")
    found = {
        o.id: o
        for o in db.exec(
            select(Order)
            .where(col(Order.id).in_(order_ids))
            .order_by(col(Order.id))
            .with_for_update()
        ).all()
    }
    taken = set(
        db.exec(
            _orders_in_invoices(invoice_id).where(col(InvoiceLine.order_id).in_(order_ids))
        ).all()
    )
    orders = []
    for index, order_id in enumerate(order_ids):
        order = found.get(order_id)
        if order is None:
            raise _not_invoiceable(None, index, "no existe")
        if order.customer_id != customer.id:
            raise _not_invoiceable(order, index, "es de otro cliente")
        if order_id in taken:
            raise _not_invoiceable(order, index, "ya está en otra factura")
        if order.status != OrderStatus.DELIVERED:
            reason = (
                "ya está facturado" if order.status == OrderStatus.INVOICED else "no está entregado"
            )
            raise _not_invoiceable(order, index, reason)
        orders.append(order)
    return orders


def _order_ids(db: Session, invoice: Invoice) -> list[UUID]:
    rows = db.exec(
        select(InvoiceLine.order_id, func.min(InvoiceLine.position))
        .where(InvoiceLine.invoice_id == invoice.id, col(InvoiceLine.order_id).is_not(None))
        .group_by(InvoiceLine.order_id)
        .order_by(func.min(InvoiceLine.position))
    ).all()
    return [r[0] for r in rows]


def _get_customer(db: Session, customer_id: UUID) -> Customer:
    customer = db.get(Customer, customer_id)
    if customer is None:
        raise bad_request("INVALID_REFERENCE", "El cliente no existe.", "customer_id")
    return customer


def fill_invoice(db: Session, invoice: Invoice, customer: Customer, order_ids: list[UUID]) -> None:
    """Calcula (o recalcula) líneas, importes, periodo y vencimientos de una factura."""
    orders = lock_orders(db, customer, order_ids, invoice.id)
    lines = build_invoice_lines(db, invoice, customer, orders)
    dates = [ln.delivery_date for ln in lines if ln.delivery_date]
    invoice.period_from = min(dates) if dates else None
    invoice.period_to = max(dates) if dates else None
    apply_totals(invoice, lines)
    _apply_customer(db, invoice, customer)
    invoice.updated_at = utcnow()
    db.add(invoice)
    _replace_lines(db, invoice, lines)


def create_invoice(
    db: Session,
    user: CurrentUser,
    customer_id: UUID,
    order_ids: list[UUID],
    issue_date: date | None,
    notes: str,
) -> Invoice:
    assert user.tenant_id is not None
    customer = _get_customer(db, customer_id)
    invoice = Invoice(
        tenant_id=user.tenant_id,
        kind=InvoiceKind.INVOICE,
        invoice_type=InvoiceType.F1.value,
        customer_id=customer.id,
        issue_date=issue_date or today_madrid(),
        notes=notes,
        created_by=user.id,
    )
    db.add(invoice)
    db.flush()
    fill_invoice(db, invoice, customer, order_ids)
    db.flush()
    return invoice


def update_invoice(
    db: Session, invoice: Invoice, order_ids: list[UUID], issue_date: date | None, notes: str
) -> None:
    customer = db.get(Customer, invoice.customer_id)
    assert customer is not None
    if issue_date:
        invoice.issue_date = issue_date
    invoice.notes = notes
    fill_invoice(db, invoice, customer, order_ids)


# ─── Pendiente de facturar ─────────────────────────


def _delivered_at_subquery():
    return (
        select(
            col(LoadStop.order_id).label("order_id"),
            func.max(LoadStop.delivered_at).label("delivered_at"),
        )
        .where(col(LoadStop.delivered_at).is_not(None))
        .group_by(LoadStop.order_id)
        .subquery()
    )


def pending_orders_query(
    customer_id: UUID | None,
    date_from: date | None,
    date_to: date | None,
    customer_ids: list[UUID] | None = None,
):
    delivered = _delivered_at_subquery()
    delivered_date = cast(func.timezone("Europe/Madrid", delivered.c.delivered_at), Date)
    query = (
        select(Order, delivered_date.label("delivered_date"))
        .join(delivered, delivered.c.order_id == Order.id)
        .where(
            Order.status == OrderStatus.DELIVERED,
            col(Order.id).not_in(_orders_in_invoices()),
        )
    )
    if customer_id:
        query = query.where(Order.customer_id == customer_id)
    if customer_ids is not None:
        query = query.where(col(Order.customer_id).in_(customer_ids))
    if date_from:
        query = query.where(delivered_date >= date_from)
    if date_to:
        query = query.where(delivered_date <= date_to)
    return query


def _order_amounts(db: Session, order_ids: list[UUID]) -> dict[UUID, tuple[Decimal, Decimal]]:
    """Kilos entregados y base estimada (con el redondeo de las líneas) por pedido."""
    result: dict[UUID, tuple[Decimal, Decimal]] = {}
    for d in _delivered_lines(db, order_ids):
        kg, amount = result.get(d.order.id, (ZERO, ZERO))
        result[d.order.id] = (kg + d.kg, amount + money(d.kg * d.line.unit_price))
    return result


def pending(
    db: Session,
    page: PageParams,
    customer_id: UUID | None,
    date_from: date | None,
    date_to: date | None,
    search: str | None,
) -> tuple[list[PendingCustomer], int]:
    """Pedidos entregados sin factura (ni borrador), agrupados por cliente; el cliente con
    la entrega pendiente más antigua primero."""
    orders_q = pending_orders_query(customer_id, date_from, date_to)
    if search and search.strip():
        pattern = f"%{search.strip()}%"
        orders_q = orders_q.join(Customer, Customer.id == Order.customer_id).where(
            or_(
                col(Order.number).ilike(pattern),
                col(Customer.name).ilike(pattern),
                col(Customer.code).ilike(pattern),
            )
        )
    sub = orders_q.subquery()
    oldest = func.min(sub.c.delivered_date)
    customers_q = (
        select(Customer.id, Customer.code, Customer.name, func.count(), oldest)
        .join(sub, sub.c.customer_id == Customer.id)
        .group_by(Customer.id, Customer.code, Customer.name)
        .order_by(oldest, col(Customer.name), Customer.id)
    )
    rows, total = paginate(db, customers_q, page)  # type: ignore[arg-type]
    if not rows:
        return [], total
    ids = [r[0] for r in rows]
    page_orders = db.exec(
        select(sub.c.id, sub.c.number, sub.c.customer_id, sub.c.delivered_date)
        .where(col(sub.c.customer_id).in_(ids))
        .order_by(sub.c.delivered_date, sub.c.number)
    ).all()
    amounts = _order_amounts(db, [o[0] for o in page_orders])
    by_customer: dict[UUID, list[PendingOrder]] = defaultdict(list)
    for order_id, number, cust_id, delivered_date in page_orders:
        kg, amount = amounts.get(order_id, (ZERO, ZERO))
        by_customer[cust_id].append(
            PendingOrder(
                id=order_id, number=number, delivered_at=delivered_date, total_kg=kg, amount=amount
            )
        )
    result = []
    for cust_id, code, name, count, oldest_date in rows:
        orders = by_customer[cust_id]
        result.append(
            PendingCustomer(
                customer_id=cust_id,
                customer_code=code,
                customer_name=name,
                order_count=count,
                total_kg=sum((o.total_kg for o in orders), ZERO),
                estimated_base=sum((o.amount for o in orders), ZERO),
                oldest_delivery=oldest_date,
                orders=orders,
            )
        )
    return result, total


def bulk_create(
    db: Session,
    user: CurrentUser,
    date_from: date | None,
    date_to: date,
    customer_ids: list[UUID] | None,
    issue_date: date | None,
) -> list[Invoice]:
    """Un borrador por cliente con todos sus pedidos entregados del periodo."""
    if date_from and date_to < date_from:
        raise bad_request("VALIDATION_ERROR", "La fecha final es anterior a la inicial.", "date_to")
    sub = pending_orders_query(None, date_from, date_to, customer_ids).subquery()
    rows = db.exec(
        select(sub.c.customer_id, sub.c.id).order_by(
            sub.c.customer_id, sub.c.delivered_date, sub.c.number
        )
    ).all()
    grouped: dict[UUID, list[UUID]] = defaultdict(list)
    for cust_id, order_id in rows:
        grouped[cust_id].append(order_id)
    created = []
    for cust_id, order_ids in grouped.items():
        created.append(create_invoice(db, user, cust_id, order_ids, issue_date, ""))
    return created


# ─── Abonos ────────────────────────────────────────


def credited(db: Session, invoice_id: UUID) -> dict[UUID, tuple[Decimal, Decimal]]:
    """Kilos e importe ya abonados (positivos) por línea, en abonos emitidos."""
    rows = db.exec(
        select(
            InvoiceLine.rectified_line_id,
            func.coalesce(func.sum(-InvoiceLine.quantity_kg), ZERO),
            func.coalesce(func.sum(-InvoiceLine.amount), ZERO),
        )
        .join(Invoice, Invoice.id == InvoiceLine.invoice_id)
        .where(
            Invoice.rectified_invoice_id == invoice_id,
            Invoice.status == InvoiceStatus.ISSUED,
            col(InvoiceLine.rectified_line_id).is_not(None),
        )
        .group_by(InvoiceLine.rectified_line_id)
    ).all()
    return {line_id: (Decimal(kg), Decimal(amount)) for line_id, kg, amount in rows}


def _exceeds(message: str, field: str) -> AppError:
    return AppError(409, "CREDIT_EXCEEDS_INVOICE", message, field)


def build_credit_lines(
    db: Session,
    credit: Invoice,
    original: Invoice,
    full: bool,
    lines_in: list[CreditLineIn] | None,
) -> list[InvoiceLine]:
    """Líneas en negativo de un abono, sin superar lo facturado menos lo ya abonado."""
    originals = list(
        db.exec(
            select(InvoiceLine)
            .where(InvoiceLine.invoice_id == original.id)
            .order_by(col(InvoiceLine.position))
        ).all()
    )
    done = credited(db, original.id)

    def remaining(line: InvoiceLine) -> tuple[Decimal, Decimal]:
        kg, amount = done.get(line.id, (ZERO, ZERO))
        return Decimal(line.quantity_kg) - kg, Decimal(line.amount) - amount

    def make(line: InvoiceLine, kg: Decimal, amount: Decimal, discount: bool) -> InvoiceLine:
        description = f"Descuento · {line.description}" if discount else line.description
        return InvoiceLine(
            tenant_id=credit.tenant_id,
            invoice_id=credit.id,
            order_id=line.order_id,
            order_line_id=line.order_line_id,
            load_stop_id=line.load_stop_id,
            rectified_line_id=line.id,
            item_id=line.item_id,
            item_code=line.item_code,
            description=description[:300],
            delivery_note_number=line.delivery_note_number,
            delivery_date=line.delivery_date,
            quantity_kg=-kg,
            unit_price=ZERO if discount else line.unit_price,
            vat_rate=line.vat_rate,
            surcharge_rate=line.surcharge_rate,
            amount=-amount,
        )

    result: list[InvoiceLine] = []
    if full:
        for line in originals:
            kg_left, amount_left = remaining(line)
            if amount_left > 0:
                result.append(make(line, max(kg_left, ZERO), amount_left, discount=False))
        if not result:
            raise _exceeds(f"{_label(original)} ya está abonada por completo.", "full")
    else:
        by_id = {line.id: line for line in originals}
        seen: set[UUID] = set()
        for index, item in enumerate(lines_in or []):
            field = f"lines.{index}"
            line = by_id.get(item.invoice_line_id)
            if line is None:
                raise bad_request(
                    "INVALID_REFERENCE",
                    "Esa línea no es de la factura que se abona.",
                    f"{field}.invoice_line_id",
                )
            if line.id in seen:
                raise bad_request(
                    "VALIDATION_ERROR", "Esa línea ya está en el abono.", f"{field}.invoice_line_id"
                )
            seen.add(line.id)
            kg_left, amount_left = remaining(line)
            if item.quantity_kg is not None:
                amount = money(item.quantity_kg * Decimal(line.unit_price))
                if item.quantity_kg > kg_left or amount > amount_left:
                    raise _exceeds(
                        f"No se pueden abonar más de {_fmt(max(kg_left, ZERO))} kg de "
                        f"{line.item_code}.",
                        f"{field}.quantity_kg",
                    )
                result.append(make(line, item.quantity_kg, amount, discount=False))
            else:
                assert item.amount is not None
                if item.amount > amount_left:
                    raise _exceeds(
                        f"No se pueden abonar más de {_fmt(max(amount_left, ZERO))} € de "
                        f"{line.item_code}.",
                        f"{field}.amount",
                    )
                if item.amount == amount_left and kg_left > 0:
                    # Todo lo pendiente de la línea: se abona como devolución (kg y precio)
                    result.append(make(line, kg_left, amount_left, discount=False))
                else:
                    result.append(make(line, ZERO, item.amount, discount=True))
    for position, line in enumerate(result, start=1):
        line.position = position
    return result


def check_credit_lines(db: Session, credit: Invoice, original: Invoice) -> None:
    """Al emitir: las líneas del borrador siguen cabiendo en lo pendiente de abonar."""
    lines = db.exec(select(InvoiceLine).where(InvoiceLine.invoice_id == credit.id)).all()
    if not lines:
        raise AppError(409, "EMPTY_INVOICE", "El abono no tiene líneas.", "lines")
    originals = {
        ln.id: ln
        for ln in db.exec(select(InvoiceLine).where(InvoiceLine.invoice_id == original.id)).all()
    }
    done = credited(db, original.id)
    wanted: dict[UUID, tuple[Decimal, Decimal]] = defaultdict(lambda: (ZERO, ZERO))
    for ln in lines:
        assert ln.rectified_line_id is not None
        kg, amount = wanted[ln.rectified_line_id]
        wanted[ln.rectified_line_id] = (kg - Decimal(ln.quantity_kg), amount - Decimal(ln.amount))
    for line_id, (kg, amount) in wanted.items():
        source = originals[line_id]
        kg_done, amount_done = done.get(line_id, (ZERO, ZERO))
        if (
            kg > Decimal(source.quantity_kg) - kg_done
            or amount > Decimal(source.amount) - amount_done
        ):
            raise _exceeds(
                f"{source.item_code}: ya se ha abonado parte de esta línea en otro abono; "
                "revisa el borrador.",
                "lines",
            )


def fill_credit_note(
    db: Session,
    credit: Invoice,
    original: Invoice,
    full: bool,
    lines_in: list[CreditLineIn] | None,
) -> None:
    lines = build_credit_lines(db, credit, original, full, lines_in)
    apply_totals(credit, lines)
    customer = db.get(Customer, credit.customer_id)
    assert customer is not None
    _apply_customer(db, credit, customer)
    credit.updated_at = utcnow()
    db.add(credit)
    _replace_lines(db, credit, lines)


def create_credit_note(
    db: Session,
    user: CurrentUser,
    original: Invoice,
    invoice_type: str,
    reason: str,
    full: bool,
    lines_in: list[CreditLineIn] | None,
    issue_date: date | None,
    notes: str,
) -> Invoice:
    if original.kind != InvoiceKind.INVOICE or original.status != InvoiceStatus.ISSUED:
        raise invalid_status(original)
    credit = Invoice(
        tenant_id=original.tenant_id,
        kind=InvoiceKind.CREDIT_NOTE,
        invoice_type=invoice_type,
        customer_id=original.customer_id,
        rectified_invoice_id=original.id,
        rectification_reason=reason,
        issue_date=issue_date or today_madrid(),
        period_from=original.period_from,
        period_to=original.period_to,
        notes=notes,
        created_by=user.id,
    )
    db.add(credit)
    db.flush()
    fill_credit_note(db, credit, original, full, lines_in)
    db.flush()
    return credit


def rectified_of(db: Session, credit: Invoice) -> Invoice:
    assert credit.rectified_invoice_id is not None
    original = db.get(Invoice, credit.rectified_invoice_id)
    assert original is not None  # FK RESTRICT
    return original


# ─── Emisión ───────────────────────────────────────


def _fiscal_missing(field: str, what: str) -> AppError:
    return AppError(
        409,
        "COMPANY_FISCAL_DATA_MISSING",
        f"Falta {what} de la empresa: complétalo en Ajustes › Empresa antes de emitir.",
        field,
    )


def check_company(tenant: Tenant) -> None:
    tax_id = (tenant.tax_id or "").strip()
    if not tax_id:
        raise _fiscal_missing("tax_id", "el NIF")
    if len(tax_id) != 9:
        raise AppError(
            409,
            "COMPANY_FISCAL_DATA_MISSING",
            "El NIF de la empresa debe tener 9 caracteres.",
            "tax_id",
        )
    for field, what in (
        ("address", "la dirección"),
        ("postal_code", "el código postal"),
        ("city", "la población"),
    ):
        if not str(getattr(tenant, field) or "").strip():
            raise _fiscal_missing(field, what)


def _check_issue_date(db: Session, invoice: Invoice, issue_date: date) -> None:
    if issue_date > today_madrid():
        raise AppError(
            409,
            "ISSUE_DATE_OUT_OF_ORDER",
            "La fecha de expedición no puede ser futura.",
            "issue_date",
        )
    last = db.exec(
        select(func.max(Invoice.issue_date)).where(
            Invoice.tenant_id == invoice.tenant_id,
            Invoice.kind == invoice.kind,
            col(Invoice.status).in_(NUMBERED_STATUSES),
        )
    ).one()
    if last is not None and issue_date < last:
        raise AppError(
            409,
            "ISSUE_DATE_OUT_OF_ORDER",
            f"Ya hay {'abonos' if invoice.kind == InvoiceKind.CREDIT_NOTE else 'facturas'} "
            f"emitidos con fecha {last:%d/%m/%Y}: la fecha no puede ser anterior.",
            "issue_date",
        )


def _last_record(db: Session, tenant_id: UUID) -> VerifactuRecord | None:
    return db.exec(
        select(VerifactuRecord)
        .where(VerifactuRecord.tenant_id == tenant_id)
        .order_by(col(VerifactuRecord.sequence).desc())
        .limit(1)
    ).first()


def _now_for_record() -> datetime:
    """FechaHoraHusoGenRegistro: hora de Madrid al segundo. Al leerla de la BD se vuelve a
    pasar a Madrid (`record_from_row`) para que la huella se recalcule igual."""
    return datetime.now(MADRID).replace(microsecond=0)


def qr_environment() -> qr.QREnvironment:
    return qr.QREnvironment(get_settings().verifactu_environment)


def _append_record(
    db: Session,
    invoice: Invoice,
    record: InvoiceRecord | CancellationRecord,
    qr_url: str | None = None,
) -> VerifactuRecord:
    last = _last_record(db, invoice.tenant_id)
    previous_hash = last.hash if last else None
    is_alta = isinstance(record, InvoiceRecord)
    row = VerifactuRecord(
        tenant_id=invoice.tenant_id,
        sequence=(last.sequence if last else 0) + 1,
        record_type=VerifactuRecordType.ALTA if is_alta else VerifactuRecordType.ANULACION,
        invoice_id=invoice.id,
        issuer_nif=record.issuer_nif,
        invoice_number=record.invoice_number,
        issue_date=record.issue_date,
        invoice_type=record.invoice_type.value if isinstance(record, InvoiceRecord) else "",
        total_tax=record.total_tax if isinstance(record, InvoiceRecord) else None,
        total_amount=record.total_amount if isinstance(record, InvoiceRecord) else None,
        generated_at=record.generated_at,
        previous_hash=previous_hash,
        hash=chain_hash(record, previous_hash),
        qr_url=qr_url,
    )
    db.add(row)
    db.flush()
    return row


def record_from_row(row: VerifactuRecord) -> InvoiceRecord | CancellationRecord:
    generated_at = row.generated_at
    if generated_at.tzinfo is None:
        generated_at = generated_at.replace(tzinfo=UTC)
    generated_at = generated_at.astimezone(MADRID)
    if row.record_type == VerifactuRecordType.ALTA:
        return InvoiceRecord(
            issuer_nif=row.issuer_nif,
            invoice_number=row.invoice_number,
            issue_date=row.issue_date,
            invoice_type=InvoiceType(row.invoice_type),
            total_tax=Decimal(row.total_tax or 0),
            total_amount=Decimal(row.total_amount or 0),
            generated_at=generated_at,
        )
    return CancellationRecord(
        issuer_nif=row.issuer_nif,
        invoice_number=row.invoice_number,
        issue_date=row.issue_date,
        generated_at=generated_at,
    )


def issue(
    db: Session,
    user: CurrentUser,
    invoice: Invoice,
    issue_date: date | None,
    *,
    store_pdf: bool = True,
) -> None:
    """Emite un borrador (sin commit): datos fiscales, recálculo y congelado, número,
    registro de alta Verifactu, pedidos a «facturado», PDF (si se puede) y aviso.

    `invoice` debe venir bloqueado (`get_for_update`) y comprobado con `ensure_manage`.
    """
    tenant = db.get(Tenant, invoice.tenant_id)
    assert tenant is not None
    _tenant_lock(db, invoice.tenant_id)
    issue_date = issue_date or invoice.issue_date
    _check_issue_date(db, invoice, issue_date)
    check_company(tenant)
    customer = db.get(Customer, invoice.customer_id)
    assert customer is not None
    if not (customer.tax_id or "").strip():
        raise AppError(
            409,
            "CUSTOMER_TAX_ID_MISSING",
            f"{customer.name} no tiene NIF: complétalo en su ficha antes de emitir.",
            "customer_id",
        )
    invoice.issue_date = issue_date

    orders: list[Order] = []
    if invoice.kind == InvoiceKind.INVOICE:
        fill_invoice(db, invoice, customer, _order_ids(db, invoice))
        orders = list(
            db.exec(select(Order).where(col(Order.id).in_(_order_ids(db, invoice)))).all()
        )
    else:
        original = rectified_of(db, invoice)
        if original.status != InvoiceStatus.ISSUED:
            raise invalid_status(original)
        # Se vuelve a comprobar contra lo ya abonado: dos borradores pueden cruzarse
        check_credit_lines(db, invoice, original)

    db.flush()
    lines = list(db.exec(select(InvoiceLine).where(InvoiceLine.invoice_id == invoice.id)).all())
    apply_totals(invoice, lines)
    if invoice.total == 0:
        raise AppError(409, "EMPTY_INVOICE", "El importe total es 0: no se puede emitir.", "lines")
    _apply_customer(db, invoice, customer)

    invoice.number = next_number(db, invoice.tenant_id, SERIES[invoice.kind], issue_date.year)
    now = utcnow()
    invoice.status = InvoiceStatus.ISSUED
    invoice.issued_at = invoice.updated_at = now
    invoice.issued_by = user.id
    invoice.company_snapshot = asdict(company_info(tenant))
    db.add(invoice)

    nif = (tenant.tax_id or "").strip()
    record = InvoiceRecord(
        issuer_nif=nif,
        invoice_number=invoice.number,
        issue_date=issue_date,
        invoice_type=InvoiceType(invoice.invoice_type),
        total_tax=Decimal(invoice.vat_amount) + Decimal(invoice.surcharge_amount),
        total_amount=Decimal(invoice.total),
        generated_at=_now_for_record(),
    )
    url = qr.qr_url(nif, invoice.number, issue_date, Decimal(invoice.total), qr_environment())
    _append_record(db, invoice, record, url)

    for order in orders:
        order.status = OrderStatus.INVOICED
        order.updated_at = now
        db.add(order)
    db.flush()

    if store_pdf:
        store_pdf_quietly(db, invoice)
    _notify_issued(db, user, invoice, customer)


def _notify_issued(db: Session, user: CurrentUser, invoice: Invoice, customer: Customer) -> None:
    rep = customer.sales_rep_id
    if rep is None or rep == user.id:
        return
    rep_user = db.get(User, rep)
    if rep_user is None or not rep_user.is_active:
        return
    is_credit = invoice.kind == InvoiceKind.CREDIT_NOTE
    notify(
        db,
        invoice.tenant_id,
        [rep],
        "factura_emitida",
        f"{'Abono' if is_credit else 'Factura'} {invoice.number} "
        f"{'emitido' if is_credit else 'emitida'}",
        f"{customer.name} · {_fmt(Decimal(invoice.total))} € · {invoice.issue_date:%d/%m/%Y}.",
        _link(invoice),
    )


# ─── Anulación ─────────────────────────────────────


def ensure_cancel(user: CurrentUser, invoice: Invoice) -> None:
    if invoice.kind != InvoiceKind.INVOICE or invoice.status != InvoiceStatus.ISSUED:
        raise invalid_status(invoice)
    if not user.can("facturas.abonar"):
        raise forbidden()


def _issued_credit_count(db: Session, invoice_id: UUID) -> int:
    return db.exec(
        select(func.count())
        .select_from(Invoice)
        .where(
            Invoice.rectified_invoice_id == invoice_id,
            Invoice.status == InvoiceStatus.ISSUED,
        )
    ).one()


def cancel(db: Session, user: CurrentUser, invoice: Invoice, reason: str) -> None:
    """Anula una factura emitida sin abonos (sin commit): registro de anulación Verifactu,
    pedidos de vuelta a «entregado» y PDF con la marca de anulada (si se puede)."""
    _tenant_lock(db, invoice.tenant_id)
    if _issued_credit_count(db, invoice.id):
        raise AppError(
            409,
            "HAS_CREDIT_NOTES",
            f"{_label(invoice)} tiene abonos emitidos: no se puede anular.",
        )
    alta = db.exec(
        select(VerifactuRecord)
        .where(
            VerifactuRecord.invoice_id == invoice.id,
            VerifactuRecord.record_type == VerifactuRecordType.ALTA,
        )
        .order_by(col(VerifactuRecord.sequence).desc())
    ).first()
    tenant = db.get(Tenant, invoice.tenant_id)
    assert tenant is not None and invoice.number is not None
    record = CancellationRecord(
        issuer_nif=alta.issuer_nif if alta else (tenant.tax_id or "").strip(),
        invoice_number=invoice.number,
        issue_date=invoice.issue_date,
        generated_at=_now_for_record(),
    )
    _append_record(db, invoice, record)
    now = utcnow()
    invoice.status = InvoiceStatus.CANCELLED
    invoice.status_reason = reason
    invoice.cancelled_at = invoice.updated_at = now
    db.add(invoice)
    orders = db.exec(
        select(Order)
        .where(col(Order.id).in_(_order_ids(db, invoice)), Order.status == OrderStatus.INVOICED)
        .with_for_update()
    ).all()
    for order in orders:
        order.status = OrderStatus.DELIVERED
        order.updated_at = now
        db.add(order)
    db.flush()
    store_pdf_quietly(db, invoice)


def delete_draft(db: Session, invoice: Invoice) -> None:
    db.exec(delete(InvoiceLine).where(col(InvoiceLine.invoice_id) == invoice.id))
    db.delete(invoice)


# ─── PDF ───────────────────────────────────────────


class PdfUnavailable(AppError):
    def __init__(self) -> None:
        super().__init__(
            503, "PDF_UNAVAILABLE", "Ahora mismo no se pueden generar PDF; inténtalo más tarde."
        )


def company_info(tenant: Tenant) -> CompanyInfo:
    place = " ".join(p for p in (tenant.postal_code, tenant.city) if p)
    if tenant.province and tenant.province != tenant.city:
        place = f"{place} ({tenant.province})" if place else tenant.province
    address = ", ".join(p for p in (tenant.address, place) if p)
    return CompanyInfo(
        name=tenant.legal_name or tenant.name,
        tax_id=tenant.tax_id,
        address=address,
        registration=tenant.feed_registration,
    )


def _alta_record(db: Session, invoice_id: UUID) -> VerifactuRecord | None:
    return db.exec(
        select(VerifactuRecord)
        .where(
            VerifactuRecord.invoice_id == invoice_id,
            VerifactuRecord.record_type == VerifactuRecordType.ALTA,
        )
        .order_by(col(VerifactuRecord.sequence).desc())
    ).first()


def invoice_data(db: Session, invoice: Invoice) -> InvoiceData:
    """Datos congelados de la factura para la plantilla PDF (sin consultar maestros)."""
    assert invoice.number is not None
    tenant = db.get(Tenant, invoice.tenant_id)
    assert tenant is not None
    snap = invoice.customer_snapshot or {}
    lines = db.exec(
        select(InvoiceLine)
        .where(InvoiceLine.invoice_id == invoice.id)
        .order_by(col(InvoiceLine.position))
    ).all()
    record = _alta_record(db, invoice.id)
    url = (record.qr_url if record else None) or qr.qr_url(
        (tenant.tax_id or "").strip(),
        invoice.number,
        invoice.issue_date,
        Decimal(invoice.total),
        qr_environment(),
    )
    rectified = rectified_of(db, invoice) if invoice.rectified_invoice_id else None
    return InvoiceData(
        company=CompanyInfo(**invoice.company_snapshot)
        if invoice.company_snapshot
        else company_info(tenant),
        kind=invoice.kind.value,
        number=invoice.number,
        invoice_type=invoice.invoice_type,
        issue_date=invoice.issue_date,
        customer=InvoiceCustomerDoc(
            code=str(snap.get("code", "")),
            name=str(snap.get("name", "")),
            tax_id=snap.get("tax_id"),
            address=str(snap.get("address", "") or ""),
            postal_code=str(snap.get("postal_code", "") or ""),
            city=str(snap.get("city", "") or ""),
            province=str(snap.get("province", "") or ""),
        ),
        lines=[
            InvoiceLineDoc(
                description=ln.description,
                quantity_kg=Decimal(ln.quantity_kg),
                unit_price=Decimal(ln.unit_price),
                vat_rate=Decimal(ln.vat_rate),
                amount=Decimal(ln.amount),
                item_code=ln.item_code,
                delivery_note_number=ln.delivery_note_number,
                delivery_date=ln.delivery_date,
                surcharge_rate=Decimal(ln.surcharge_rate),
            )
            for ln in lines
        ],
        tax_breakdown=[
            TaxBreakdownDoc(
                vat_rate=_dec(b["vat_rate"]),
                base=_dec(b["base"]),
                vat=_dec(b["vat"]),
                surcharge_rate=_dec(b["surcharge_rate"]),
                surcharge=_dec(b["surcharge"]),
            )
            for b in invoice.tax_breakdown
        ],
        taxable_base=Decimal(invoice.taxable_base),
        vat_amount=Decimal(invoice.vat_amount),
        surcharge_amount=Decimal(invoice.surcharge_amount),
        total=Decimal(invoice.total),
        total_kg=Decimal(invoice.total_kg),
        qr_svg=qr.qr_svg(url),
        qr_url=url,
        payment_method=invoice.payment_method_name,
        due_dates=[(date.fromisoformat(d["date"]), _dec(d["amount"])) for d in invoice.due_dates],
        period_from=invoice.period_from,
        period_to=invoice.period_to,
        rectified_number=rectified.number if rectified else None,
        rectified_issue_date=rectified.issue_date if rectified else None,
        rectification_reason=invoice.rectification_reason,
        notes=invoice.notes,
        cancelled=invoice.status == InvoiceStatus.CANCELLED,
    )


def _dec(value: Any) -> Decimal:
    # Los JSON guardan float: se vuelve a Decimal con 2 decimales
    return Decimal(str(value)).quantize(CENT)


def render_pdf(db: Session, invoice: Invoice) -> bytes:
    """Raises: documents.PdfUnavailableError."""
    return documents.render_invoice(invoice_data(db, invoice))


def _store_pdf(db: Session, invoice: Invoice) -> None:
    assert invoice.number is not None
    documents.store(
        db,
        invoice.tenant_id,
        invoice.kind.value,
        invoice.number,
        render_pdf(db, invoice),
        "application/pdf",
        SOURCE_TYPE,
        invoice.id,
        year=invoice.issue_date.year,
    )


def store_pdf_quietly(db: Session, invoice: Invoice) -> None:
    """Genera y guarda el PDF; si no se puede, la emisión sigue y se genera al pedirlo."""
    try:
        with db.begin_nested():
            _store_pdf(db, invoice)
    except documents.PdfUnavailableError:
        logger.warning("PDF de %s pendiente: WeasyPrint no disponible", invoice.number)
    except Exception:
        logger.exception("No se ha podido guardar el PDF de %s", invoice.number)


def invoice_pdf(db: Session, invoice: Invoice) -> bytes:
    """PDF guardado o, si falta o el destino no responde, generado y guardado ahora.
    Quien llama hace commit."""
    if invoice.status == InvoiceStatus.DRAFT or invoice.number is None:
        raise invalid_status(invoice)
    try:
        return documents.fetch(
            db,
            invoice.tenant_id,
            invoice.kind.value,
            invoice.number,
            lambda: render_pdf(db, invoice),
            source_type=SOURCE_TYPE,
            source_id=invoice.id,
        )
    except documents.PdfUnavailableError as exc:
        raise PdfUnavailable() from exc


# ─── Consultas ─────────────────────────────────────

Rectified = aliased(Invoice, name="rectified")
IssuedBy = aliased(User, name="issued_by_user")
CreatedBy = aliased(User, name="created_by_user")


def _query(detail: bool = False):
    columns: list[Any] = [
        Invoice,
        Customer.code,
        Customer.name,
        Customer.sales_rep_id,
        Rectified.number,
    ]
    if detail:
        columns += [IssuedBy.full_name, CreatedBy.full_name]
    query = (
        select(*columns)
        .join(Customer, Customer.id == Invoice.customer_id)
        .outerjoin(Rectified, Rectified.id == Invoice.rectified_invoice_id)
    )
    if detail:
        query = query.outerjoin(IssuedBy, IssuedBy.id == Invoice.issued_by).outerjoin(
            CreatedBy, CreatedBy.id == Invoice.created_by
        )
    return query


def _summary_fields(row) -> dict[str, Any]:
    invoice, code, name, _rep, rectified_number = row[:5]
    snap = invoice.customer_snapshot or {}
    return {
        **invoice.model_dump(),
        "customer_code": snap.get("code") or code,
        "customer_name": snap.get("name") or name,
        "rectified_number": rectified_number,
    }


def _scoped(query, user: CurrentUser):
    if own_scope(user):
        query = query.where(Customer.sales_rep_id == user.id)
    return query


def parse_statuses(value: str | None) -> list[InvoiceStatus]:
    if not value:
        return []
    try:
        return [InvoiceStatus(s.strip()) for s in value.split(",") if s.strip()]
    except ValueError as exc:
        raise bad_request("VALIDATION_ERROR", "Estado de factura no válido.", "status") from exc


def list_invoices(
    db: Session,
    user: CurrentUser,
    page: PageParams,
    kind: InvoiceKind | None,
    statuses: list[InvoiceStatus],
    customer_id: UUID | None,
    date_from: date | None,
    date_to: date | None,
    search: str | None,
) -> tuple[list[InvoiceSummary], int]:
    drafts_first = case((Invoice.status == InvoiceStatus.DRAFT, 0), else_=1)
    query = _scoped(_query(), user).order_by(
        drafts_first,
        col(Invoice.issue_date).desc(),
        col(Invoice.number).desc().nulls_first(),
        col(Invoice.created_at).desc(),
    )
    if kind:
        query = query.where(Invoice.kind == kind)
    if statuses:
        query = query.where(col(Invoice.status).in_(statuses))
    if customer_id:
        query = query.where(Invoice.customer_id == customer_id)
    if date_from:
        query = query.where(Invoice.issue_date >= date_from)
    if date_to:
        query = query.where(Invoice.issue_date <= date_to)
    if search and search.strip():
        pattern = f"%{search.strip()}%"
        query = query.where(
            or_(
                col(Invoice.number).ilike(pattern),
                col(Customer.name).ilike(pattern),
                col(Customer.code).ilike(pattern),
            )
        )
    rows, total = paginate(db, query, page)  # type: ignore[arg-type]
    return [InvoiceSummary.model_validate(_summary_fields(r)) for r in rows], total


def summaries(db: Session, ids: list[UUID]) -> list[InvoiceSummary]:
    if not ids:
        return []
    rows = db.exec(_query().where(col(Invoice.id).in_(ids))).all()
    by_id = {r[0].id: r for r in rows}
    return [InvoiceSummary.model_validate(_summary_fields(by_id[i])) for i in ids if i in by_id]


def allowed_actions(
    user: CurrentUser,
    invoice: Invoice,
    issued_credits: int = 0,
    creditable: bool = False,
) -> list[InvoiceAction]:
    actions: list[InvoiceAction] = []
    if invoice.status == InvoiceStatus.DRAFT:
        if user.can(manage_permission(invoice)):
            actions += ["edit", "delete", "issue"]
    elif (
        invoice.status == InvoiceStatus.ISSUED
        and invoice.kind == InvoiceKind.INVOICE
        and user.can("facturas.abonar")
    ):
        if creditable:
            actions.append("credit_note")
        if issued_credits == 0:
            actions.append("cancel")
    return actions


def invoice_detail(db: Session, user: CurrentUser, invoice_id: UUID) -> InvoiceDetail:
    row = db.exec(_scoped(_query(detail=True), user).where(Invoice.id == invoice_id)).first()
    if row is None:
        raise not_found("No se encuentra la factura.")
    invoice: Invoice = row[0]
    lines = db.exec(
        select(InvoiceLine, Order.number)
        .outerjoin(Order, Order.id == InvoiceLine.order_id)
        .where(InvoiceLine.invoice_id == invoice.id)
        .order_by(col(InvoiceLine.position))
    ).all()
    done = credited(db, invoice.id) if invoice.kind == InvoiceKind.INVOICE else {}
    line_out = []
    creditable = False
    for line, order_number in lines:
        kg, amount = done.get(line.id, (ZERO, ZERO))
        if Decimal(line.amount) - amount > 0:
            creditable = True
        line_out.append(
            InvoiceLineOut.model_validate(
                {
                    **line.model_dump(),
                    "order_number": order_number,
                    "credited_kg": kg,
                    "credited_amount": amount,
                }
            )
        )
    credit_ids = list(
        db.exec(
            select(Invoice.id)
            .where(Invoice.rectified_invoice_id == invoice.id)
            .order_by(col(Invoice.created_at))
        ).all()
    )
    credit_notes = summaries(db, credit_ids)
    issued_credits = sum(1 for c in credit_notes if c.status == InvoiceStatus.ISSUED)
    record = _alta_record(db, invoice.id)
    pdf_ready = bool(
        invoice.number
        and documents.stored_numbers(db, invoice.tenant_id, invoice.kind.value, [invoice.number])
    )
    return InvoiceDetail.model_validate(
        {
            **_summary_fields(row),
            "issued_by_name": row[5],
            "created_by_name": row[6],
            "lines": line_out,
            "credit_notes": credit_notes,
            "verifactu": VerifactuInfo(
                hash=record.hash,
                previous_hash=record.previous_hash,
                generated_at=record.generated_at,
                qr_url=record.qr_url,
            )
            if record
            else None,
            "pdf_ready": pdf_ready,
            "allowed_actions": allowed_actions(user, invoice, issued_credits, creditable),
        }
    )


def _month_bounds(month: str) -> tuple[date, date]:
    try:
        start = datetime.strptime(month, "%Y-%m").date()
    except ValueError as exc:
        raise bad_request("VALIDATION_ERROR", "Mes no válido (AAAA-MM).", "month") from exc
    end = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
    return start, end


def month_summary(db: Session, user: CurrentUser, month: str | None) -> MonthSummary:
    month = month or today_madrid().strftime("%Y-%m")
    start, end = _month_bounds(month)
    previous_start = (start - timedelta(days=1)).replace(day=1)

    def totals(date_from: date, date_to: date) -> tuple[Decimal, Decimal, int]:
        query = (
            select(
                func.coalesce(
                    func.sum(case((Invoice.kind == InvoiceKind.INVOICE, Invoice.total), else_=0)),
                    0,
                ),
                func.coalesce(
                    func.sum(
                        case((Invoice.kind == InvoiceKind.CREDIT_NOTE, Invoice.total), else_=0)
                    ),
                    0,
                ),
                func.count().filter(Invoice.kind == InvoiceKind.INVOICE),
            )
            .select_from(Invoice)
            .join(Customer, Customer.id == Invoice.customer_id)
            .where(
                Invoice.status == InvoiceStatus.ISSUED,
                Invoice.issue_date >= date_from,
                Invoice.issue_date < date_to,
            )
        )
        invoiced, credit, count = db.exec(_scoped(query, user)).one()
        return Decimal(invoiced), Decimal(credit), int(count)

    invoiced, credit, count = totals(start, end)
    prev_invoiced, prev_credit, _ = totals(previous_start, start)
    return MonthSummary(
        month=month,
        invoiced_total=invoiced,
        credit_total=credit,
        net_total=invoiced + credit,
        invoice_count=count,
        previous_month_net=prev_invoiced + prev_credit,
    )


# ─── Registro Verifactu ────────────────────────────


def ensure_all_scope(user: CurrentUser) -> None:
    if not user.can("facturas.ver") or own_scope(user):
        raise forbidden()


def list_records(
    db: Session,
    page: PageParams,
    invoice_id: UUID | None,
    date_from: date | None,
    date_to: date | None,
) -> tuple[list[VerifactuRecordOut], int]:
    generated = cast(func.timezone("Europe/Madrid", VerifactuRecord.generated_at), Date)
    query = select(VerifactuRecord).order_by(col(VerifactuRecord.sequence).desc())
    if invoice_id:
        query = query.where(VerifactuRecord.invoice_id == invoice_id)
    if date_from:
        query = query.where(generated >= date_from)
    if date_to:
        query = query.where(generated <= date_to)
    rows, total = paginate(db, query, page)
    return [VerifactuRecordOut.model_validate(r.model_dump()) for r in rows], total


def verify(db: Session, tenant_id: UUID) -> ChainCheck:
    """Recalcula todas las huellas de la empresa. Además de la huella, marca los
    registros cuyo `previous_hash` guardado no es la huella del anterior o cuya
    secuencia salta."""
    rows = list(
        db.exec(
            select(VerifactuRecord)
            .where(VerifactuRecord.tenant_id == tenant_id)
            .order_by(col(VerifactuRecord.sequence))
        ).all()
    )
    chained = [ChainedRecord(record=record_from_row(r), huella=r.hash) for r in rows]
    broken = set(verify_chain(chained))
    for index, row in enumerate(rows):
        previous = rows[index - 1] if index else None
        expected_previous = previous.hash if previous else None
        expected_sequence = previous.sequence + 1 if previous else 1
        if (row.previous_hash or None) != expected_previous or row.sequence != expected_sequence:
            broken.add(index)
    return ChainCheck(
        ok=not broken,
        records=len(rows),
        broken=[
            BrokenRecord(sequence=rows[i].sequence, invoice_number=rows[i].invoice_number)
            for i in sorted(broken)
        ],
    )
