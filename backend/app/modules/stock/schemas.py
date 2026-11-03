"""Esquemas de stock. Las cantidades van en kg; en JSON salen como número."""

from datetime import datetime
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, Field, StringConstraints, field_validator

from app.core.numbers import Kg, NonNegativeKg, PositiveKg
from app.modules.masters.models import ItemKind
from app.modules.stock.models import MovementKind


def _text(max_length: int, min_length: int = 0):
    return Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=min_length, max_length=max_length),
    ]


# ─── Salidas ───────────────────────────────────────


class LevelOut(BaseModel):
    item_id: UUID
    item_code: str
    item_name: str
    item_kind: ItemKind
    silo_id: UUID
    silo_code: str
    silo_name: str
    quantity_kg: Kg


class SummaryOut(BaseModel):
    item_id: UUID
    item_code: str
    item_name: str
    item_kind: ItemKind
    quantity_kg: Kg
    min_stock_kg: Kg
    below_min: bool


class MovementOut(BaseModel):
    id: UUID
    item_id: UUID
    item_code: str
    item_name: str
    silo_id: UUID
    silo_code: str
    silo_name: str
    kind: MovementKind
    quantity_kg: Kg
    lot: str | None
    occurred_at: datetime
    source_type: str | None
    source_id: UUID | None
    notes: str
    user_name: str | None


class ReceiptOut(BaseModel):
    id: UUID
    number: str
    item_id: UUID
    item_code: str
    item_name: str
    silo_id: UUID
    silo_code: str
    silo_name: str
    supplier: str
    delivery_note: str
    plate: str
    gross_kg: Kg
    tare_kg: Kg
    net_kg: Kg
    received_at: datetime
    notes: str
    user_name: str | None


class InventoryOut(BaseModel):
    movements: list[MovementOut]


# ─── Entradas ──────────────────────────────────────


class ReceiptIn(BaseModel):
    item_id: UUID
    silo_id: UUID
    supplier: _text(200) = ""
    delivery_note: _text(50) = ""
    plate: _text(15) = ""
    gross_kg: PositiveKg
    tare_kg: NonNegativeKg = Field(default=0)
    # Si no se indica, la hora actual
    received_at: datetime | None = None
    notes: _text(500) = ""

    @field_validator("plate")
    @classmethod
    def _upper_plate(cls, value: str) -> str:
        return value.upper()


class AdjustmentIn(BaseModel):
    item_id: UUID
    silo_id: UUID
    # Con signo: positivo suma, negativo resta
    quantity_kg: Kg
    reason: _text(500, min_length=1)

    @field_validator("quantity_kg")
    @classmethod
    def _not_zero(cls, value):
        if value == 0:
            raise ValueError("La cantidad del ajuste no puede ser 0.")
        return value


class InventoryLine(BaseModel):
    item_id: UUID
    silo_id: UUID
    counted_kg: NonNegativeKg


class InventoryIn(BaseModel):
    lines: list[InventoryLine] = Field(min_length=1, max_length=500)
    notes: _text(500) = ""
