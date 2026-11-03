"""Rutas de órdenes de fabricación."""

from datetime import date
from uuid import UUID

from fastapi import APIRouter, Depends

from app.core.deps import CurrentUser, TenantDbDep, require_module, require_permission
from app.core.pagination import Page, PageDep
from app.core.security import utcnow
from app.core.sequence import next_number
from app.modules.platform.audit import audit
from app.modules.production import service
from app.modules.production.models import ProductionOrder, ProductionStatus
from app.modules.production.schemas import FinishIn, OrderIn, OrderOut

router = APIRouter(
    prefix="/production",
    tags=["Fabricación"],
    dependencies=[Depends(require_module("fabrica"))],
)

View = Depends(require_permission("fabricacion.ver"))
Manage = Depends(require_permission("fabricacion.gestionar"))


@router.get(
    "/orders",
    summary="Órdenes de fabricación",
    description="Ordenadas por fecha prevista, la más reciente primero.",
    response_model=Page[OrderOut],
)
def list_orders(
    db: TenantDbDep,
    page: PageDep,
    status: ProductionStatus | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    item_id: UUID | None = None,
    _: CurrentUser = View,
) -> Page[OrderOut]:
    items, total = service.list_orders(db, page, status, date_from, date_to, item_id)
    return Page(items=items, total=total, offset=page.offset, limit=page.limit)


@router.get("/orders/{order_id}", summary="Ficha de una orden", response_model=OrderOut)
def get_order(order_id: UUID, db: TenantDbDep, _: CurrentUser = View) -> OrderOut:
    return service.order_out(db, order_id)


@router.post(
    "/orders",
    summary="Crear una orden de fabricación",
    description="Solo de piensos. Se numera OF-AAAA-NNNN según el año de la fecha prevista.",
    response_model=OrderOut,
    status_code=201,
)
def create_order(data: OrderIn, db: TenantDbDep, user: CurrentUser = Manage) -> OrderOut:
    order = ProductionOrder(
        tenant_id=user.tenant_id,  # type: ignore[arg-type]
        number="",
        item_id=data.item_id,
        silo_id=data.silo_id,
        planned_kg=data.planned_kg,
        planned_date=data.planned_date,
        created_by=user.id,
    )
    service.apply_data(db, order, data)
    # Se numera después de validar para no reservar números en peticiones erróneas
    order.number = next_number(db, user.tenant_id, "OF", data.planned_date.year)  # type: ignore[arg-type]
    db.add(order)
    db.flush()
    audit(
        db,
        "fabricacion.crear",
        user=user,
        entity="production_order",
        entity_id=order.id,
        data={"numero": order.number},
    )
    db.commit()
    return service.order_out(db, order.id)


@router.put(
    "/orders/{order_id}",
    summary="Editar una orden",
    description="Solo mientras está planificada.",
    response_model=OrderOut,
)
def update_order(
    order_id: UUID, data: OrderIn, db: TenantDbDep, user: CurrentUser = Manage
) -> OrderOut:
    order = service.get_for_update(db, order_id)
    service.ensure_status(order, ProductionStatus.PLANNED)
    service.apply_data(db, order, data)
    db.add(order)
    audit(
        db,
        "fabricacion.editar",
        user=user,
        entity="production_order",
        entity_id=order.id,
        data={"numero": order.number},
    )
    db.commit()
    return service.order_out(db, order.id)


@router.post("/orders/{order_id}/start", summary="Empezar una orden", response_model=OrderOut)
def start_order(order_id: UUID, db: TenantDbDep, user: CurrentUser = Manage) -> OrderOut:
    order = service.get_for_update(db, order_id)
    service.ensure_status(order, ProductionStatus.PLANNED)
    order.status = ProductionStatus.IN_PROGRESS
    order.started_at = utcnow()
    db.add(order)
    audit(
        db,
        "fabricacion.iniciar",
        user=user,
        entity="production_order",
        entity_id=order.id,
        data={"numero": order.number},
    )
    db.commit()
    return service.order_out(db, order.id)


@router.post(
    "/orders/{order_id}/finish",
    summary="Terminar una orden",
    description="Registra los kg fabricados y los da de alta en el stock del silo de descarga.",
    response_model=OrderOut,
)
def finish_order(
    order_id: UUID, data: FinishIn, db: TenantDbDep, user: CurrentUser = Manage
) -> OrderOut:
    order = service.get_for_update(db, order_id)
    service.finish(db, user, order, data.produced_kg, data.silo_id)
    audit(
        db,
        "fabricacion.terminar",
        user=user,
        entity="production_order",
        entity_id=order.id,
        data={"numero": order.number, "fabricado_kg": float(data.produced_kg)},
    )
    db.commit()
    return service.order_out(db, order.id)


@router.post("/orders/{order_id}/cancel", summary="Cancelar una orden", response_model=OrderOut)
def cancel_order(order_id: UUID, db: TenantDbDep, user: CurrentUser = Manage) -> OrderOut:
    order = service.get_for_update(db, order_id)
    service.ensure_status(order, ProductionStatus.PLANNED, ProductionStatus.IN_PROGRESS)
    order.status = ProductionStatus.CANCELLED
    db.add(order)
    audit(
        db,
        "fabricacion.cancelar",
        user=user,
        entity="production_order",
        entity_id=order.id,
        data={"numero": order.number},
    )
    db.commit()
    return service.order_out(db, order.id)
