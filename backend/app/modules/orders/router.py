"""Rutas de los pedidos de los comerciales (contrato en docs/api-fase2.md)."""

from datetime import date
from uuid import UUID

from fastapi import APIRouter, Depends

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
from app.modules.masters.models import Customer
from app.modules.orders import service
from app.modules.orders.models import Order, OrderStatus
from app.modules.orders.schemas import (
    DaySummary,
    OrderChecks,
    OrderDetail,
    OrderIn,
    OrderSummary,
    ReasonIn,
    ValidateIn,
)
from app.modules.platform.audit import audit

router = APIRouter(
    prefix="/orders", tags=["Pedidos"], dependencies=[Depends(require_module("ventas"))]
)

View = Depends(require_permission("pedidos.ver"))
Create = Depends(require_permission("pedidos.crear"))
Validate = Depends(require_permission("pedidos.validar"))

_ERRORS = {
    400: {"description": "Datos no válidos: VALIDATION_ERROR, INVALID_REFERENCE, ..."},
    403: {"description": "Sin permiso para esta acción"},
    404: {"description": "El pedido no existe o está fuera de tu alcance"},
    409: {"description": "INVALID_STATUS: no se puede desde el estado actual"},
}


def _audit(db, action: str, user: CurrentUser, order: Order, **data) -> None:
    audit(
        db,
        action,
        user=user,
        entity="sales_order",
        entity_id=order.id,
        data={"numero": order.number, **data},
    )


def _can_manage(user: CurrentUser) -> None:
    # Editar, enviar y cancelar: o lo crea él o lo valida oficina
    if not user.can("pedidos.ver") or not (
        user.can("pedidos.crear") or user.can("pedidos.validar")
    ):
        raise forbidden()


@router.get(
    "",
    summary="Pedidos",
    description=(
        "Por fecha de entrega y número, del más reciente al más antiguo. `status` admite varios "
        "separados por coma. `search` busca por número o por nombre/código de cliente. "
        "`mine=true`: solo los que lleva o ha creado el usuario. El comercial solo ve los suyos "
        "y los de sus clientes."
    ),
    response_model=Page[OrderSummary],
)
def list_orders(
    db: TenantDbDep,
    page: PageDep,
    status: str | None = None,
    customer_id: UUID | None = None,
    sales_rep_id: UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    search: str | None = None,
    mine: bool = False,
    user: CurrentUser = View,
) -> Page[OrderSummary]:
    items, total = service.list_orders(
        db,
        user,
        page,
        service.parse_statuses(status),
        customer_id,
        sales_rep_id,
        date_from,
        date_to,
        search,
        mine,
    )
    return Page(items=items, total=total, offset=page.offset, limit=page.limit)


@router.get(
    "/summary",
    summary="Pedidos aceptados por día de entrega",
    description=(
        "Pedidos confirmados, planificados, cargados y entregados agrupados por fecha de "
        f"entrega; solo los días con pedidos. Rango máximo {service.MAX_SUMMARY_DAYS} días."
    ),
    response_model=list[DaySummary],
    responses={400: _ERRORS[400]},
)
def orders_summary(
    db: TenantDbDep, date_from: date, date_to: date, user: CurrentUser = View
) -> list[DaySummary]:
    return service.summary(db, user, date_from, date_to)


@router.get(
    "/{order_id}",
    summary="Ficha de un pedido",
    description="Con sus líneas y las acciones que el usuario puede hacer (`allowed_actions`).",
    response_model=OrderDetail,
    responses={404: _ERRORS[404]},
)
def get_order(order_id: UUID, db: TenantDbDep, user: CurrentUser = View) -> OrderDetail:
    return service.order_detail(db, user, order_id)


@router.get(
    "/{order_id}/checks",
    summary="Comprobaciones de riesgo, precio y stock",
    description="El stock es informativo; el riesgo impide validar salvo `force`.",
    response_model=OrderChecks,
    responses={404: _ERRORS[404]},
)
def order_checks(order_id: UUID, db: TenantDbDep, user: CurrentUser = View) -> OrderChecks:
    return service.checks(db, user, order_id)


@router.post(
    "",
    summary="Crear un pedido",
    description=(
        "Se numera PED-AAAA-NNNN. Sin `unit_price` se usa el precio del cliente. Con "
        "`submit: true` se envía a validar en la misma llamada."
    ),
    response_model=OrderDetail,
    status_code=201,
    responses={400: _ERRORS[400]},
)
def create_order(data: OrderIn, db: TenantDbDep, user: CurrentUser = Create) -> OrderDetail:
    tenant_id = user.tenant_id
    assert tenant_id is not None
    order = Order(
        tenant_id=tenant_id,
        number="",
        customer_id=data.customer_id,
        farm_id=data.farm_id,
        requested_date=data.requested_date,
        created_by=user.id,
    )
    service.apply_data(db, user, order, data)
    # Se numera después de validar para no gastar números en peticiones erróneas
    order.number = next_number(db, tenant_id, "PED", service.today_madrid().year)
    db.add(order)
    db.flush()
    _audit(db, "pedido.crear", user, order)
    if data.submit:
        customer = db.get(Customer, order.customer_id)
        assert customer is not None
        service.submit(db, user, order, customer)
        _audit(db, "pedido.enviar", user, order)
    db.commit()
    return service.order_detail(db, user, order.id)


@router.put(
    "/{order_id}",
    summary="Editar un pedido",
    description=(
        "Pedido completo (las líneas se reemplazan). El comercial edita borradores y "
        "rechazados; oficina (`pedidos.validar`), también los pendientes. `submit: true` lo "
        "envía a validar después de guardar (si está en borrador o rechazado)."
    ),
    response_model=OrderDetail,
    responses=_ERRORS,
)
def update_order(
    order_id: UUID, data: OrderIn, db: TenantDbDep, user: TenantUserDep
) -> OrderDetail:
    _can_manage(user)
    order, customer = service.get_for_update(db, user, order_id)
    statuses = (*service.EDITABLE_BY_CREATOR, OrderStatus.PENDING)
    service.ensure_action(user, order, customer.sales_rep_id, "edit", statuses)
    service.apply_data(db, user, order, data, as_validator=order.status == OrderStatus.PENDING)
    _audit(db, "pedido.editar", user, order)
    if data.submit and order.status in service.EDITABLE_BY_CREATOR:
        new_customer = db.get(Customer, order.customer_id)
        assert new_customer is not None
        service.ensure_action(
            user, order, new_customer.sales_rep_id, "submit", service.EDITABLE_BY_CREATOR
        )
        service.submit(db, user, order, new_customer)
        _audit(db, "pedido.enviar", user, order)
    db.commit()
    return service.order_detail(db, user, order.id)


@router.post(
    "/{order_id}/submit",
    summary="Enviar a validar",
    description="Desde borrador o rechazado. Avisa a quienes pueden validar.",
    response_model=OrderDetail,
    responses=_ERRORS,
)
def submit_order(order_id: UUID, db: TenantDbDep, user: TenantUserDep) -> OrderDetail:
    _can_manage(user)
    order, customer = service.get_for_update(db, user, order_id)
    service.ensure_action(user, order, customer.sales_rep_id, "submit", service.EDITABLE_BY_CREATOR)
    service.submit(db, user, order, customer)
    _audit(db, "pedido.enviar", user, order)
    db.commit()
    return service.order_detail(db, user, order.id)


@router.post(
    "/{order_id}/validate",
    summary="Validar un pedido",
    description=(
        "Pendiente → confirmado. Si supera el riesgo del cliente hace falta `force: true` "
        "(409 CREDIT_LIMIT_EXCEEDED si no)."
    ),
    response_model=OrderDetail,
    responses={**_ERRORS, 409: {"description": "INVALID_STATUS o CREDIT_LIMIT_EXCEEDED"}},
)
def validate_order(
    order_id: UUID, data: ValidateIn, db: TenantDbDep, user: CurrentUser = Validate
) -> OrderDetail:
    order, customer = service.get_for_update(db, user, order_id)
    service.ensure_action(user, order, customer.sales_rep_id, "validate", (OrderStatus.PENDING,))
    forced = service.validate(db, user, order, customer, data.notes, data.force)
    extra: dict = {"forzado": True} if forced else {}
    if data.notes:
        extra["notas"] = data.notes
    _audit(db, "pedido.validar", user, order, **extra)
    db.commit()
    return service.order_detail(db, user, order.id)


@router.post(
    "/{order_id}/reject",
    summary="Rechazar un pedido",
    description="Pendiente → rechazado, con motivo. El comercial lo corrige y lo reenvía.",
    response_model=OrderDetail,
    responses=_ERRORS,
)
def reject_order(
    order_id: UUID, data: ReasonIn, db: TenantDbDep, user: CurrentUser = Validate
) -> OrderDetail:
    order, customer = service.get_for_update(db, user, order_id)
    service.ensure_action(user, order, customer.sales_rep_id, "reject", (OrderStatus.PENDING,))
    service.reject(db, user, order, customer, data.reason)
    _audit(db, "pedido.rechazar", user, order, motivo=data.reason)
    db.commit()
    return service.order_detail(db, user, order.id)


@router.post(
    "/{order_id}/cancel",
    summary="Cancelar un pedido",
    description=(
        "Con motivo. Borradores, rechazados y pendientes: quien lo crea o oficina; "
        "confirmados: solo oficina."
    ),
    response_model=OrderDetail,
    responses=_ERRORS,
)
def cancel_order(
    order_id: UUID, data: ReasonIn, db: TenantDbDep, user: TenantUserDep
) -> OrderDetail:
    _can_manage(user)
    order, customer = service.get_for_update(db, user, order_id)
    statuses = (*service.CANCELLABLE_BY_CREATOR, OrderStatus.CONFIRMED)
    service.ensure_action(user, order, customer.sales_rep_id, "cancel", statuses)
    service.cancel(db, order, data.reason)
    _audit(db, "pedido.cancelar", user, order, motivo=data.reason)
    db.commit()
    return service.order_detail(db, user, order.id)
