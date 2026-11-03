"""Lógica de los maestros que no es CRUD puro: alcance del comercial, precios
negociados, líneas de tarifa y el precio que corresponde a cada cliente."""

from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import func
from sqlmodel import Session, col, delete, select
from sqlmodel.sql.expression import SelectOfScalar

from app.core.catalog import Scope
from app.core.deps import CurrentUser
from app.core.errors import bad_request
from app.modules.masters.models import (
    Carrier,
    Customer,
    CustomerPrice,
    Farm,
    Item,
    ItemKind,
    PriceList,
    PriceListLine,
    Truck,
)
from app.modules.masters.schemas import (
    CustomerIn,
    CustomerOut,
    DriverOut,
    FarmOut,
    PriceLineIn,
    PriceLineOut,
    PriceListIn,
    PriceListOut,
    PriceQuote,
    TruckOut,
)
from app.modules.users.models import RolePermission, User, UserRole


def own_only(user: CurrentUser) -> bool:
    return user.scope("maestros.ver") == Scope.OWN


def scope_customers(query: SelectOfScalar, user: CurrentUser) -> SelectOfScalar:
    if own_only(user):
        query = query.where(Customer.sales_rep_id == user.id)
    return query


def scope_farms(query: SelectOfScalar, user: CurrentUser) -> SelectOfScalar:
    if own_only(user):
        query = query.join(Customer, Customer.id == Farm.customer_id).where(
            Customer.sales_rep_id == user.id
        )
    return query


# ─── Líneas de precio (tarifas y precios negociados) ───


def _check_price_lines(db: Session, lines: list[PriceLineIn], field: str) -> None:
    ids = [line.item_id for line in lines]
    if len(ids) != len(set(ids)):
        raise bad_request("VALIDATION_ERROR", "Hay artículos repetidos en los precios.", field)
    found = set(
        db.exec(select(Item.id).where(col(Item.id).in_(ids), Item.kind == ItemKind.PRODUCT)).all()
    )
    if len(found) != len(set(ids)):
        raise bad_request("INVALID_REFERENCE", "Los precios solo pueden ser de piensos.", field)


def _lines_out(db: Session, rows: list[Any]) -> dict[UUID, list[PriceLineOut]]:
    """Agrupa líneas de precio por su padre (tarifa o cliente) con datos del artículo."""
    items = {
        i.id: i
        for i in db.exec(select(Item).where(col(Item.id).in_({r.item_id for r in rows}))).all()
    }
    result: dict[UUID, list[PriceLineOut]] = {}
    for r in rows:
        parent = r.price_list_id if isinstance(r, PriceListLine) else r.customer_id
        item = items[r.item_id]
        result.setdefault(parent, []).append(
            PriceLineOut(item_id=r.item_id, price=r.price, item_code=item.code, item_name=item.name)
        )
    for lines in result.values():
        lines.sort(key=lambda line: line.item_code)
    return result


def save_price_list_lines(db: Session, price_list: PriceList, data: PriceListIn) -> None:
    _check_price_lines(db, data.lines, "lines")
    db.exec(delete(PriceListLine).where(col(PriceListLine.price_list_id) == price_list.id))
    for line in data.lines:
        db.add(
            PriceListLine(
                tenant_id=price_list.tenant_id,
                price_list_id=price_list.id,
                item_id=line.item_id,
                price=line.price,
            )
        )


def price_lists_out(db: Session, rows: list[PriceList]) -> list[PriceListOut]:
    lines = db.exec(
        select(PriceListLine).where(col(PriceListLine.price_list_id).in_([r.id for r in rows]))
    ).all()
    by_list = _lines_out(db, list(lines))
    return [
        PriceListOut.model_validate({**r.model_dump(), "lines": by_list.get(r.id, [])})
        for r in rows
    ]


def save_customer_prices(db: Session, customer: Customer, data: CustomerIn) -> None:
    if data.prices is None:
        return
    _check_price_lines(db, data.prices, "prices")
    db.exec(delete(CustomerPrice).where(col(CustomerPrice.customer_id) == customer.id))
    for line in data.prices:
        db.add(
            CustomerPrice(
                tenant_id=customer.tenant_id,
                customer_id=customer.id,
                item_id=line.item_id,
                price=line.price,
            )
        )


def customers_out(db: Session, rows: list[Customer]) -> list[CustomerOut]:
    ids = [r.id for r in rows]
    prices = _lines_out(
        db, list(db.exec(select(CustomerPrice).where(col(CustomerPrice.customer_id).in_(ids))))
    )
    farms = dict(
        db.exec(
            select(Farm.customer_id, func.count())
            .where(col(Farm.customer_id).in_(ids), Farm.is_active)
            .group_by(Farm.customer_id)
        ).all()
    )
    reps = _user_names(db, {r.sales_rep_id for r in rows if r.sales_rep_id})
    return [
        CustomerOut.model_validate(
            {
                **r.model_dump(),
                "prices": prices.get(r.id, []),
                "farm_count": farms.get(r.id, 0),
                "sales_rep_name": reps.get(r.sales_rep_id) if r.sales_rep_id else None,
            }
        )
        for r in rows
    ]


def _user_names(db: Session, ids: set[UUID]) -> dict[UUID, str]:
    if not ids:
        return {}
    return dict(db.exec(select(User.id, User.full_name).where(col(User.id).in_(ids))).all())


def _carrier_names(db: Session, ids: set[UUID | None]) -> dict[UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return dict(db.exec(select(Carrier.id, Carrier.name).where(col(Carrier.id).in_(ids))).all())


def farms_out(db: Session, rows: list[Farm]) -> list[FarmOut]:
    ids = {r.customer_id for r in rows}
    names = dict(db.exec(select(Customer.id, Customer.name).where(col(Customer.id).in_(ids))).all())
    return [
        FarmOut.model_validate({**r.model_dump(), "customer_name": names.get(r.customer_id, "")})
        for r in rows
    ]


def trucks_out(db: Session, rows: list[Truck]) -> list[TruckOut]:
    names = _carrier_names(db, {r.carrier_id for r in rows})
    return [
        TruckOut.model_validate(
            {
                **r.model_dump(),
                "capacity_kg": sum(r.compartments),
                "carrier_name": names.get(r.carrier_id) if r.carrier_id else None,
            }
        )
        for r in rows
    ]


def drivers_out(db: Session, rows: list[Any]) -> list[DriverOut]:
    names = _carrier_names(db, {r.carrier_id for r in rows})
    return [
        DriverOut.model_validate(
            {**r.model_dump(), "carrier_name": names.get(r.carrier_id) if r.carrier_id else None}
        )
        for r in rows
    ]


# ─── Precio para un cliente ────────────────────────


def quote_price(db: Session, customer: Customer, item: Item) -> PriceQuote:
    """Precio negociado > tarifa del cliente > precio general del pienso."""
    negotiated = db.exec(
        select(CustomerPrice.price).where(
            CustomerPrice.customer_id == customer.id, CustomerPrice.item_id == item.id
        )
    ).first()
    if negotiated is not None:
        return PriceQuote(price=negotiated, source="customer")
    if customer.price_list_id:
        listed = db.exec(
            select(PriceListLine.price)
            .join(PriceList, PriceList.id == PriceListLine.price_list_id)
            .where(
                PriceListLine.price_list_id == customer.price_list_id,
                PriceListLine.item_id == item.id,
                PriceList.is_active,
            )
        ).first()
        if listed is not None:
            return PriceQuote(price=listed, source="price_list")
    if item.base_price is not None:
        return PriceQuote(price=Decimal(item.base_price), source="base")
    return PriceQuote(price=None, source="none")


def sales_rep_options(db: Session) -> list[tuple[UUID, str]]:
    """Usuarios activos que pueden crear pedidos: los que pueden llevar clientes."""
    return list(
        db.exec(
            select(User.id, User.full_name)
            .join(UserRole, UserRole.user_id == User.id)
            .join(RolePermission, RolePermission.role_id == UserRole.role_id)
            .where(RolePermission.permission == "pedidos.crear", User.is_active)
            .distinct()
            .order_by(User.full_name)
        ).all()
    )
