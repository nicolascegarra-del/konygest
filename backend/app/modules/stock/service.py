"""Servicio central de stock.

Todo cambio de stock (entradas de materia prima, ajustes, inventarios, fabricación y,
en fases posteriores, consumos y cargas) pasa por `record_movement`, que es quien
garantiza que no se queda stock negativo y quien avisa de las roturas de stock.
"""

from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from uuid import UUID

from sqlalchemy import and_, func, text
from sqlmodel import Session, col, or_, select

from app.core.deps import CurrentUser
from app.core.errors import AppError, bad_request
from app.core.pagination import PageParams, paginate
from app.modules.masters.models import Item, ItemKind, Silo
from app.modules.notifications.service import notify
from app.modules.stock.models import MovementKind, RawMaterialReceipt, StockMovement
from app.modules.stock.schemas import LevelOut, MovementOut, ReceiptOut, SummaryOut
from app.modules.users.models import RolePermission, User, UserRole

ZERO = Decimal(0)
_KIND_LABELS = {ItemKind.PRODUCT: "un pienso", ItemKind.RAW_MATERIAL: "una materia prima"}


# ─── Referencias ───────────────────────────────────


def get_item(
    db: Session, item_id: UUID, field: str = "item_id", kind: ItemKind | None = None
) -> Item:
    """Artículo activo de la empresa. Con RLS, uno de otra empresa simplemente no existe.

    Si se pide un tipo concreto y no coincide → 400 `INVALID_ITEM_KIND` (distinto de
    `INVALID_REFERENCE` para que el frontend pueda explicar que el artículo existe pero
    no sirve aquí).
    """
    item = db.get(Item, item_id)
    if item is None or not item.is_active:
        raise bad_request("INVALID_REFERENCE", "El artículo no existe o está de baja.", field)
    if kind is not None and item.kind != kind:
        raise bad_request("INVALID_ITEM_KIND", f"El artículo debe ser {_KIND_LABELS[kind]}.", field)
    return item


def get_silo(db: Session, silo_id: UUID, field: str = "silo_id") -> Silo:
    silo = db.get(Silo, silo_id)
    if silo is None or not silo.is_active:
        raise bad_request("INVALID_REFERENCE", "El silo no existe o está de baja.", field)
    return silo


# ─── Saldos y movimientos ──────────────────────────


def lock_item(db: Session, tenant_id: UUID, item_id: UUID) -> None:
    """Serializa los movimientos de un mismo artículo hasta el final de la transacción.

    Sin este bloqueo, dos salidas simultáneas podrían leer el mismo saldo y dejarlo
    negativo entre las dos. Se bloquea por artículo (no por silo) porque el aviso de
    stock mínimo depende del total de todos los silos.
    """
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"stock:{tenant_id}:{item_id}"},
    )


def balances(db: Session, item_id: UUID, silo_id: UUID) -> tuple[Decimal, Decimal]:
    """(total del artículo en todos los silos, saldo en el silo indicado)."""
    qty = StockMovement.quantity_kg
    total, in_silo = db.exec(
        select(
            func.coalesce(func.sum(qty), ZERO),
            func.coalesce(func.sum(qty).filter(StockMovement.silo_id == silo_id), ZERO),
        ).where(StockMovement.item_id == item_id)
    ).one()
    return Decimal(total), Decimal(in_silo)


def record_movement(
    db: Session,
    user: CurrentUser,
    item: Item,
    silo: Silo,
    kind: MovementKind,
    quantity_kg: Decimal,
    source_type: str | None = None,
    source_id: UUID | None = None,
    notes: str = "",
    lot: str | None = None,
    occurred_at: datetime | None = None,
) -> StockMovement:
    """Registra un movimiento (sin commit) comprobando el saldo y avisando de roturas.

    Raises:
        AppError 409 INSUFFICIENT_STOCK: si dejaría negativo el saldo del artículo en
            el silo (salvo inventario, que fija el valor contado).
    """
    if quantity_kg == 0:
        raise ValueError("Un movimiento de stock no puede ser de 0 kg")
    tenant_id = user.tenant_id
    assert tenant_id is not None
    lock_item(db, tenant_id, item.id)
    total_before, silo_before = balances(db, item.id, silo.id)
    if kind != MovementKind.INVENTORY and silo_before + quantity_kg < 0:
        raise AppError(
            409,
            "INSUFFICIENT_STOCK",
            f"No hay stock suficiente de {item.code} en {silo.code}: "
            f"hay {_fmt_kg(silo_before)} kg.",
        )
    movement = StockMovement(
        tenant_id=tenant_id,
        item_id=item.id,
        silo_id=silo.id,
        kind=kind,
        quantity_kg=quantity_kg,
        lot=lot,
        source_type=source_type,
        source_id=source_id,
        notes=notes[:500],
        user_id=user.id,
    )
    if occurred_at is not None:
        movement.occurred_at = occurred_at
    db.add(movement)
    db.flush()

    total_after = total_before + quantity_kg
    minimum = item.min_stock_kg or ZERO
    if minimum > 0 and total_before >= minimum > total_after:
        _notify_low_stock(db, tenant_id, item, total_after)
    return movement


def _notify_low_stock(db: Session, tenant_id: UUID, item: Item, total: Decimal) -> None:
    # Solo al cruzar el mínimo hacia abajo, para no avisar en cada salida posterior
    recipients = list(
        db.exec(
            select(UserRole.user_id)
            .join(RolePermission, RolePermission.role_id == UserRole.role_id)
            .join(User, User.id == UserRole.user_id)
            .where(RolePermission.permission == "stock.ajustar", User.is_active)
            .distinct()
        ).all()
    )
    if not recipients:
        return
    notify(
        db,
        tenant_id,
        recipients,
        "stock_bajo",
        f"Stock bajo: {item.code} {item.name}",
        f"Quedan {_fmt_kg(total)} kg; el mínimo es {_fmt_kg(item.min_stock_kg)} kg.",
        "/fabrica/stock",
    )


def _fmt_kg(value: Decimal) -> str:
    """1234.5 → "1.234,50" (formato es-ES)."""
    return f"{value:,.2f}".replace(",", "_").replace(".", ",").replace("_", ".")


def as_utc(value: datetime) -> datetime:
    # Una fecha-hora sin zona se interpreta como UTC (las APIs trabajan en UTC)
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


def day_start(value: date) -> datetime:
    return datetime.combine(value, time.min, tzinfo=UTC)


def day_end(value: date) -> datetime:
    """Inicio del día siguiente, para filtrar con `<` y no perder el último segundo."""
    return day_start(value + timedelta(days=1))


# ─── Consultas ─────────────────────────────────────


def list_levels(
    db: Session,
    page: PageParams,
    item_id: UUID | None,
    silo_id: UUID | None,
    kind: ItemKind | None,
) -> tuple[list[LevelOut], int]:
    quantity = func.sum(StockMovement.quantity_kg)
    query = (
        select(
            StockMovement.item_id,
            Item.code.label("item_code"),  # type: ignore[attr-defined]
            Item.name.label("item_name"),  # type: ignore[attr-defined]
            Item.kind.label("item_kind"),  # type: ignore[attr-defined]
            StockMovement.silo_id,
            Silo.code.label("silo_code"),  # type: ignore[attr-defined]
            Silo.name.label("silo_name"),  # type: ignore[attr-defined]
            quantity.label("quantity_kg"),
        )
        .join(Item, Item.id == StockMovement.item_id)
        .join(Silo, Silo.id == StockMovement.silo_id)
        .group_by(
            StockMovement.item_id,
            Item.code,
            Item.name,
            Item.kind,
            StockMovement.silo_id,
            Silo.code,
            Silo.name,
        )
        .having(quantity != 0)
        .order_by(Silo.code, Item.code)
    )
    if item_id:
        query = query.where(StockMovement.item_id == item_id)
    if silo_id:
        query = query.where(StockMovement.silo_id == silo_id)
    if kind:
        query = query.where(Item.kind == kind)
    rows, total = paginate(db, query, page)  # type: ignore[arg-type]
    return [LevelOut.model_validate(r._mapping) for r in rows], total


def list_summary(
    db: Session,
    page: PageParams,
    search: str | None,
    kind: ItemKind | None,
    below_min: bool | None,
) -> tuple[list[SummaryOut], int]:
    sums = (
        select(StockMovement.item_id, func.sum(StockMovement.quantity_kg).label("quantity"))
        .group_by(StockMovement.item_id)
        .subquery()
    )
    quantity = func.coalesce(sums.c.quantity, ZERO)
    is_below = and_(Item.min_stock_kg > 0, quantity < Item.min_stock_kg)
    query = (
        select(
            Item.id.label("item_id"),  # type: ignore[union-attr]
            Item.code.label("item_code"),  # type: ignore[attr-defined]
            Item.name.label("item_name"),  # type: ignore[attr-defined]
            Item.kind.label("item_kind"),  # type: ignore[attr-defined]
            quantity.label("quantity_kg"),
            Item.min_stock_kg,
            is_below.label("below_min"),
        )
        .outerjoin(sums, sums.c.item_id == Item.id)
        .where(Item.is_active)
        .order_by(Item.code)
    )
    if kind:
        query = query.where(Item.kind == kind)
    if search and search.strip():
        pattern = f"%{search.strip()}%"
        query = query.where(or_(col(Item.code).ilike(pattern), col(Item.name).ilike(pattern)))
    # En SQL y no en Python para que total y paginación cuadren
    if below_min is True:
        query = query.where(is_below)
    elif below_min is False:
        query = query.where(~is_below)
    rows, total = paginate(db, query, page)  # type: ignore[arg-type]
    return [SummaryOut.model_validate(r._mapping) for r in rows], total


def _movement_query():
    return (
        select(
            StockMovement,
            Item.code,
            Item.name,
            Silo.code,
            Silo.name,
            User.full_name,
        )
        .join(Item, Item.id == StockMovement.item_id)
        .join(Silo, Silo.id == StockMovement.silo_id)
        .outerjoin(User, User.id == StockMovement.user_id)
    )


def _movement_out(row) -> MovementOut:
    movement, item_code, item_name, silo_code, silo_name, user_name = row
    return MovementOut(
        **movement.model_dump(),
        item_code=item_code,
        item_name=item_name,
        silo_code=silo_code,
        silo_name=silo_name,
        user_name=user_name,
    )


def list_movements(
    db: Session,
    page: PageParams,
    item_id: UUID | None,
    silo_id: UUID | None,
    kind: MovementKind | None,
    date_from: date | None,
    date_to: date | None,
) -> tuple[list[MovementOut], int]:
    query = _movement_query().order_by(
        col(StockMovement.occurred_at).desc(), col(StockMovement.created_at).desc()
    )
    if item_id:
        query = query.where(StockMovement.item_id == item_id)
    if silo_id:
        query = query.where(StockMovement.silo_id == silo_id)
    if kind:
        query = query.where(StockMovement.kind == kind)
    if date_from:
        query = query.where(StockMovement.occurred_at >= day_start(date_from))
    if date_to:
        query = query.where(StockMovement.occurred_at < day_end(date_to))
    rows, total = paginate(db, query, page)  # type: ignore[arg-type]
    return [_movement_out(r) for r in rows], total


def movements_out(db: Session, movements: list[StockMovement]) -> list[MovementOut]:
    """Salida de movimientos recién creados, conservando su orden."""
    if not movements:
        return []
    ids = [m.id for m in movements]
    rows = db.exec(_movement_query().where(col(StockMovement.id).in_(ids))).all()
    by_id = {r[0].id: _movement_out(r) for r in rows}
    return [by_id[i] for i in ids]


def _receipt_query():
    return (
        select(RawMaterialReceipt, Item.code, Item.name, Silo.code, Silo.name, User.full_name)
        .join(Item, Item.id == RawMaterialReceipt.item_id)
        .join(Silo, Silo.id == RawMaterialReceipt.silo_id)
        .outerjoin(User, User.id == RawMaterialReceipt.user_id)
    )


def _receipt_out(row) -> ReceiptOut:
    receipt, item_code, item_name, silo_code, silo_name, user_name = row
    return ReceiptOut(
        **receipt.model_dump(),
        item_code=item_code,
        item_name=item_name,
        silo_code=silo_code,
        silo_name=silo_name,
        user_name=user_name,
    )


def list_receipts(db: Session, page: PageParams) -> tuple[list[ReceiptOut], int]:
    query = _receipt_query().order_by(
        col(RawMaterialReceipt.received_at).desc(), col(RawMaterialReceipt.number).desc()
    )
    rows, total = paginate(db, query, page)  # type: ignore[arg-type]
    return [_receipt_out(r) for r in rows], total


def receipt_out(db: Session, receipt_id: UUID) -> ReceiptOut:
    row = db.exec(_receipt_query().where(RawMaterialReceipt.id == receipt_id)).one()
    return _receipt_out(row)
