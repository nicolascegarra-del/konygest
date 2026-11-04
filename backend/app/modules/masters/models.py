"""Maestros: clientes y explotaciones, artículos, silos, tarifas, transporte, IVA y
formas de pago. Nada se borra: se desactiva (`is_active`) para no romper los
documentos que ya los usan. Todas las cantidades van en kg y los precios en €/kg."""

from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any
from uuid import UUID

from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel, UniqueConstraint

from app.core.models import created_at_field, id_field, tenant_fk


def _kg(default: Decimal | None = None, nullable: bool = False) -> Any:
    return Field(default=default, max_digits=14, decimal_places=2, nullable=nullable)


def _price(nullable: bool = True) -> Any:
    return Field(default=None, max_digits=10, decimal_places=4, nullable=nullable)


class VatRate(SQLModel, table=True):
    __tablename__ = "vat_rate"
    __table_args__ = (UniqueConstraint("tenant_id", "name"),)

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    name: str = Field(max_length=50)
    rate: Decimal = Field(max_digits=5, decimal_places=2)
    # Recargo de equivalencia
    surcharge: Decimal = Field(default=Decimal(0), max_digits=5, decimal_places=2)
    is_default: bool = False
    is_active: bool = True
    created_at: datetime = created_at_field()


class PaymentMethod(SQLModel, table=True):
    __tablename__ = "payment_method"
    __table_args__ = (UniqueConstraint("tenant_id", "name"),)

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    name: str = Field(max_length=100)
    # Días de cada vencimiento desde la fecha de factura: [30, 60, 90]
    due_days: list[int] = Field(default_factory=list, sa_column=Column(JSON, nullable=False))
    is_default: bool = False
    is_active: bool = True
    created_at: datetime = created_at_field()


class ItemKind(StrEnum):
    PRODUCT = "product"  # pienso
    RAW_MATERIAL = "raw_material"  # materia prima


class Item(SQLModel, table=True):
    """Artículo de stock: un pienso o una materia prima."""

    __table_args__ = (UniqueConstraint("tenant_id", "code"),)

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    code: str = Field(max_length=30)
    name: str = Field(max_length=200)
    kind: ItemKind = Field(index=True)
    description: str = Field(default="", max_length=1000)
    vat_rate_id: UUID | None = Field(default=None, foreign_key="vat_rate.id", ondelete="SET NULL")
    # Precio de tarifa general (solo piensos)
    base_price: Decimal | None = _price()
    # Por debajo de esta cantidad total se avisa de rotura de stock
    min_stock_kg: Decimal = _kg(Decimal(0))
    is_active: bool = True
    created_at: datetime = created_at_field()


class SiloKind(StrEnum):
    SILO = "silo"
    WAREHOUSE = "warehouse"  # almacén o nave (sacos, big bags...)


class Silo(SQLModel, table=True):
    """Silo o almacén de la fábrica donde se guarda el stock."""

    __table_args__ = (UniqueConstraint("tenant_id", "code"),)

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    code: str = Field(max_length=30)
    name: str = Field(max_length=200)
    kind: SiloKind = SiloKind.SILO
    capacity_kg: Decimal | None = _kg(nullable=True)
    is_active: bool = True
    created_at: datetime = created_at_field()


class PriceList(SQLModel, table=True):
    """Tarifa: precios por pienso que se asignan a varios clientes."""

    __tablename__ = "price_list"
    __table_args__ = (UniqueConstraint("tenant_id", "name"),)

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    name: str = Field(max_length=100)
    notes: str = Field(default="", max_length=1000)
    is_active: bool = True
    created_at: datetime = created_at_field()


class PriceListLine(SQLModel, table=True):
    __tablename__ = "price_list_line"
    __table_args__ = (UniqueConstraint("price_list_id", "item_id"),)

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    price_list_id: UUID = Field(foreign_key="price_list.id", index=True, ondelete="CASCADE")
    item_id: UUID = Field(foreign_key="item.id", ondelete="CASCADE")
    price: Decimal = _price(nullable=False)


class Customer(SQLModel, table=True):
    __table_args__ = (UniqueConstraint("tenant_id", "code"),)

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    code: str = Field(max_length=30)
    name: str = Field(max_length=200)
    tax_id: str | None = Field(default=None, max_length=20)
    address: str = Field(default="", max_length=300)
    postal_code: str = Field(default="", max_length=10)
    city: str = Field(default="", max_length=100)
    province: str = Field(default="", max_length=100)
    phone: str = Field(default="", max_length=30)
    email: str = Field(default="", max_length=254)
    # Comercial que lo lleva (los comerciales con alcance «propios» solo ven los suyos)
    sales_rep_id: UUID | None = Field(
        default=None, foreign_key="app_user.id", index=True, ondelete="SET NULL"
    )
    price_list_id: UUID | None = Field(
        default=None, foreign_key="price_list.id", ondelete="SET NULL"
    )
    payment_method_id: UUID | None = Field(
        default=None, foreign_key="payment_method.id", ondelete="SET NULL"
    )
    credit_limit: Decimal | None = Field(default=None, max_digits=14, decimal_places=2)
    # Recargo de equivalencia: se aplica en factura con el recargo de cada tipo de IVA
    equivalence_surcharge: bool = False
    notes: str = Field(default="", max_length=2000)
    is_active: bool = True
    created_at: datetime = created_at_field()


class CustomerPrice(SQLModel, table=True):
    """Precio negociado de un pienso para un cliente; gana a su tarifa."""

    __tablename__ = "customer_price"
    __table_args__ = (UniqueConstraint("customer_id", "item_id"),)

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    customer_id: UUID = Field(foreign_key="customer.id", index=True, ondelete="CASCADE")
    item_id: UUID = Field(foreign_key="item.id", ondelete="CASCADE")
    price: Decimal = _price(nullable=False)


class Farm(SQLModel, table=True):
    """Explotación ganadera de un cliente, donde se descarga el pienso."""

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    customer_id: UUID = Field(foreign_key="customer.id", index=True, ondelete="CASCADE")
    name: str = Field(max_length=200)
    rega_code: str = Field(default="", max_length=20)
    address: str = Field(default="", max_length=300)
    postal_code: str = Field(default="", max_length=10)
    city: str = Field(default="", max_length=100)
    province: str = Field(default="", max_length=100)
    latitude: float | None = None
    longitude: float | None = None
    # Silos de destino: [{"name": "Silo 1", "capacity_kg": 12000}]
    silos: list[dict[str, Any]] = Field(
        default_factory=list, sa_column=Column(JSON, nullable=False)
    )
    notes: str = Field(default="", max_length=2000)
    is_active: bool = True
    created_at: datetime = created_at_field()


class Carrier(SQLModel, table=True):
    """Transportista (o la flota propia de la fábrica)."""

    __table_args__ = (UniqueConstraint("tenant_id", "name"),)

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    name: str = Field(max_length=200)
    tax_id: str | None = Field(default=None, max_length=20)
    phone: str = Field(default="", max_length=30)
    email: str = Field(default="", max_length=254)
    is_own_fleet: bool = False
    is_active: bool = True
    created_at: datetime = created_at_field()


class Truck(SQLModel, table=True):
    __table_args__ = (UniqueConstraint("tenant_id", "plate"),)

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    plate: str = Field(max_length=15)
    carrier_id: UUID | None = Field(
        default=None, foreign_key="carrier.id", index=True, ondelete="SET NULL"
    )
    # Capacidad en kg de cada compartimento, en orden: [8000, 8000, 6000]
    compartments: list[float] = Field(default_factory=list, sa_column=Column(JSON, nullable=False))
    notes: str = Field(default="", max_length=1000)
    is_active: bool = True
    created_at: datetime = created_at_field()


class Driver(SQLModel, table=True):
    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    full_name: str = Field(max_length=200)
    phone: str = Field(default="", max_length=30)
    carrier_id: UUID | None = Field(
        default=None, foreign_key="carrier.id", index=True, ondelete="SET NULL"
    )
    is_active: bool = True
    created_at: datetime = created_at_field()
