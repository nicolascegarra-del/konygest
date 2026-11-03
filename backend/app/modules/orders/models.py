"""Pedidos de los comerciales.

Ciclo: borrador → pendiente de validar (oficina revisa riesgo y precio) →
confirmado → planificado → cargado → entregado → facturado. La oficina puede
rechazar un pedido pendiente: vuelve al comercial como `rejected` con el motivo, y
este lo corrige y lo reenvía. Los estados desde «planificado» los mueven la
logística (fase 3) y la facturación (fase 4).
"""

from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from sqlalchemy import DateTime, Index
from sqlmodel import Field, SQLModel

from app.core.models import created_at_field, dt_field, id_field, tenant_fk
from app.core.security import utcnow


class OrderStatus(StrEnum):
    DRAFT = "draft"
    PENDING = "pending"  # pendiente de validar
    REJECTED = "rejected"  # devuelto al comercial
    CONFIRMED = "confirmed"
    PLANNED = "planned"  # asignado a una carga (fase 3)
    LOADED = "loaded"
    DELIVERED = "delivered"
    INVOICED = "invoiced"  # fase 4
    CANCELLED = "cancelled"


class PriceSource(StrEnum):
    CUSTOMER = "customer"  # precio negociado del cliente
    PRICE_LIST = "price_list"  # su tarifa
    BASE = "base"  # precio general del pienso
    MANUAL = "manual"  # el comercial lo ha cambiado


class Order(SQLModel, table=True):
    __tablename__ = "sales_order"
    __table_args__ = (
        Index("ix_sales_order_tenant_status_date", "tenant_id", "status", "requested_date"),
    )

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    number: str = Field(max_length=30)  # PED-2026-0001
    customer_id: UUID = Field(foreign_key="customer.id", index=True, ondelete="RESTRICT")
    farm_id: UUID = Field(foreign_key="farm.id", ondelete="RESTRICT")
    # Comercial responsable (los de alcance «propios» ven y editan solo los suyos)
    sales_rep_id: UUID | None = Field(
        default=None, foreign_key="app_user.id", index=True, ondelete="SET NULL"
    )
    status: OrderStatus = Field(default=OrderStatus.DRAFT)
    requested_date: date
    notes: str = Field(default="", max_length=2000)
    # Totales calculados al guardar las líneas
    total_kg: Decimal = Field(default=Decimal(0), max_digits=14, decimal_places=2)
    total_amount: Decimal = Field(default=Decimal(0), max_digits=14, decimal_places=2)
    submitted_at: datetime | None = dt_field()
    validated_by: UUID | None = Field(default=None, foreign_key="app_user.id", ondelete="SET NULL")
    validated_at: datetime | None = dt_field()
    # Motivo del último rechazo o de la cancelación
    status_reason: str = Field(default="", max_length=500)
    created_by: UUID | None = Field(default=None, foreign_key="app_user.id", ondelete="SET NULL")
    created_at: datetime = created_at_field()
    updated_at: datetime = Field(
        default_factory=utcnow, sa_type=DateTime(timezone=True), nullable=False
    )


class OrderLine(SQLModel, table=True):
    __tablename__ = "sales_order_line"

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    order_id: UUID = Field(foreign_key="sales_order.id", index=True, ondelete="CASCADE")
    position: int = 0
    item_id: UUID = Field(foreign_key="item.id", ondelete="RESTRICT")
    quantity_kg: Decimal = Field(max_digits=14, decimal_places=2)
    unit_price: Decimal = Field(max_digits=10, decimal_places=4)  # €/kg sin IVA
    price_source: PriceSource
    # Precio que correspondía según cliente/tarifa/general, para que oficina compare
    reference_price: Decimal | None = Field(default=None, max_digits=10, decimal_places=4)
    amount: Decimal = Field(max_digits=14, decimal_places=2)
    # Silo de destino de la explotación (nombre, del JSON de silos de la granja)
    farm_silo: str = Field(default="", max_length=50)
    notes: str = Field(default="", max_length=500)
