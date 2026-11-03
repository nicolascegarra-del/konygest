"""Esquemas de las órdenes de fabricación."""

from datetime import date, datetime
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, StringConstraints

from app.core.numbers import Kg, PositiveKg
from app.modules.production.models import ProductionStatus


class OrderIn(BaseModel):
    """Alta y edición (PUT con la orden completa)."""

    item_id: UUID
    silo_id: UUID
    planned_kg: PositiveKg
    planned_date: date
    notes: Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)] = ""


class FinishIn(BaseModel):
    produced_kg: PositiveKg
    # Silo donde se ha descargado de verdad; si no se indica, el de la orden
    silo_id: UUID | None = None


class OrderOut(BaseModel):
    id: UUID
    number: str
    item_id: UUID
    item_code: str
    item_name: str
    silo_id: UUID
    silo_code: str
    silo_name: str
    planned_kg: Kg
    produced_kg: Kg | None
    status: ProductionStatus
    planned_date: date
    started_at: datetime | None
    finished_at: datetime | None
    notes: str
    created_by_name: str | None
    created_at: datetime
