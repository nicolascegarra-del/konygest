"""Stock: libro de movimientos inmutable. El stock de un artículo en un silo es la
suma de sus movimientos; nunca se guarda un saldo que se pueda desincronizar.
La API solo tiene permiso de INSERT y SELECT sobre `stock_movement` (ver migración),
así que un movimiento no se puede editar ni borrar: se corrige con otro."""

from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from sqlalchemy import DateTime, Index
from sqlmodel import Field, SQLModel

from app.core.models import created_at_field, id_field, tenant_fk
from app.core.security import utcnow


class MovementKind(StrEnum):
    RAW_MATERIAL_IN = "raw_material_in"  # entrada de materia prima (báscula)
    PRODUCTION = "production"  # producto terminado fabricado
    CONSUMPTION = "consumption"  # consumo de materia prima en fabricación
    LOAD_OUT = "load_out"  # salida por carga (fase 3)
    ADJUSTMENT = "adjustment"  # ajuste manual con motivo
    INVENTORY = "inventory"  # diferencia de recuento de inventario


class StockMovement(SQLModel, table=True):
    __tablename__ = "stock_movement"
    __table_args__ = (
        Index("ix_stock_movement_tenant_item_silo", "tenant_id", "item_id", "silo_id"),
    )

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    item_id: UUID = Field(foreign_key="item.id", ondelete="RESTRICT")
    silo_id: UUID = Field(foreign_key="silo.id", index=True, ondelete="RESTRICT")
    kind: MovementKind = Field(index=True)
    # Con signo: positivo entra, negativo sale
    quantity_kg: Decimal = Field(max_digits=14, decimal_places=2)
    # Lote (lo usará el módulo de fórmulas y lotes)
    lot: str | None = Field(default=None, max_length=50)
    occurred_at: datetime = Field(
        default_factory=utcnow, sa_type=DateTime(timezone=True), nullable=False, index=True
    )
    # Documento que lo origina: ("raw_material_receipt", id), ("production_order", id)...
    source_type: str | None = Field(default=None, max_length=50)
    source_id: UUID | None = None
    notes: str = Field(default="", max_length=500)
    user_id: UUID | None = Field(default=None, foreign_key="app_user.id", ondelete="SET NULL")
    created_at: datetime = created_at_field()


class RawMaterialReceipt(SQLModel, table=True):
    """Entrada de materia prima con la pesada de báscula introducida a mano."""

    __tablename__ = "raw_material_receipt"

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    number: str = Field(max_length=30)  # EMP-2026-0001
    item_id: UUID = Field(foreign_key="item.id", ondelete="RESTRICT")
    silo_id: UUID = Field(foreign_key="silo.id", ondelete="RESTRICT")
    supplier: str = Field(default="", max_length=200)
    delivery_note: str = Field(default="", max_length=50)  # albarán del proveedor
    plate: str = Field(default="", max_length=15)
    gross_kg: Decimal = Field(max_digits=14, decimal_places=2)
    tare_kg: Decimal = Field(max_digits=14, decimal_places=2)
    net_kg: Decimal = Field(max_digits=14, decimal_places=2)
    received_at: datetime = Field(
        default_factory=utcnow, sa_type=DateTime(timezone=True), nullable=False, index=True
    )
    notes: str = Field(default="", max_length=500)
    user_id: UUID | None = Field(default=None, foreign_key="app_user.id", ondelete="SET NULL")
    created_at: datetime = created_at_field()
