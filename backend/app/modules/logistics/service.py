"""Logística: alcance de las acciones, validación y reparto de las cargas, transiciones de
estado, pesada (salida de stock y albaranes), entregas, consultas y PDF.

Las rutas solo orquestan: aquí se decide qué acciones admite cada carga
(`allowed_actions`) con la misma función que las autoriza, para que la ficha y las
acciones nunca discrepen.
"""

import logging
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from uuid import UUID

from sqlalchemy import exists, func, or_
from sqlalchemy.dialects.postgresql import aggregate_order_by
from sqlalchemy.orm import aliased
from sqlmodel import Session, col, delete, select

from app.core.deps import CurrentUser
from app.core.errors import AppError, bad_request, forbidden, not_found
from app.core.pagination import PageParams, paginate
from app.core.security import utcnow
from app.core.sequence import next_number
from app.modules import documents
from app.modules.documents.types import (
    CompanyInfo,
    DeliveryNoteData,
    DocLine,
    LoadingOrderData,
    LoadingOrderStop,
    PartyInfo,
    TransportInfo,
)
from app.modules.logistics.models import Load, LoadItem, LoadStatus, LoadStop
from app.modules.logistics.schemas import (
    DeliverIn,
    LoadAction,
    LoadDetail,
    LoadIn,
    LoadItemOut,
    LoadStopOut,
    LoadSummary,
    PendingOrder,
    PendingOrderLine,
    WeighIn,
)
from app.modules.masters.models import Carrier, Customer, Driver, Farm, Item, Silo, Truck
from app.modules.notifications.service import notify
from app.modules.orders import service as orders
from app.modules.orders.models import Order, OrderLine, OrderStatus
from app.modules.stock import service as stock
from app.modules.stock.models import MovementKind
from app.modules.tenants.models import Tenant
from app.modules.users.models import RolePermission, User, UserRole

logger = logging.getLogger("konygest.logistics")

ZERO = Decimal(0)
PENDING_DAYS = 7
SOURCE_TYPE = "truck_load"

STATUS_LABELS = {
    LoadStatus.PLANNED: "planificada",
    LoadStatus.READY: "lista para cargar",
    LoadStatus.LOADED: "cargada",
    LoadStatus.DELIVERED: "entregada",
    LoadStatus.CANCELLED: "cancelada",
}
# Una carga cancelada conserva sus paradas como histórico, pero ya no retiene pedidos
ACTIVE_STATUSES = (LoadStatus.PLANNED, LoadStatus.READY, LoadStatus.LOADED, LoadStatus.DELIVERED)
CANCELLABLE = (LoadStatus.PLANNED, LoadStatus.READY)


# ─── Permisos y acciones ───────────────────────────


def allowed_actions(user: CurrentUser, load: Load) -> list[LoadAction]:
    """Acciones que el usuario puede hacer ya sobre la carga (tabla del contrato)."""
    planner = user.can("logistica.planificar")
    weigher = user.can("cargas.pesar")
    status = load.status
    actions: list[LoadAction] = []
    if status == LoadStatus.PLANNED and planner:
        actions += ["edit", "release"]
    if status == LoadStatus.READY and planner:
        actions.append("unrelease")
    if status == LoadStatus.READY and weigher:
        actions.append("load")
    if status == LoadStatus.LOADED and (planner or weigher):
        actions.append("deliver")
    if status in CANCELLABLE and planner:
        actions.append("cancel")
    return actions


def _invalid_status(load: Load) -> AppError:
    return AppError(
        409,
        "INVALID_STATUS",
        f"La carga {load.number} está {STATUS_LABELS[load.status]}; no se puede hacer esta acción.",
    )


def ensure_action(
    user: CurrentUser, load: Load, action: LoadAction, statuses: tuple[LoadStatus, ...]
) -> None:
    """409 si la acción no existe desde el estado actual; 403 si existe pero no para él."""
    if load.status not in statuses:
        raise _invalid_status(load)
    if action not in allowed_actions(user, load):
        raise forbidden()


def get_for_update(db: Session, load_id: UUID) -> Load:
    """Carga bloqueando su fila: dos pesadas o ediciones simultáneas no deben pasar ambas.

    Con RLS, una carga de otra empresa simplemente no existe (404).
    """
    load = db.exec(select(Load).where(Load.id == load_id).with_for_update()).first()
    if load is None:
        raise not_found("No se encuentra la carga.")
    return load


def get_load(db: Session, load_id: UUID) -> Load:
    load = db.get(Load, load_id)
    if load is None:
        raise not_found("No se encuentra la carga.")
    return load


def get_stop(db: Session, load: Load, stop_id: UUID) -> LoadStop:
    stop = db.get(LoadStop, stop_id)
    if stop is None or stop.load_id != load.id:
        raise not_found("No se encuentra la parada.")
    return stop


# ─── Alta y edición ────────────────────────────────


@dataclass
class PlanLine:
    """Línea de pedido con lo necesario para repartirla y explicar los errores."""

    line: OrderLine
    order: Order
    item_code: str


def _fmt(value: Decimal) -> str:
    """1234.5 → "1.234,50" (formato es-ES) para mensajes y avisos."""
    return f"{value:,.2f}".replace(",", "_").replace(".", ",").replace("_", ".")


def _capacities(truck: Truck) -> list[Decimal]:
    # El JSON guarda float; se pasa por str para no arrastrar errores binarios (8000.1)
    return [Decimal(str(c)) for c in truck.compartments]


def auto_assign(
    lines: list[PlanLine], capacities: list[Decimal]
) -> list[tuple[PlanLine, int, Decimal]]:
    """Reparte las líneas en los compartimentos, en orden: [(línea, compartimento, kg)].

    Las líneas llegan ya ordenadas por orden de descarga y posición. Se llenan los
    compartimentos uno tras otro y un compartimento nunca lleva dos líneas (no se
    mezclan piensos ni clientes en la misma boca); por eso, si a una línea le sobra
    sitio en su último compartimento, ese hueco se pierde y la siguiente empieza en
    uno nuevo, y si no cabe en uno, ocupa ese entero y sigue en el siguiente. Seguir
    el orden de descarga además deja juntos los compartimentos de cada parada, que es
    como el conductor descarga.

    Raises:
        AppError 409 LOAD_DOES_NOT_FIT: si se acaban los compartimentos, con los kg
            que se quedan fuera.
    """
    total = sum((ln.line.quantity_kg for ln in lines), ZERO)
    assigned = ZERO
    result: list[tuple[PlanLine, int, Decimal]] = []
    usable = [(index, cap) for index, cap in enumerate(capacities, start=1) if cap > 0]
    slots = iter(usable)
    for ln in lines:
        left = ln.line.quantity_kg
        while left > 0:
            slot = next(slots, None)
            if slot is None:
                raise AppError(
                    409,
                    "LOAD_DOES_NOT_FIT",
                    f"La carga no cabe en el camión: faltan {_fmt(total - assigned)} kg "
                    "por repartir (cada compartimento lleva una sola línea).",
                )
            compartment, cap = slot
            kg = min(left, cap)
            result.append((ln, compartment, kg))
            left -= kg
            assigned += kg
    return result


def _check_manual(
    data: LoadIn, lines: list[PlanLine], capacities: list[Decimal]
) -> list[tuple[PlanLine, int, Decimal]]:
    """Valida el reparto enviado por el planificador (reglas del contrato)."""
    by_id = {ln.line.id: ln for ln in lines}
    used: set[int] = set()
    per_line: dict[UUID, Decimal] = defaultdict(Decimal)
    result: list[tuple[PlanLine, int, Decimal]] = []
    for index, item in enumerate(data.items):
        field = f"items.{index}"
        ln = by_id.get(item.order_line_id)
        if ln is None:
            raise bad_request(
                "INVALID_REFERENCE",
                "La línea no pertenece a ningún pedido de la carga.",
                f"{field}.order_line_id",
            )
        if item.compartment > len(capacities):
            raise bad_request(
                "VALIDATION_ERROR",
                f"El camión solo tiene {len(capacities)} compartimentos.",
                f"{field}.compartment",
            )
        if item.compartment in used:
            raise bad_request(
                "VALIDATION_ERROR",
                "Un compartimento lleva una sola línea de pedido.",
                f"{field}.compartment",
            )
        used.add(item.compartment)
        cap = capacities[item.compartment - 1]
        if item.planned_kg > cap:
            raise AppError(
                409,
                "COMPARTMENT_OVERFLOW",
                f"El compartimento {item.compartment} admite {_fmt(cap)} kg y se le asignan "
                f"{_fmt(item.planned_kg)} kg.",
                field,
            )
        per_line[ln.line.id] += item.planned_kg
        result.append((ln, item.compartment, item.planned_kg))
    for ln in lines:
        # Los pedidos no se parten entre cargas: cada línea va entera en esta
        if per_line[ln.line.id] != ln.line.quantity_kg:
            raise bad_request(
                "VALIDATION_ERROR",
                f"La línea {ln.item_code} del pedido {ln.order.number} pide "
                f"{_fmt(ln.line.quantity_kg)} kg y se reparten {_fmt(per_line[ln.line.id])} kg.",
                "items",
            )
    return result


def apply_data(db: Session, user: CurrentUser, load: Load, data: LoadIn) -> None:
    """Valida la entrada y deja la carga con sus paradas, su reparto y el estado de sus
    pedidos al día (sin commit). Sirve para el alta y para la edición."""
    if data.load_date < orders.today_madrid():
        raise bad_request(
            "VALIDATION_ERROR", "La fecha de carga no puede ser anterior a hoy.", "load_date"
        )
    truck = db.get(Truck, data.truck_id)
    if truck is None or not truck.is_active:
        raise bad_request("INVALID_REFERENCE", "El camión no existe o está de baja.", "truck_id")
    if data.driver_id is not None:
        driver = db.get(Driver, data.driver_id)
        if driver is None or not driver.is_active:
            raise bad_request(
                "INVALID_REFERENCE", "El conductor no existe o está de baja.", "driver_id"
            )

    sequences = sorted(s.sequence for s in data.stops)
    if sequences != list(range(1, len(data.stops) + 1)):
        raise bad_request(
            "VALIDATION_ERROR", "El orden de descarga debe ir de 1 a N sin repetir.", "stops"
        )
    order_ids = [s.order_id for s in data.stops]
    if len(set(order_ids)) != len(order_ids):
        raise bad_request("VALIDATION_ERROR", "Un pedido no puede ir dos veces.", "stops")

    current_ids = set(db.exec(select(LoadStop.order_id).where(LoadStop.load_id == load.id)).all())
    # Se bloquean los pedidos que entran y los que salen: otra carga simultánea o una
    # cancelación desde pedidos no deben cruzarse con este cambio de estado
    locked = {
        o.id: o
        for o in db.exec(
            select(Order)
            .where(col(Order.id).in_(set(order_ids) | current_ids))
            .order_by(col(Order.id))
            .with_for_update()
        ).all()
    }
    busy = set(
        db.exec(
            select(LoadStop.order_id)
            .join(Load, Load.id == LoadStop.load_id)
            .where(
                col(LoadStop.order_id).in_(order_ids),
                Load.id != load.id,
                col(Load.status).in_(ACTIVE_STATUSES),
            )
        ).all()
    )
    for index, stop in enumerate(data.stops):
        field = f"stops.{index}.order_id"
        order = locked.get(stop.order_id)
        if order is None:
            raise bad_request("INVALID_REFERENCE", "El pedido no existe.", field)
        in_this = order.id in current_ids and order.status == OrderStatus.PLANNED
        if order.id in busy or not (order.status == OrderStatus.CONFIRMED or in_this):
            reason = (
                "ya está en otra carga"
                if order.id in busy
                else f"está {orders.STATUS_LABELS[order.status]}"
            )
            raise AppError(
                409,
                "ORDER_NOT_PLANNABLE",
                f"El pedido {order.number} {reason}; solo se planifican pedidos confirmados.",
                field,
            )

    sequence_of = {s.order_id: s.sequence for s in data.stops}
    rows = db.exec(
        select(OrderLine, Item.code)
        .join(Item, Item.id == OrderLine.item_id)
        .where(col(OrderLine.order_id).in_(order_ids))
    ).all()
    lines = sorted(
        (PlanLine(line, locked[line.order_id], code) for line, code in rows),
        key=lambda ln: (sequence_of[ln.order.id], ln.line.position),
    )
    capacities = _capacities(truck)
    assignment = (
        _check_manual(data, lines, capacities) if data.items else auto_assign(lines, capacities)
    )

    # Se reemplazan paradas y reparto: el PUT trae la carga completa
    db.exec(delete(LoadItem).where(col(LoadItem.load_id) == load.id))
    db.exec(delete(LoadStop).where(col(LoadStop.load_id) == load.id))
    stops = {
        s.order_id: LoadStop(
            tenant_id=load.tenant_id, load_id=load.id, order_id=s.order_id, sequence=s.sequence
        )
        for s in data.stops
    }
    db.add_all(stops.values())
    db.flush()
    db.add_all(
        LoadItem(
            tenant_id=load.tenant_id,
            load_id=load.id,
            stop_id=stops[ln.order.id].id,
            order_line_id=ln.line.id,
            compartment=compartment,
            planned_kg=kg,
        )
        for ln, compartment, kg in sorted(assignment, key=lambda a: a[1])
    )

    now = utcnow()
    for order_id in current_ids - set(order_ids):
        _set_order_status(db, locked[order_id], OrderStatus.CONFIRMED, now)
    for order_id in order_ids:
        _set_order_status(db, locked[order_id], OrderStatus.PLANNED, now)

    load.load_date = data.load_date
    load.truck_id = truck.id
    load.driver_id = data.driver_id
    load.notes = data.notes
    load.updated_at = now
    db.add(load)


def _set_order_status(db: Session, order: Order, status: OrderStatus, now: datetime) -> None:
    if order.status != status:
        order.status = status
        order.updated_at = now
        db.add(order)


def _load_orders(db: Session, load: Load, lock: bool = True) -> list[Order]:
    query = (
        select(Order)
        .join(LoadStop, LoadStop.order_id == Order.id)
        .where(LoadStop.load_id == load.id)
        .order_by(col(LoadStop.sequence))
    )
    if lock:
        query = query.with_for_update(of=Order)  # type: ignore[arg-type]
    return list(db.exec(query).all())


# ─── Avisos ────────────────────────────────────────


def _users_with(db: Session, permission: str) -> set[UUID]:
    return set(
        db.exec(
            select(UserRole.user_id)
            .join(RolePermission, RolePermission.role_id == UserRole.role_id)
            .join(User, User.id == UserRole.user_id)
            .where(RolePermission.permission == permission, User.is_active)
            .distinct()
        ).all()
    )


def _link(load: Load) -> str:
    return f"/logistica/cargas/{load.id}"


def _planned_kg(db: Session, load: Load) -> Decimal:
    total = db.exec(
        select(func.coalesce(func.sum(LoadItem.planned_kg), ZERO)).where(
            LoadItem.load_id == load.id
        )
    ).one()
    return Decimal(total)


# ─── Transiciones ──────────────────────────────────


def release(db: Session, user: CurrentUser, load: Load) -> None:
    now = utcnow()
    load.status = LoadStatus.READY
    load.released_at = load.updated_at = now
    db.add(load)
    recipients = sorted(_users_with(db, "cargas.pesar") - {user.id})
    if recipients:
        truck = db.get(Truck, load.truck_id)
        stop_count = db.exec(
            select(func.count()).select_from(LoadStop).where(LoadStop.load_id == load.id)
        ).one()
        notify(
            db,
            load.tenant_id,
            recipients,
            "carga_lista",
            f"Carga {load.number} lista para cargar",
            f"{truck.plate if truck else ''} · {load.load_date:%d/%m/%Y} · {stop_count} "
            f"parada(s) · {_fmt(_planned_kg(db, load))} kg.",
            _link(load),
        )


def unrelease(db: Session, load: Load) -> None:
    load.status = LoadStatus.PLANNED
    load.released_at = None
    load.updated_at = utcnow()
    db.add(load)


def cancel(db: Session, load: Load, reason: str) -> None:
    now = utcnow()
    for order in _load_orders(db, load):
        _set_order_status(db, order, OrderStatus.CONFIRMED, now)
    load.status = LoadStatus.CANCELLED
    load.status_reason = reason
    load.updated_at = now
    db.add(load)


def weigh(db: Session, user: CurrentUser, load: Load, data: WeighIn) -> None:
    """Registra la pesada real (sin commit): salida de stock, albaranes, estados y avisos.

    Todo va en la transacción de la petición: si un silo no tiene stock suficiente
    (409 INSUFFICIENT_STOCK) la excepción deshace movimientos, números de albarán y
    estados, y no queda nada a medias.
    """
    if data.gross_kg is not None and data.tare_kg is not None and data.gross_kg <= data.tare_kg:
        raise bad_request("VALIDATION_ERROR", "El bruto debe ser mayor que la tara.", "gross_kg")
    items = list(
        db.exec(
            select(LoadItem).where(LoadItem.load_id == load.id).order_by(col(LoadItem.compartment))
        ).all()
    )
    given = [i.item_id for i in data.items]
    if len(set(given)) != len(given) or set(given) != {i.id for i in items}:
        raise bad_request(
            "VALIDATION_ERROR",
            "Indica la pesada de cada compartimento de la carga, una sola vez.",
            "items",
        )
    by_id = {i.id: i for i in items}
    lines = {
        line.id: (line, item)
        for line, item in db.exec(
            select(OrderLine, Item)
            .join(Item, Item.id == OrderLine.item_id)
            .join(LoadItem, LoadItem.order_line_id == OrderLine.id)
            .where(LoadItem.load_id == load.id)
        ).all()
    }
    orders_by_stop = {
        stop.id: order
        for stop, order in db.exec(
            select(LoadStop, Order)
            .join(Order, Order.id == LoadStop.order_id)
            .where(LoadStop.load_id == load.id)
        ).all()
    }
    now = utcnow()
    for index, row in enumerate(data.items):
        load_item = by_id[row.item_id]
        silo = stock.get_silo(db, row.silo_id, f"items.{index}.silo_id")
        _line, item = lines[load_item.order_line_id]
        order = orders_by_stop[load_item.stop_id]
        movement = stock.record_movement(
            db,
            user,
            item,
            silo,
            MovementKind.LOAD_OUT,
            -row.actual_kg,
            source_type=SOURCE_TYPE,
            source_id=load.id,
            notes=f"Carga {load.number} · pedido {order.number} · compartimento "
            f"{load_item.compartment}",
            lot=row.lot or None,
            occurred_at=now,
        )
        load_item.actual_kg = row.actual_kg
        load_item.silo_id = silo.id
        load_item.lot = row.lot or None
        load_item.stock_movement_id = movement.id
        db.add(load_item)

    stops = list(
        db.exec(
            select(LoadStop).where(LoadStop.load_id == load.id).order_by(col(LoadStop.sequence))
        ).all()
    )
    year = orders.today_madrid().year
    for stop in stops:
        stop.delivery_note_number = next_number(db, load.tenant_id, "ALB", year)
        db.add(stop)
    load.status = LoadStatus.LOADED
    load.gross_kg = data.gross_kg
    load.tare_kg = data.tare_kg
    load.loaded_at = load.updated_at = now
    load.loaded_by = user.id
    db.add(load)
    for order in _load_orders(db, load):
        _set_order_status(db, order, OrderStatus.LOADED, now)
    db.flush()

    # Albaranes: si el servidor no puede generar PDF no se bloquea la salida del
    # camión; quedan pendientes y se generan cuando alguien los pida
    # (si falla el destino de la empresa, `documents.store` lo guarda en Konygest y avisa)
    for stop in stops:
        try:
            with db.begin_nested():
                _store_delivery_note(db, load, stop)
        except documents.PdfUnavailableError:
            logger.warning("Albaranes de %s pendientes: PDF no disponible", load.number)
            break
        except Exception:
            # Ni siquiera el almacenamiento de Konygest: tampoco impide registrar la carga
            logger.exception("No se ha podido guardar el albarán de %s", load.number)
            break

    _notify_loaded(db, user, load, list(orders_by_stop.values()))


def _notify_loaded(db: Session, user: CurrentUser, load: Load, load_orders: list[Order]) -> None:
    """Planificación recibe el aviso de la carga; cada comercial, el de su pedido, con
    enlace al pedido porque el comercial no tiene acceso a logística."""
    planners = _users_with(db, "logistica.planificar") - {user.id}
    truck = db.get(Truck, load.truck_id)
    plate = truck.plate if truck else ""
    if planners:
        notify(
            db,
            load.tenant_id,
            sorted(planners),
            "carga_cargada",
            f"Carga {load.number} cargada",
            f"{plate} sale con {_fmt(_actual_kg(db, load))} kg y {len(load_orders)} parada(s).",
            _link(load),
        )
    for order in load_orders:
        rep = order.sales_rep_id
        if rep is None or rep == user.id or rep in planners:
            continue
        notify(
            db,
            load.tenant_id,
            [rep],
            "carga_cargada",
            f"Pedido {order.number} cargado",
            f"Sale en el camión {plate} (carga {load.number}).",
            f"/pedidos/{order.id}",
        )


def _actual_kg(db: Session, load: Load) -> Decimal:
    total = db.exec(
        select(func.coalesce(func.sum(LoadItem.actual_kg), ZERO)).where(LoadItem.load_id == load.id)
    ).one()
    return Decimal(total)


def deliver(db: Session, user: CurrentUser, load: Load, stop: LoadStop, data: DeliverIn) -> Order:
    """Confirma la entrega de una parada; la carga se cierra con la última."""
    if stop.delivered_at is not None:
        raise AppError(409, "INVALID_STATUS", "Esa parada ya está entregada.")
    now = utcnow()
    stop.delivered_at = stock.as_utc(data.delivered_at) if data.delivered_at else now
    stop.received_by = data.received_by
    stop.delivery_notes = data.notes
    stop.confirmed_by = user.id
    db.add(stop)
    order = db.exec(select(Order).where(Order.id == stop.order_id).with_for_update()).one()
    _set_order_status(db, order, OrderStatus.DELIVERED, now)
    db.flush()
    pending = db.exec(
        select(func.count())
        .select_from(LoadStop)
        .where(LoadStop.load_id == load.id, col(LoadStop.delivered_at).is_(None))
    ).one()
    if pending == 0:
        load.status = LoadStatus.DELIVERED
        load.delivered_at = now
    load.updated_at = now
    db.add(load)
    if order.sales_rep_id and order.sales_rep_id != user.id:
        customer = db.get(Customer, order.customer_id)
        body = f"{customer.name if customer else ''} · {stop.delivered_at:%d/%m/%Y %H:%M} UTC."
        if data.received_by:
            body += f" Recibe: {data.received_by}."
        notify(
            db,
            load.tenant_id,
            [order.sales_rep_id],
            "pedido_entregado",
            f"Pedido {order.number} entregado",
            body,
            f"/pedidos/{order.id}",
        )
    return order


# ─── Consultas ─────────────────────────────────────

LoadedBy = aliased(User, name="loaded_by_user")
CreatedBy = aliased(User, name="created_by_user")


def _stop_stats():
    """Nº de paradas y clientes en orden de descarga, por carga (una sola consulta)."""
    return (
        select(
            LoadStop.load_id,
            func.count().label("stop_count"),
            func.array_agg(aggregate_order_by(Customer.name, col(LoadStop.sequence))).label(
                "customers"
            ),
        )
        .join(Order, Order.id == LoadStop.order_id)
        .join(Customer, Customer.id == Order.customer_id)
        .group_by(LoadStop.load_id)
        .subquery()
    )


def _item_stats():
    return (
        select(LoadItem.load_id, func.sum(LoadItem.planned_kg).label("planned_kg"))
        .group_by(LoadItem.load_id)
        .subquery()
    )


def _query(detail: bool = False):
    stops = _stop_stats()
    items = _item_stats()
    columns = [
        Load,
        Truck.plate,
        Truck.compartments,
        Carrier.name,
        Driver.full_name,
        func.coalesce(items.c.planned_kg, ZERO),
        func.coalesce(stops.c.stop_count, 0),
        stops.c.customers,
    ]
    if detail:
        columns += [LoadedBy.full_name, CreatedBy.full_name]
    query = (
        select(*columns)
        .join(Truck, Truck.id == Load.truck_id)
        .outerjoin(Carrier, Carrier.id == Truck.carrier_id)
        .outerjoin(Driver, Driver.id == Load.driver_id)
        .outerjoin(stops, stops.c.load_id == Load.id)
        .outerjoin(items, items.c.load_id == Load.id)
    )
    if detail:
        query = query.outerjoin(LoadedBy, LoadedBy.id == Load.loaded_by).outerjoin(
            CreatedBy, CreatedBy.id == Load.created_by
        )
    return query


def _summary_fields(row) -> dict:
    load, plate, compartments, carrier, driver, planned, stop_count, customers = row[:8]
    return {
        **load.model_dump(),
        "truck_plate": plate,
        "carrier_name": carrier,
        "driver_name": driver,
        "capacity_kg": sum((Decimal(str(c)) for c in compartments or []), ZERO),
        "planned_kg": planned,
        "stop_count": stop_count,
        "customers": list(customers or []),
    }


def parse_statuses(value: str | None) -> list[LoadStatus]:
    if not value:
        return []
    try:
        return [LoadStatus(s.strip()) for s in value.split(",") if s.strip()]
    except ValueError as exc:
        raise bad_request("VALIDATION_ERROR", "Estado de carga no válido.", "status") from exc


def list_loads(
    db: Session,
    page: PageParams,
    on_date: date | None,
    date_from: date | None,
    date_to: date | None,
    statuses: list[LoadStatus],
    truck_id: UUID | None,
) -> tuple[list[LoadSummary], int]:
    query = _query().order_by(col(Load.load_date).desc(), col(Load.number).desc())
    if on_date:
        query = query.where(Load.load_date == on_date)
    if date_from:
        query = query.where(Load.load_date >= date_from)
    if date_to:
        query = query.where(Load.load_date <= date_to)
    if statuses:
        query = query.where(col(Load.status).in_(statuses))
    if truck_id:
        query = query.where(Load.truck_id == truck_id)
    rows, total = paginate(db, query, page)  # type: ignore[arg-type]
    return [LoadSummary.model_validate(_summary_fields(r)) for r in rows], total


def load_detail(db: Session, user: CurrentUser, load_id: UUID) -> LoadDetail:
    row = db.exec(_query(detail=True).where(Load.id == load_id)).first()
    if row is None:
        raise not_found("No se encuentra la carga.")
    load: Load = row[0]
    stops = db.exec(
        select(LoadStop, Order, Customer.name, Farm)
        .join(Order, Order.id == LoadStop.order_id)
        .join(Customer, Customer.id == Order.customer_id)
        .join(Farm, Farm.id == Order.farm_id)
        .where(LoadStop.load_id == load.id)
        .order_by(col(LoadStop.sequence))
    ).all()
    ready_notes = documents.stored_numbers(
        db,
        load.tenant_id,
        DELIVERY_NOTE,
        [s.delivery_note_number for s, *_ in stops if s.delivery_note_number],
    )
    items = db.exec(
        select(LoadItem, OrderLine, Item.code, Item.name, Silo.name)
        .join(OrderLine, OrderLine.id == LoadItem.order_line_id)
        .join(Item, Item.id == OrderLine.item_id)
        .outerjoin(Silo, Silo.id == LoadItem.silo_id)
        .where(LoadItem.load_id == load.id)
        .order_by(col(LoadItem.compartment))
    ).all()
    return LoadDetail.model_validate(
        {
            **_summary_fields(row),
            "loaded_by_name": row[8],
            "created_by_name": row[9],
            "allowed_actions": allowed_actions(user, load),
            "compartments": [float(c) for c in row[2] or []],
            "stops": [
                LoadStopOut(
                    id=stop.id,
                    sequence=stop.sequence,
                    order_id=order.id,
                    order_number=order.number,
                    order_status=order.status,
                    customer_name=customer_name,
                    farm_name=farm.name,
                    farm_rega=farm.rega_code,
                    farm_city=farm.city,
                    requested_date=order.requested_date,
                    total_kg=order.total_kg,
                    delivery_note_number=stop.delivery_note_number,
                    delivery_note_ready=stop.delivery_note_number in ready_notes,
                    delivered_at=stop.delivered_at,
                    received_by=stop.received_by,
                    delivery_notes=stop.delivery_notes,
                )
                for stop, order, customer_name, farm in stops
            ],
            "items": [
                LoadItemOut(
                    id=li.id,
                    stop_id=li.stop_id,
                    order_line_id=li.order_line_id,
                    compartment=li.compartment,
                    item_id=line.item_id,
                    item_code=code,
                    item_name=name,
                    farm_silo=line.farm_silo,
                    planned_kg=li.planned_kg,
                    actual_kg=li.actual_kg,
                    silo_id=li.silo_id,
                    silo_name=silo_name,
                    lot=li.lot,
                )
                for li, line, code, name, silo_name in items
            ],
        }
    )


def pending_orders(
    db: Session, page: PageParams, date_to: date | None, search: str | None
) -> tuple[list[PendingOrder], int]:
    """Pedidos confirmados que aún no van en ninguna carga activa."""
    limit = date_to or orders.today_madrid() + timedelta(days=PENDING_DAYS)
    in_load = exists().where(
        LoadStop.order_id == Order.id,
        LoadStop.load_id == Load.id,
        col(Load.status).in_(ACTIVE_STATUSES),
    )
    # Mismas columnas que el listado de pedidos (fase 2) más la población de la explotación
    query = (
        orders.list_query()
        .add_columns(Farm.city)
        .where(Order.status == OrderStatus.CONFIRMED, Order.requested_date <= limit, ~in_load)
        .order_by(col(Order.requested_date), col(Order.number))
    )
    if search and search.strip():
        pattern = f"%{search.strip()}%"
        query = query.where(
            or_(
                col(Order.number).ilike(pattern),
                col(Customer.name).ilike(pattern),
                col(Customer.code).ilike(pattern),
            )
        )
    rows, total = paginate(db, query, page)  # type: ignore[arg-type]
    ids = [r[0].id for r in rows]
    lines: dict[UUID, list[PendingOrderLine]] = defaultdict(list)
    if ids:
        for line, code, name in db.exec(
            select(OrderLine, Item.code, Item.name)
            .join(Item, Item.id == OrderLine.item_id)
            .where(col(OrderLine.order_id).in_(ids))
            .order_by(col(OrderLine.position))
        ).all():
            lines[line.order_id].append(
                PendingOrderLine(
                    id=line.id,
                    item_id=line.item_id,
                    item_code=code,
                    item_name=name,
                    quantity_kg=line.quantity_kg,
                    farm_silo=line.farm_silo,
                )
            )
    return [
        PendingOrder.model_validate(
            {**orders.summary_fields(r), "farm_city": r[8] or "", "lines": lines[r[0].id]}
        )
        for r in rows
    ], total


# ─── PDF ───────────────────────────────────────────


class PdfUnavailable(AppError):
    def __init__(self) -> None:
        super().__init__(
            503, "PDF_UNAVAILABLE", "Ahora mismo no se pueden generar PDF; inténtalo más tarde."
        )


def _company(db: Session, tenant_id: UUID) -> CompanyInfo:
    tenant = db.get(Tenant, tenant_id)
    assert tenant is not None
    return CompanyInfo(name=tenant.name, tax_id=tenant.tax_id)


def _transport(db: Session, load: Load) -> TransportInfo:
    truck = db.get(Truck, load.truck_id)
    assert truck is not None  # FK RESTRICT
    carrier = db.get(Carrier, truck.carrier_id) if truck.carrier_id else None
    driver = db.get(Driver, load.driver_id) if load.driver_id else None
    return TransportInfo(
        truck_plate=truck.plate,
        carrier_name=carrier.name if carrier else None,
        driver_name=driver.full_name if driver else None,
    )


def _party(customer: Customer, farm: Farm) -> PartyInfo:
    address = ", ".join(
        p for p in (farm.address, f"{farm.postal_code} {farm.city}".strip(), farm.province) if p
    )
    return PartyInfo(
        customer_code=customer.code,
        customer_name=customer.name,
        customer_tax_id=customer.tax_id,
        farm_name=farm.name,
        farm_rega=farm.rega_code,
        farm_address=address,
    )


def _stop_rows(db: Session, load: Load, stop_id: UUID | None = None):
    query = (
        select(LoadStop, Order, Customer, Farm)
        .join(Order, Order.id == LoadStop.order_id)
        .join(Customer, Customer.id == Order.customer_id)
        .join(Farm, Farm.id == Order.farm_id)
        .where(LoadStop.load_id == load.id)
        .order_by(col(LoadStop.sequence))
    )
    if stop_id:
        query = query.where(LoadStop.id == stop_id)
    return db.exec(query).all()


def _doc_lines(db: Session, load: Load, actual: bool) -> dict[UUID, list[DocLine]]:
    """Líneas por parada, por compartimento: previstas (orden de carga) o reales (albarán)."""
    rows = db.exec(
        select(LoadItem, OrderLine.farm_silo, Item.code, Item.name, Silo.name)
        .join(OrderLine, OrderLine.id == LoadItem.order_line_id)
        .join(Item, Item.id == OrderLine.item_id)
        .outerjoin(Silo, Silo.id == LoadItem.silo_id)
        .where(LoadItem.load_id == load.id)
        .order_by(col(LoadItem.compartment))
    ).all()
    result: dict[UUID, list[DocLine]] = defaultdict(list)
    for li, farm_silo, code, name, silo_name in rows:
        result[li.stop_id].append(
            DocLine(
                item_code=code,
                item_name=name,
                quantity_kg=(
                    li.actual_kg if actual and li.actual_kg is not None else li.planned_kg
                ),
                compartment=li.compartment,
                farm_silo=farm_silo,
                lot=li.lot,
                factory_silo=silo_name,
            )
        )
    return result


def loading_order_pdf(db: Session, load: Load) -> bytes:
    if load.status == LoadStatus.CANCELLED:
        raise _invalid_status(load)
    truck = db.get(Truck, load.truck_id)
    assert truck is not None
    lines = _doc_lines(db, load, actual=False)
    data = LoadingOrderData(
        company=_company(db, load.tenant_id),
        number=load.number,
        load_date=load.load_date,
        transport=_transport(db, load),
        compartments_kg=[float(c) for c in truck.compartments],
        stops=[
            LoadingOrderStop(
                sequence=stop.sequence,
                order_number=order.number,
                party=_party(customer, farm),
                lines=lines[stop.id],
            )
            for stop, order, customer, farm in _stop_rows(db, load)
        ],
        notes=load.notes,
    )
    try:
        return documents.render_loading_order(data)
    except documents.PdfUnavailableError as exc:
        raise PdfUnavailable() from exc


DELIVERY_NOTE = "delivery_note"


def _render_delivery_note(db: Session, load: Load, stop: LoadStop) -> bytes:
    """Albarán de una parada con lo realmente cargado.

    Raises:
        documents.PdfUnavailableError: si no se puede generar el PDF.
    """
    assert stop.delivery_note_number is not None
    _stop, order, customer, farm = _stop_rows(db, load, stop.id)[0]
    data = DeliveryNoteData(
        company=_company(db, load.tenant_id),
        number=stop.delivery_note_number,
        issued_at=load.loaded_at or utcnow(),
        load_number=load.number,
        order_number=order.number,
        party=_party(customer, farm),
        transport=_transport(db, load),
        lines=_doc_lines(db, load, actual=True)[stop.id],
        gross_kg=load.gross_kg,
        tare_kg=load.tare_kg,
        notes=order.notes,
    )
    return documents.render_delivery_note(data)


def _store_delivery_note(db: Session, load: Load, stop: LoadStop) -> None:
    assert stop.delivery_note_number is not None
    documents.store(
        db,
        load.tenant_id,
        DELIVERY_NOTE,
        stop.delivery_note_number,
        _render_delivery_note(db, load, stop),
        "application/pdf",
        "load_stop",
        stop.id,
    )


def delivery_note_pdf(db: Session, load: Load, stop: LoadStop) -> bytes:
    """PDF del albarán: el guardado o, si quedó pendiente, falta en el destino o el destino
    no responde, se genera ahora con los datos de la carga y se vuelve a guardar.

    Quien llama hace commit (puede haberse registrado o regenerado el documento).
    """
    if stop.delivery_note_number is None:
        raise not_found("El albarán aún no existe: se emite al registrar la carga.")
    try:
        return documents.fetch(
            db,
            load.tenant_id,
            DELIVERY_NOTE,
            stop.delivery_note_number,
            lambda: _render_delivery_note(db, load, stop),
            source_type="load_stop",
            source_id=stop.id,
        )
    except documents.PdfUnavailableError as exc:
        raise PdfUnavailable() from exc
