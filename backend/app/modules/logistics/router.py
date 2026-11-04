"""Rutas de la logística: cargas, orden de carga, pesada y albaranes (docs/api-fase3.md)."""

from datetime import date
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlmodel import Session

from app.core.deps import (
    CurrentUser,
    TenantDbDep,
    TenantUserDep,
    require_module,
    require_permission,
)
from app.core.errors import forbidden
from app.core.pagination import Page, PageDep
from app.core.sequence import next_number
from app.modules.logistics import service
from app.modules.logistics.models import Load, LoadStatus
from app.modules.logistics.schemas import (
    DeliverIn,
    LoadDetail,
    LoadIn,
    LoadSummary,
    PendingOrder,
    WeighIn,
)
from app.modules.orders.schemas import ReasonIn
from app.modules.orders.service import today_madrid
from app.modules.platform.audit import audit

router = APIRouter(tags=["Logística"], dependencies=[Depends(require_module("logistica"))])

View = Depends(require_permission("logistica.ver"))
Plan = Depends(require_permission("logistica.planificar"))
Weigh = Depends(require_permission("cargas.pesar"))

_ERRORS = {
    400: {"description": "Datos no válidos: VALIDATION_ERROR, INVALID_REFERENCE"},
    403: {"description": "Sin permiso para esta acción"},
    404: {"description": "La carga no existe"},
    409: {"description": "INVALID_STATUS: no se puede desde el estado actual"},
}
_PDF = {
    200: {"content": {"application/pdf": {}}, "description": "PDF"},
    404: _ERRORS[404],
    503: {"description": "PDF_UNAVAILABLE: el servidor no puede generar PDF ahora"},
}
_PLAN_ERRORS = {
    **_ERRORS,
    409: {
        "description": "INVALID_STATUS, ORDER_NOT_PLANNABLE, LOAD_DOES_NOT_FIT o "
        "COMPARTMENT_OVERFLOW"
    },
}


def _audit(db: Session, action: str, user: CurrentUser, load: Load, **data) -> None:
    audit(
        db,
        action,
        user=user,
        entity="truck_load",
        entity_id=load.id,
        data={"numero": load.number, **data},
    )


def _pdf(content: bytes, filename: str) -> Response:
    return Response(
        content=content,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


@router.get(
    "/logistics/pending-orders",
    summary="Pedidos por planificar",
    description=(
        "Pedidos confirmados que no van en ninguna carga, con entrega hasta `date_to` "
        f"(por defecto hoy + {service.PENDING_DAYS} días), por fecha de entrega y número. "
        "`search` busca por número o por nombre/código de cliente."
    ),
    response_model=Page[PendingOrder],
)
def pending_orders(
    db: TenantDbDep,
    page: PageDep,
    date_to: date | None = None,
    search: str | None = None,
    _: CurrentUser = View,
) -> Page[PendingOrder]:
    items, total = service.pending_orders(db, page, date_to, search)
    return Page(items=items, total=total, offset=page.offset, limit=page.limit)


@router.get(
    "/loads",
    summary="Cargas",
    description=(
        "Por fecha de carga y número, de la más reciente a la más antigua. `status` admite "
        "varios separados por coma."
    ),
    response_model=Page[LoadSummary],
)
def list_loads(
    db: TenantDbDep,
    page: PageDep,
    on_date: date | None = Query(None, alias="date"),
    date_from: date | None = None,
    date_to: date | None = None,
    status: str | None = None,
    truck_id: UUID | None = None,
    _: CurrentUser = View,
) -> Page[LoadSummary]:
    items, total = service.list_loads(
        db, page, on_date, date_from, date_to, service.parse_statuses(status), truck_id
    )
    return Page(items=items, total=total, offset=page.offset, limit=page.limit)


@router.get(
    "/loads/{load_id}",
    summary="Ficha de una carga",
    description="Con paradas, reparto por compartimento y acciones permitidas.",
    response_model=LoadDetail,
    responses={404: _ERRORS[404]},
)
def get_load(load_id: UUID, db: TenantDbDep, user: CurrentUser = View) -> LoadDetail:
    return service.load_detail(db, user, load_id)


@router.post(
    "/loads",
    summary="Crear una carga",
    description=(
        "Se numera CAR-AAAA-NNNN. Sin `items` el servidor reparte las líneas en los "
        "compartimentos en orden de descarga. Los pedidos pasan a planificados."
    ),
    response_model=LoadDetail,
    status_code=201,
    responses=_PLAN_ERRORS,
)
def create_load(data: LoadIn, db: TenantDbDep, user: CurrentUser = Plan) -> LoadDetail:
    tenant_id = user.tenant_id
    assert tenant_id is not None
    load = Load(
        tenant_id=tenant_id,
        number="",
        load_date=data.load_date,
        truck_id=data.truck_id,
        created_by=user.id,
    )
    db.add(load)
    db.flush()
    service.apply_data(db, user, load, data)
    # Se numera después de validar para no gastar números en peticiones erróneas
    load.number = next_number(db, tenant_id, "CAR", today_madrid().year)
    db.add(load)
    db.flush()
    _audit(db, "carga.crear", user, load)
    db.commit()
    return service.load_detail(db, user, load.id)


@router.put(
    "/loads/{load_id}",
    summary="Editar una carga",
    description=(
        "Carga completa (paradas y reparto se reemplazan). Solo planificadas. Los pedidos "
        "que entran pasan a planificados y los que salen vuelven a confirmados."
    ),
    response_model=LoadDetail,
    responses=_PLAN_ERRORS,
)
def update_load(
    load_id: UUID, data: LoadIn, db: TenantDbDep, user: CurrentUser = Plan
) -> LoadDetail:
    load = service.get_for_update(db, load_id)
    service.ensure_action(user, load, "edit", (LoadStatus.PLANNED,))
    service.apply_data(db, user, load, data)
    _audit(db, "carga.editar", user, load)
    db.commit()
    return service.load_detail(db, user, load.id)


@router.post(
    "/loads/{load_id}/release",
    summary="Emitir la orden de carga a fábrica",
    description="Planificada → lista para cargar. Avisa a quien registra las pesadas.",
    response_model=LoadDetail,
    responses=_ERRORS,
)
def release_load(load_id: UUID, db: TenantDbDep, user: CurrentUser = Plan) -> LoadDetail:
    load = service.get_for_update(db, load_id)
    service.ensure_action(user, load, "release", (LoadStatus.PLANNED,))
    service.release(db, user, load)
    _audit(db, "carga.emitir", user, load)
    db.commit()
    return service.load_detail(db, user, load.id)


@router.post(
    "/loads/{load_id}/unrelease",
    summary="Devolver a planificación",
    description="Lista para cargar → planificada, para poder editarla.",
    response_model=LoadDetail,
    responses=_ERRORS,
)
def unrelease_load(load_id: UUID, db: TenantDbDep, user: CurrentUser = Plan) -> LoadDetail:
    load = service.get_for_update(db, load_id)
    service.ensure_action(user, load, "unrelease", (LoadStatus.READY,))
    service.unrelease(db, load)
    _audit(db, "carga.devolver", user, load)
    db.commit()
    return service.load_detail(db, user, load.id)


@router.post(
    "/loads/{load_id}/load",
    summary="Registrar la pesada",
    description=(
        "Lista para cargar → cargada. Saca el stock de cada compartimento de su silo, numera "
        "y genera los albaranes (si no se puede generar el PDF quedan pendientes) y avisa a "
        "planificación y a los comerciales. 409 INSUFFICIENT_STOCK sin efectos parciales."
    ),
    response_model=LoadDetail,
    responses={**_ERRORS, 409: {"description": "INVALID_STATUS o INSUFFICIENT_STOCK"}},
)
def weigh_load(
    load_id: UUID, data: WeighIn, db: TenantDbDep, user: CurrentUser = Weigh
) -> LoadDetail:
    load = service.get_for_update(db, load_id)
    service.ensure_action(user, load, "load", (LoadStatus.READY,))
    service.weigh(db, user, load, data)
    _audit(db, "carga.cargar", user, load)
    db.commit()
    return service.load_detail(db, user, load.id)


@router.post(
    "/loads/{load_id}/stops/{stop_id}/deliver",
    summary="Confirmar la entrega de una parada",
    description=(
        "Con la carga cargada. El pedido pasa a entregado y se avisa a su comercial; con la "
        "última parada la carga pasa a entregada."
    ),
    response_model=LoadDetail,
    responses=_ERRORS,
)
def deliver_stop(
    load_id: UUID, stop_id: UUID, data: DeliverIn, db: TenantDbDep, user: TenantUserDep
) -> LoadDetail:
    if not (user.can("logistica.planificar") or user.can("cargas.pesar")):
        raise forbidden()
    load = service.get_for_update(db, load_id)
    stop = service.get_stop(db, load, stop_id)
    service.ensure_action(user, load, "deliver", (LoadStatus.LOADED,))
    order = service.deliver(db, user, load, stop, data)
    _audit(db, "carga.entregar", user, load, parada=stop.sequence, pedido=order.number)
    db.commit()
    return service.load_detail(db, user, load.id)


@router.post(
    "/loads/{load_id}/cancel",
    summary="Cancelar una carga",
    description="Con motivo, desde planificada o lista. Sus pedidos vuelven a confirmados.",
    response_model=LoadDetail,
    responses=_ERRORS,
)
def cancel_load(
    load_id: UUID, data: ReasonIn, db: TenantDbDep, user: CurrentUser = Plan
) -> LoadDetail:
    load = service.get_for_update(db, load_id)
    service.ensure_action(user, load, "cancel", service.CANCELLABLE)
    service.cancel(db, load, data.reason)
    _audit(db, "carga.cancelar", user, load, motivo=data.reason)
    db.commit()
    return service.load_detail(db, user, load.id)


@router.get(
    "/loads/{load_id}/loading-order.pdf",
    summary="Orden de carga en PDF",
    description="Se genera al vuelo con el reparto previsto. No disponible si está cancelada.",
    response_class=Response,
    responses={**_PDF, 409: _ERRORS[409]},
)
def loading_order_pdf(load_id: UUID, db: TenantDbDep, _: CurrentUser = View) -> Response:
    load = service.get_load(db, load_id)
    return _pdf(service.loading_order_pdf(db, load), f"{load.number}.pdf")


@router.get(
    "/loads/{load_id}/stops/{stop_id}/delivery-note.pdf",
    summary="Albarán de una parada en PDF",
    description=(
        "El guardado al registrar la carga; si quedó pendiente, falta en el destino de la "
        "empresa o el destino no responde, se genera con los datos de la carga y se guarda. "
        "404 si la carga aún no está registrada."
    ),
    response_class=Response,
    responses=_PDF,
)
def delivery_note_pdf(
    load_id: UUID, stop_id: UUID, db: TenantDbDep, _: CurrentUser = View
) -> Response:
    load = service.get_load(db, load_id)
    stop = service.get_stop(db, load, stop_id)
    pdf = service.delivery_note_pdf(db, load, stop)
    db.commit()
    assert stop.delivery_note_number is not None
    return _pdf(pdf, f"{stop.delivery_note_number}.pdf")
