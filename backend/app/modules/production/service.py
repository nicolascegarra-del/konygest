"""Órdenes de fabricación: consultas, transiciones de estado y alta del producto terminado."""

from datetime import date
from uuid import UUID

from sqlmodel import Session, col, select

from app.core.deps import CurrentUser
from app.core.errors import AppError, not_found
from app.core.pagination import PageParams, paginate
from app.core.security import utcnow
from app.modules.masters.models import Item, ItemKind, Silo
from app.modules.production.models import ProductionOrder, ProductionStatus
from app.modules.production.schemas import OrderIn, OrderOut
from app.modules.stock import service as stock
from app.modules.stock.models import MovementKind
from app.modules.users.models import User

_STATUS_LABELS = {
    ProductionStatus.PLANNED: "planificada",
    ProductionStatus.IN_PROGRESS: "en curso",
    ProductionStatus.DONE: "terminada",
    ProductionStatus.CANCELLED: "cancelada",
}


def _query():
    return (
        select(ProductionOrder, Item.code, Item.name, Silo.code, Silo.name, User.full_name)
        .join(Item, Item.id == ProductionOrder.item_id)
        .join(Silo, Silo.id == ProductionOrder.silo_id)
        .outerjoin(User, User.id == ProductionOrder.created_by)
    )


def _out(row) -> OrderOut:
    order, item_code, item_name, silo_code, silo_name, created_by_name = row
    return OrderOut(
        **order.model_dump(),
        item_code=item_code,
        item_name=item_name,
        silo_code=silo_code,
        silo_name=silo_name,
        created_by_name=created_by_name,
    )


def list_orders(
    db: Session,
    page: PageParams,
    status: ProductionStatus | None,
    date_from: date | None,
    date_to: date | None,
    item_id: UUID | None,
) -> tuple[list[OrderOut], int]:
    query = _query().order_by(
        col(ProductionOrder.planned_date).desc(), col(ProductionOrder.number).desc()
    )
    if status:
        query = query.where(ProductionOrder.status == status)
    if date_from:
        query = query.where(ProductionOrder.planned_date >= date_from)
    if date_to:
        query = query.where(ProductionOrder.planned_date <= date_to)
    if item_id:
        query = query.where(ProductionOrder.item_id == item_id)
    rows, total = paginate(db, query, page)  # type: ignore[arg-type]
    return [_out(r) for r in rows], total


def order_out(db: Session, order_id: UUID) -> OrderOut:
    row = db.exec(_query().where(ProductionOrder.id == order_id)).first()
    if row is None:
        raise not_found("No se encuentra la orden de fabricación.")
    return _out(row)


def get_for_update(db: Session, order_id: UUID) -> ProductionOrder:
    """Carga la orden bloqueando su fila: dos «terminar» simultáneos no deben crear
    dos movimientos de producción."""
    order = db.exec(
        select(ProductionOrder).where(ProductionOrder.id == order_id).with_for_update()
    ).first()
    if order is None:
        raise not_found("No se encuentra la orden de fabricación.")
    return order


def ensure_status(order: ProductionOrder, *allowed: ProductionStatus) -> None:
    if order.status not in allowed:
        raise AppError(
            409,
            "INVALID_STATUS",
            f"La orden {order.number} está {_STATUS_LABELS[order.status]}; "
            "no se puede hacer esta acción.",
        )


def apply_data(db: Session, order: ProductionOrder, data: OrderIn) -> None:
    # Solo se fabrican piensos; las materias primas entran por báscula
    stock.get_item(db, data.item_id, kind=ItemKind.PRODUCT)
    stock.get_silo(db, data.silo_id)
    order.item_id = data.item_id
    order.silo_id = data.silo_id
    order.planned_kg = data.planned_kg
    order.planned_date = data.planned_date
    order.notes = data.notes


def finish(
    db: Session, user: CurrentUser, order: ProductionOrder, produced_kg, silo_id: UUID | None
) -> None:
    """Termina la orden y da de alta el producto terminado en el silo de descarga."""
    ensure_status(order, ProductionStatus.PLANNED, ProductionStatus.IN_PROGRESS)
    item = stock.get_item(db, order.item_id)
    silo = stock.get_silo(db, silo_id or order.silo_id)
    now = utcnow()
    stock.record_movement(
        db,
        user,
        item,
        silo,
        MovementKind.PRODUCTION,
        produced_kg,
        source_type="production_order",
        source_id=order.id,
        notes=f"Orden {order.number}",
        occurred_at=now,
    )
    # La orden refleja dónde se descargó realmente
    order.silo_id = silo.id
    order.produced_kg = produced_kg
    order.status = ProductionStatus.DONE
    order.finished_at = now
    if order.started_at is None:
        order.started_at = now
    db.add(order)
