"""Pedidos de los comerciales: alcance, consultas, validación de datos, transiciones de
estado, comprobaciones de riesgo/precio/stock y avisos.

Las rutas solo orquestan: aquí se decide quién puede hacer qué sobre cada pedido
(`allowed_actions`) y las comprobaciones que lo impiden, para que la ficha y las
acciones nunca discrepen.
"""

from collections import defaultdict
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import ColumnElement, func, or_
from sqlalchemy.orm import aliased
from sqlmodel import Session, col, delete, select

from app.core.catalog import Scope
from app.core.deps import CurrentUser
from app.core.errors import AppError, bad_request, forbidden, not_found
from app.core.pagination import PageParams, paginate
from app.core.security import utcnow
from app.modules.masters.models import Customer, Farm, Item, ItemKind
from app.modules.masters.service import quote_price
from app.modules.notifications.service import notify
from app.modules.orders.models import Order, OrderLine, OrderStatus, PriceSource
from app.modules.orders.schemas import (
    CreditCheck,
    DaySummary,
    OrderAction,
    OrderChecks,
    OrderDetail,
    OrderIn,
    OrderLineOut,
    OrderSummary,
    PriceCheck,
    StockCheck,
)
from app.modules.stock import service as stock
from app.modules.stock.models import StockMovement
from app.modules.users.models import RolePermission, User, UserRole

ZERO = Decimal(0)
CENT = Decimal("0.01")
MADRID = ZoneInfo("Europe/Madrid")
MAX_SUMMARY_DAYS = 62

STATUS_LABELS = {
    OrderStatus.DRAFT: "en borrador",
    OrderStatus.PENDING: "pendiente de validar",
    OrderStatus.REJECTED: "rechazado",
    OrderStatus.CONFIRMED: "confirmado",
    OrderStatus.PLANNED: "planificado",
    OrderStatus.LOADED: "cargado",
    OrderStatus.DELIVERED: "entregado",
    OrderStatus.INVOICED: "facturado",
    OrderStatus.CANCELLED: "cancelado",
}
# Pedidos que ya consumen riesgo del cliente (aceptados y aún no facturados)
CREDIT_STATUSES = (
    OrderStatus.CONFIRMED,
    OrderStatus.PLANNED,
    OrderStatus.LOADED,
    OrderStatus.DELIVERED,
)
# Pedidos aceptados que salen en el resumen por fecha de entrega
SUMMARY_STATUSES = CREDIT_STATUSES
# Kilos comprometidos: aceptados pero todavía no cargados (siguen en el stock)
COMMITTED_STATUSES = (OrderStatus.CONFIRMED, OrderStatus.PLANNED)
# Estados en los que el comercial trabaja el pedido
EDITABLE_BY_CREATOR = (OrderStatus.DRAFT, OrderStatus.REJECTED)
CANCELLABLE_BY_CREATOR = (OrderStatus.DRAFT, OrderStatus.REJECTED, OrderStatus.PENDING)


def today_madrid() -> date:
    """Hoy en la fábrica: a las 00:30 en España ya es el día siguiente aunque en UTC no."""
    return datetime.now(MADRID).date()


# ─── Alcance y permisos ────────────────────────────


def _own(user: CurrentUser, permission: str) -> bool:
    return user.scope(permission) == Scope.OWN


def _scope_clause(user: CurrentUser) -> ColumnElement[bool]:
    # El comercial ve los pedidos que lleva él y los de los clientes que lleva él
    return or_(Order.sales_rep_id == user.id, Customer.sales_rep_id == user.id)


def _in_scope(
    user: CurrentUser, permission: str, order: Order, customer_rep_id: UUID | None
) -> bool:
    if not user.can(permission):
        return False
    if not _own(user, permission):
        return True
    return user.id in (order.sales_rep_id, customer_rep_id)


def _creator_can(user: CurrentUser, order: Order, customer_rep_id: UUID | None) -> bool:
    return _in_scope(user, "pedidos.crear", order, customer_rep_id)


def allowed_actions(
    user: CurrentUser, order: Order, customer_rep_id: UUID | None
) -> list[OrderAction]:
    """Acciones que el usuario puede hacer ya sobre el pedido (tabla del contrato)."""
    creator = _creator_can(user, order, customer_rep_id)
    validator = user.can("pedidos.validar")
    status = order.status
    actions: list[OrderAction] = []
    if (status in EDITABLE_BY_CREATOR and creator) or (status == OrderStatus.PENDING and validator):
        actions.append("edit")
    if status in EDITABLE_BY_CREATOR and creator:
        actions.append("submit")
    if status == OrderStatus.PENDING and validator:
        actions += ["validate", "reject"]
    if (status in CANCELLABLE_BY_CREATOR and (creator or validator)) or (
        status == OrderStatus.CONFIRMED and validator
    ):
        actions.append("cancel")
    return actions


def _invalid_status(order: Order) -> AppError:
    return AppError(
        409,
        "INVALID_STATUS",
        f"El pedido {order.number} está {STATUS_LABELS[order.status]}; "
        "no se puede hacer esta acción.",
    )


def ensure_action(
    user: CurrentUser,
    order: Order,
    customer_rep_id: UUID | None,
    action: OrderAction,
    statuses: tuple[OrderStatus, ...],
) -> None:
    """409 si la acción no existe desde el estado actual; 403 si existe pero no para él.

    Se distingue para que el frontend explique «ya no se puede» frente a «no te toca».
    """
    if order.status not in statuses:
        raise _invalid_status(order)
    if action not in allowed_actions(user, order, customer_rep_id):
        raise forbidden()


# ─── Consultas ─────────────────────────────────────

SalesRep = aliased(User, name="sales_rep")
Creator = aliased(User, name="creator")
Validator = aliased(User, name="validator")


def _line_stats():
    """Nº de líneas y si alguna va por debajo de su precio de referencia, por pedido.

    Agregado aparte y unido por pedido para que el listado sea una sola consulta.
    """
    return (
        select(
            OrderLine.order_id,
            func.count().label("line_count"),
            func.bool_or(OrderLine.unit_price < OrderLine.reference_price).label("below"),
        )
        .group_by(OrderLine.order_id)
        .subquery()
    )


def _query(detail: bool = False):
    stats = _line_stats()
    columns = [
        Order,
        Customer.code,
        Customer.name,
        Customer.sales_rep_id,
        Farm.name,
        SalesRep.full_name,
        func.coalesce(stats.c.line_count, 0),
        func.coalesce(stats.c.below, False),
    ]
    if detail:
        columns += [Creator.full_name, Validator.full_name]
    query = (
        select(*columns)
        .join(Customer, Customer.id == Order.customer_id)
        .join(Farm, Farm.id == Order.farm_id)
        .outerjoin(SalesRep, SalesRep.id == Order.sales_rep_id)
        .outerjoin(stats, stats.c.order_id == Order.id)
    )
    if detail:
        query = query.outerjoin(Creator, Creator.id == Order.created_by).outerjoin(
            Validator, Validator.id == Order.validated_by
        )
    return query


def _summary_fields(row) -> dict:
    order, code, name, _rep, farm_name, rep_name, line_count, below = row[:8]
    return {
        **order.model_dump(),
        "customer_code": code,
        "customer_name": name,
        "farm_name": farm_name,
        "sales_rep_name": rep_name,
        "line_count": line_count,
        "has_manual_price": bool(below),
    }


def parse_statuses(value: str | None) -> list[OrderStatus]:
    if not value:
        return []
    try:
        return [OrderStatus(s.strip()) for s in value.split(",") if s.strip()]
    except ValueError as exc:
        raise bad_request("VALIDATION_ERROR", "Estado de pedido no válido.", "status") from exc


def list_orders(
    db: Session,
    user: CurrentUser,
    page: PageParams,
    statuses: list[OrderStatus],
    customer_id: UUID | None,
    sales_rep_id: UUID | None,
    date_from: date | None,
    date_to: date | None,
    search: str | None,
    mine: bool,
) -> tuple[list[OrderSummary], int]:
    query = _query().order_by(col(Order.requested_date).desc(), col(Order.number).desc())
    if _own(user, "pedidos.ver"):
        query = query.where(_scope_clause(user))
    if statuses:
        query = query.where(col(Order.status).in_(statuses))
    if customer_id:
        query = query.where(Order.customer_id == customer_id)
    if sales_rep_id:
        query = query.where(Order.sales_rep_id == sales_rep_id)
    if date_from:
        query = query.where(Order.requested_date >= date_from)
    if date_to:
        query = query.where(Order.requested_date <= date_to)
    if search and search.strip():
        pattern = f"%{search.strip()}%"
        query = query.where(
            or_(
                col(Order.number).ilike(pattern),
                col(Customer.name).ilike(pattern),
                col(Customer.code).ilike(pattern),
            )
        )
    if mine:
        query = query.where(or_(Order.sales_rep_id == user.id, Order.created_by == user.id))
    rows, total = paginate(db, query, page)  # type: ignore[arg-type]
    return [OrderSummary.model_validate(_summary_fields(r)) for r in rows], total


def order_detail(db: Session, user: CurrentUser, order_id: UUID) -> OrderDetail:
    query = _query(detail=True).where(Order.id == order_id)
    if _own(user, "pedidos.ver"):
        query = query.where(_scope_clause(user))
    row = db.exec(query).first()
    if row is None:
        raise not_found("No se encuentra el pedido.")
    order: Order = row[0]
    lines = db.exec(
        select(OrderLine, Item.code, Item.name)
        .join(Item, Item.id == OrderLine.item_id)
        .where(OrderLine.order_id == order.id)
        .order_by(col(OrderLine.position))
    ).all()
    return OrderDetail.model_validate(
        {
            **_summary_fields(row),
            "created_by_name": row[8],
            "validated_by_name": row[9],
            "allowed_actions": allowed_actions(user, order, row[3]),
            "lines": [
                OrderLineOut.model_validate(
                    {**line.model_dump(), "item_code": code, "item_name": name}
                )
                for line, code, name in lines
            ],
        }
    )


def get_for_update(db: Session, user: CurrentUser, order_id: UUID) -> tuple[Order, Customer]:
    """Carga el pedido bloqueando su fila (dos validaciones simultáneas no deben pasar
    ambas) y comprueba que el usuario lo ve; si no, 404 como si no existiera."""
    order = db.exec(select(Order).where(Order.id == order_id).with_for_update()).first()
    if order is None:
        raise not_found("No se encuentra el pedido.")
    customer = db.get(Customer, order.customer_id)
    assert customer is not None  # FK RESTRICT
    if not _in_scope(user, "pedidos.ver", order, customer.sales_rep_id):
        raise not_found("No se encuentra el pedido.")
    return order, customer


def summary(db: Session, user: CurrentUser, date_from: date, date_to: date) -> list[DaySummary]:
    if date_to < date_from:
        raise bad_request("VALIDATION_ERROR", "La fecha final es anterior a la inicial.", "date_to")
    if (date_to - date_from).days + 1 > MAX_SUMMARY_DAYS:
        raise bad_request(
            "VALIDATION_ERROR",
            f"El rango no puede superar {MAX_SUMMARY_DAYS} días.",
            "date_to",
        )
    query = (
        select(Order.requested_date, func.count(), func.sum(Order.total_kg))
        .join(Customer, Customer.id == Order.customer_id)
        .where(
            col(Order.status).in_(SUMMARY_STATUSES),
            Order.requested_date >= date_from,
            Order.requested_date <= date_to,
        )
        .group_by(Order.requested_date)
        .order_by(Order.requested_date)
    )
    if _own(user, "pedidos.ver"):
        query = query.where(_scope_clause(user))
    return [
        DaySummary(date=day, orders=count, total_kg=kg or ZERO)
        for day, count, kg in db.exec(query).all()
    ]


# ─── Alta y edición ────────────────────────────────


def apply_data(
    db: Session, user: CurrentUser, order: Order, data: OrderIn, as_validator: bool = False
) -> None:
    """Valida la entrada y deja el pedido con sus nuevas líneas y totales (sin commit).

    `as_validator`: oficina editando un pedido pendiente; no se le aplica el alcance
    «propios» del comercial aunque también lo tenga para crear.
    """
    own = _own(user, "pedidos.crear") and not as_validator
    if data.requested_date < today_madrid():
        raise bad_request(
            "VALIDATION_ERROR", "La fecha de entrega no puede ser anterior a hoy.", "requested_date"
        )
    customer = db.get(Customer, data.customer_id)
    if customer is None or not customer.is_active or (own and customer.sales_rep_id != user.id):
        raise bad_request(
            "INVALID_REFERENCE", "El cliente no existe, está de baja o no es tuyo.", "customer_id"
        )
    farm = db.get(Farm, data.farm_id)
    if farm is None or not farm.is_active or farm.customer_id != customer.id:
        raise bad_request(
            "INVALID_REFERENCE", "La explotación no existe o no es de ese cliente.", "farm_id"
        )
    if own:
        sales_rep_id: UUID | None = user.id
    elif data.sales_rep_id:
        rep = db.get(User, data.sales_rep_id)
        if rep is None or not rep.is_active or rep.tenant_id != user.tenant_id:
            raise bad_request("INVALID_REFERENCE", "El comercial no existe.", "sales_rep_id")
        sales_rep_id = rep.id
    else:
        sales_rep_id = customer.sales_rep_id

    silo_names = {str(s.get("name", "")) for s in farm.silos}
    seen: set[tuple[UUID, str]] = set()
    lines: list[OrderLine] = []
    for index, line in enumerate(data.lines):
        field = f"lines.{index}"
        key = (line.item_id, line.farm_silo)
        if key in seen:
            raise bad_request(
                "VALIDATION_ERROR", "Ese pienso ya está en otra línea para el mismo silo.", field
            )
        seen.add(key)
        item = stock.get_item(db, line.item_id, f"{field}.item_id", kind=ItemKind.PRODUCT)
        if line.farm_silo and line.farm_silo not in silo_names:
            raise bad_request(
                "INVALID_REFERENCE", "La explotación no tiene ese silo.", f"{field}.farm_silo"
            )
        quote = quote_price(db, customer, item)
        reference = quote.price
        if line.unit_price is None:
            if reference is None:
                raise bad_request(
                    "PRICE_REQUIRED",
                    f"{item.code} no tiene precio para este cliente: indícalo.",
                    f"{field}.unit_price",
                )
            unit_price, source = reference, PriceSource(quote.source)
        else:
            unit_price = line.unit_price
            source = (
                PriceSource(quote.source)
                if reference is not None and unit_price == reference
                else PriceSource.MANUAL
            )
        lines.append(
            OrderLine(
                tenant_id=order.tenant_id,
                order_id=order.id,
                position=index + 1,
                item_id=item.id,
                quantity_kg=line.quantity_kg,
                unit_price=unit_price,
                price_source=source,
                reference_price=reference,
                amount=(line.quantity_kg * unit_price).quantize(CENT, ROUND_HALF_UP),
                farm_silo=line.farm_silo,
                notes=line.notes,
            )
        )

    order.customer_id = customer.id
    order.farm_id = farm.id
    order.sales_rep_id = sales_rep_id
    order.requested_date = data.requested_date
    order.notes = data.notes
    order.total_kg = sum((ln.quantity_kg for ln in lines), ZERO)
    order.total_amount = sum((ln.amount for ln in lines), ZERO)
    order.updated_at = utcnow()
    db.add(order)
    # Se reemplazan todas las líneas: el PUT trae el pedido completo
    db.exec(delete(OrderLine).where(col(OrderLine.order_id) == order.id))
    db.add_all(lines)


# ─── Transiciones ──────────────────────────────────


def _link(order: Order) -> str:
    return f"/pedidos/{order.id}"


def _fmt(value: Decimal) -> str:
    """1234.5 → "1.234,50" (formato es-ES) para los textos de los avisos."""
    return f"{value:,.2f}".replace(",", "_").replace(".", ",").replace("_", ".")


def submit(db: Session, user: CurrentUser, order: Order, customer: Customer) -> None:
    order.status = OrderStatus.PENDING
    order.submitted_at = order.updated_at = utcnow()
    db.add(order)
    recipients = [
        uid
        for uid in db.exec(
            select(UserRole.user_id)
            .join(RolePermission, RolePermission.role_id == UserRole.role_id)
            .join(User, User.id == UserRole.user_id)
            .where(RolePermission.permission == "pedidos.validar", User.is_active)
            .distinct()
        ).all()
        if uid != user.id
    ]
    if recipients:
        notify(
            db,
            order.tenant_id,
            recipients,
            "pedido_pendiente",
            f"Pedido {order.number} pendiente de validar",
            f"{customer.name} · {_fmt(order.total_kg)} kg · enviado por {user.full_name}.",
            _link(order),
        )


def _owners(order: Order, actor: CurrentUser) -> list[UUID]:
    """Comercial del pedido y quien lo creó, sin repetir y sin quien hace la acción."""
    ids = {order.sales_rep_id, order.created_by} - {None, actor.id}
    return [i for i in ids if i is not None]


def credit_check(db: Session, order: Order, customer: Customer) -> CreditCheck:
    outstanding = db.exec(
        select(func.coalesce(func.sum(Order.total_amount), ZERO)).where(
            Order.customer_id == customer.id,
            Order.id != order.id,
            col(Order.status).in_(CREDIT_STATUSES),
        )
    ).one()
    outstanding = Decimal(outstanding)
    limit = customer.credit_limit
    available = None if limit is None else limit - outstanding - order.total_amount
    return CreditCheck(
        credit_limit=limit,
        outstanding_amount=outstanding,
        order_amount=order.total_amount,
        available=available,
        exceeded=available is not None and available < 0,
    )


def validate(
    db: Session, user: CurrentUser, order: Order, customer: Customer, notes: str, force: bool
) -> bool:
    """Confirma el pedido. Devuelve si ha hecho falta forzar el límite de riesgo."""
    # Bloquea al cliente: dos validaciones simultáneas de pedidos suyos no deben
    # caber cada una en el riesgo por separado y superarlo entre las dos.
    db.exec(select(Customer.id).where(Customer.id == customer.id).with_for_update()).one()
    credit = credit_check(db, order, customer)
    if credit.exceeded and not force:
        raise AppError(
            409,
            "CREDIT_LIMIT_EXCEEDED",
            f"El pedido supera el riesgo de {customer.name}: disponible "
            f"{_fmt(credit.available or ZERO)} €.",
        )
    now = utcnow()
    order.status = OrderStatus.CONFIRMED
    order.validated_by = user.id
    order.validated_at = order.updated_at = now
    db.add(order)
    recipients = _owners(order, user)
    if recipients:
        body = f"{customer.name} · entrega el {order.requested_date:%d/%m/%Y}."
        if notes:
            body += f" Nota de oficina: {notes}"
        notify(
            db,
            order.tenant_id,
            recipients,
            "pedido_confirmado",
            f"Pedido {order.number} confirmado",
            body,
            _link(order),
        )
    return credit.exceeded


def reject(db: Session, user: CurrentUser, order: Order, customer: Customer, reason: str) -> None:
    order.status = OrderStatus.REJECTED
    order.status_reason = reason
    # validated_by/at guardan la última revisión de oficina, también si fue un rechazo
    order.validated_by = user.id
    order.validated_at = order.updated_at = utcnow()
    db.add(order)
    recipients = _owners(order, user)
    if recipients:
        notify(
            db,
            order.tenant_id,
            recipients,
            "pedido_rechazado",
            f"Pedido {order.number} rechazado",
            f"{customer.name}. Motivo: {reason}",
            _link(order),
        )


def cancel(db: Session, order: Order, reason: str) -> None:
    order.status = OrderStatus.CANCELLED
    order.status_reason = reason
    order.updated_at = utcnow()
    db.add(order)


# ─── Comprobaciones ────────────────────────────────


def checks(db: Session, user: CurrentUser, order_id: UUID) -> OrderChecks:
    order = db.get(Order, order_id)
    customer = db.get(Customer, order.customer_id) if order else None
    if (
        order is None
        or customer is None
        or not _in_scope(user, "pedidos.ver", order, customer.sales_rep_id)
    ):
        raise not_found("No se encuentra el pedido.")
    lines = db.exec(
        select(OrderLine, Item.code, Item.name)
        .join(Item, Item.id == OrderLine.item_id)
        .where(OrderLine.order_id == order.id)
        .order_by(col(OrderLine.position))
    ).all()

    prices = [
        PriceCheck(
            line_id=line.id,
            item_code=code,
            item_name=name,
            unit_price=line.unit_price,
            reference_price=line.reference_price,
            difference_pct=float(
                ((line.unit_price - line.reference_price) / line.reference_price * 100).quantize(
                    CENT, ROUND_HALF_UP
                )
            ),
        )
        for line, code, name in lines
        if line.reference_price and line.unit_price < line.reference_price
    ]

    requested: dict[UUID, Decimal] = defaultdict(Decimal)
    names: dict[UUID, tuple[str, str]] = {}
    for line, code, name in lines:
        requested[line.item_id] += line.quantity_kg
        names[line.item_id] = (code, name)
    item_ids = list(requested)
    on_hand = dict(
        db.exec(
            select(StockMovement.item_id, func.sum(StockMovement.quantity_kg))
            .where(col(StockMovement.item_id).in_(item_ids))
            .group_by(StockMovement.item_id)
        ).all()
    )
    committed = dict(
        db.exec(
            select(OrderLine.item_id, func.sum(OrderLine.quantity_kg))
            .join(Order, Order.id == OrderLine.order_id)
            .where(
                col(OrderLine.item_id).in_(item_ids),
                Order.id != order.id,
                col(Order.status).in_(COMMITTED_STATUSES),
            )
            .group_by(OrderLine.item_id)
        ).all()
    )
    stock_rows = []
    for item_id in item_ids:
        stock_kg = Decimal(on_hand.get(item_id) or ZERO)
        committed_kg = Decimal(committed.get(item_id) or ZERO)
        stock_rows.append(
            StockCheck(
                item_id=item_id,
                item_code=names[item_id][0],
                item_name=names[item_id][1],
                requested_kg=requested[item_id],
                stock_kg=stock_kg,
                committed_kg=committed_kg,
                short=requested[item_id] + committed_kg > stock_kg,
            )
        )
    return OrderChecks(credit=credit_check(db, order, customer), prices=prices, stock=stock_rows)
