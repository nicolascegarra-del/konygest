"""Logística: cargas de camión, sus paradas (una por pedido) y el reparto de las
líneas de pedido en los compartimentos del camión.

Ciclo de una carga: planificada → lista para cargar (se emite la orden de carga a
fábrica) → cargada (fábrica registra la pesada real: sale el stock y se emiten los
albaranes) → entregada (todas las paradas confirmadas). Se puede cancelar mientras
no esté cargada; sus pedidos vuelven a «confirmado».
"""

from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from sqlalchemy import DateTime, Index
from sqlmodel import Field, SQLModel, UniqueConstraint

from app.core.models import created_at_field, dt_field, id_field, tenant_fk
from app.core.security import utcnow


class LoadStatus(StrEnum):
    PLANNED = "planned"
    READY = "ready"  # orden de carga emitida a fábrica
    LOADED = "loaded"
    DELIVERED = "delivered"
    CANCELLED = "cancelled"


class Load(SQLModel, table=True):
    __tablename__ = "truck_load"
    __table_args__ = (
        Index("ix_truck_load_tenant_date_status", "tenant_id", "load_date", "status"),
    )

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    number: str = Field(max_length=30)  # CAR-2026-0001
    load_date: date
    truck_id: UUID = Field(foreign_key="truck.id", index=True, ondelete="RESTRICT")
    driver_id: UUID | None = Field(default=None, foreign_key="driver.id", ondelete="SET NULL")
    status: LoadStatus = Field(default=LoadStatus.PLANNED)
    notes: str = Field(default="", max_length=2000)
    status_reason: str = Field(default="", max_length=500)
    # Pesada de báscula del camión al salir (opcional; la cantidad real va por compartimento)
    gross_kg: Decimal | None = Field(default=None, max_digits=14, decimal_places=2)
    tare_kg: Decimal | None = Field(default=None, max_digits=14, decimal_places=2)
    released_at: datetime | None = dt_field()
    loaded_at: datetime | None = dt_field()
    loaded_by: UUID | None = Field(default=None, foreign_key="app_user.id", ondelete="SET NULL")
    delivered_at: datetime | None = dt_field()
    created_by: UUID | None = Field(default=None, foreign_key="app_user.id", ondelete="SET NULL")
    created_at: datetime = created_at_field()
    updated_at: datetime = Field(
        default_factory=utcnow, sa_type=DateTime(timezone=True), nullable=False
    )


class LoadStop(SQLModel, table=True):
    """Parada de la ruta: un pedido, con su orden de descarga y su albarán."""

    __tablename__ = "load_stop"
    __table_args__ = (UniqueConstraint("load_id", "order_id"),)

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    load_id: UUID = Field(foreign_key="truck_load.id", index=True, ondelete="CASCADE")
    order_id: UUID = Field(foreign_key="sales_order.id", index=True, ondelete="RESTRICT")
    sequence: int  # orden de descarga, desde 1
    # Albarán / documento de acompañamiento, al registrar la carga. El fichero se localiza
    # con `documents` por kind="delivery_note" y este número (tabla stored_document)
    delivery_note_number: str | None = Field(default=None, max_length=30)  # ALB-2026-0001
    delivered_at: datetime | None = dt_field()
    received_by: str = Field(default="", max_length=200)
    delivery_notes: str = Field(default="", max_length=1000)
    confirmed_by: UUID | None = Field(default=None, foreign_key="app_user.id", ondelete="SET NULL")


class LoadItem(SQLModel, table=True):
    """Kilos de una línea de pedido en un compartimento del camión.

    Un compartimento lleva una sola línea de pedido (no se mezclan piensos ni
    clientes); una línea grande puede ocupar varios compartimentos.
    """

    __tablename__ = "load_item"
    __table_args__ = (UniqueConstraint("load_id", "compartment"),)

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    load_id: UUID = Field(foreign_key="truck_load.id", index=True, ondelete="CASCADE")
    stop_id: UUID = Field(foreign_key="load_stop.id", index=True, ondelete="CASCADE")
    order_line_id: UUID = Field(foreign_key="sales_order_line.id", ondelete="RESTRICT")
    compartment: int  # índice en truck.compartments, desde 1
    planned_kg: Decimal = Field(max_digits=14, decimal_places=2)
    # Al registrar la carga
    actual_kg: Decimal | None = Field(default=None, max_digits=14, decimal_places=2)
    silo_id: UUID | None = Field(default=None, foreign_key="silo.id", ondelete="RESTRICT")
    lot: str | None = Field(default=None, max_length=50)
    stock_movement_id: UUID | None = Field(
        default=None, foreign_key="stock_movement.id", ondelete="RESTRICT"
    )
