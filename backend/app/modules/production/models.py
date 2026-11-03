"""Órdenes de fabricación. Sin el módulo de fórmulas y lotes solo se registra el
producto terminado al terminar la orden."""

from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from sqlmodel import Field, SQLModel

from app.core.models import created_at_field, dt_field, id_field, tenant_fk


class ProductionStatus(StrEnum):
    PLANNED = "planned"
    IN_PROGRESS = "in_progress"
    DONE = "done"
    CANCELLED = "cancelled"


class ProductionOrder(SQLModel, table=True):
    __tablename__ = "production_order"

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    number: str = Field(max_length=30)  # OF-2026-0001
    item_id: UUID = Field(foreign_key="item.id", ondelete="RESTRICT")
    # Silo donde se descarga el producto terminado
    silo_id: UUID = Field(foreign_key="silo.id", ondelete="RESTRICT")
    planned_kg: Decimal = Field(max_digits=14, decimal_places=2)
    produced_kg: Decimal | None = Field(default=None, max_digits=14, decimal_places=2)
    status: ProductionStatus = Field(default=ProductionStatus.PLANNED, index=True)
    planned_date: date = Field(index=True)
    started_at: datetime | None = dt_field()
    finished_at: datetime | None = dt_field()
    notes: str = Field(default="", max_length=1000)
    created_by: UUID | None = Field(default=None, foreign_key="app_user.id", ondelete="SET NULL")
    created_at: datetime = created_at_field()
