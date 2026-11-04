"""Esquemas de la logística: cargas, paradas, reparto y pesada (contrato en docs/api-fase3.md)."""

from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, Field, StringConstraints

from app.core.numbers import Kg, NonNegativeKg, PositiveKg
from app.modules.logistics.models import LoadStatus
from app.modules.orders.models import OrderStatus
from app.modules.orders.schemas import OrderSummary

LoadAction = Literal["edit", "release", "unrelease", "load", "deliver", "cancel"]
MAX_STOPS = 10


def _text(max_length: int):
    return Annotated[str, StringConstraints(strip_whitespace=True, max_length=max_length)]


# ─── Entrada ───────────────────────────────────────


class LoadStopIn(BaseModel):
    order_id: UUID
    sequence: int = Field(ge=1, le=MAX_STOPS)


class LoadItemIn(BaseModel):
    order_line_id: UUID
    compartment: int = Field(ge=1)
    planned_kg: PositiveKg


class LoadIn(BaseModel):
    """Alta y edición (PUT con la carga completa: paradas y reparto se reemplazan)."""

    load_date: date
    truck_id: UUID
    driver_id: UUID | None = None
    notes: _text(2000) = ""
    stops: list[LoadStopIn] = Field(min_length=1, max_length=MAX_STOPS)
    # Vacío u omitido: el servidor reparte automáticamente
    items: list[LoadItemIn] = Field(default_factory=list, max_length=50)


class WeighItemIn(BaseModel):
    item_id: UUID  # id del load_item
    actual_kg: PositiveKg
    silo_id: UUID
    lot: Annotated[str, StringConstraints(strip_whitespace=True, max_length=50)] | None = None


class WeighIn(BaseModel):
    gross_kg: NonNegativeKg | None = None
    tare_kg: NonNegativeKg | None = None
    items: list[WeighItemIn] = Field(min_length=1, max_length=50)


class DeliverIn(BaseModel):
    received_by: _text(200) = ""
    delivered_at: datetime | None = None
    notes: _text(1000) = ""


# ─── Salida ────────────────────────────────────────


class LoadSummary(BaseModel):
    id: UUID
    number: str
    load_date: date
    status: LoadStatus
    truck_id: UUID
    truck_plate: str
    carrier_name: str | None
    driver_id: UUID | None
    driver_name: str | None
    capacity_kg: Kg
    planned_kg: Kg
    stop_count: int
    customers: list[str]
    created_at: datetime
    updated_at: datetime


class LoadStopOut(BaseModel):
    id: UUID
    sequence: int
    order_id: UUID
    order_number: str
    order_status: OrderStatus
    customer_name: str
    farm_name: str
    farm_rega: str
    farm_city: str
    requested_date: date
    total_kg: Kg
    delivery_note_number: str | None
    delivery_note_ready: bool
    delivered_at: datetime | None
    received_by: str
    delivery_notes: str


class LoadItemOut(BaseModel):
    id: UUID
    stop_id: UUID
    order_line_id: UUID
    compartment: int
    item_id: UUID
    item_code: str
    item_name: str
    farm_silo: str
    planned_kg: Kg
    actual_kg: Kg | None
    silo_id: UUID | None
    silo_name: str | None
    lot: str | None


class LoadDetail(LoadSummary):
    notes: str
    status_reason: str
    gross_kg: Kg | None
    tare_kg: Kg | None
    released_at: datetime | None
    loaded_at: datetime | None
    loaded_by_name: str | None
    delivered_at: datetime | None
    created_by_name: str | None
    allowed_actions: list[LoadAction]
    compartments: list[float]
    stops: list[LoadStopOut]
    items: list[LoadItemOut]


class PendingOrderLine(BaseModel):
    id: UUID
    item_id: UUID
    item_code: str
    item_name: str
    quantity_kg: Kg
    farm_silo: str


class PendingOrder(OrderSummary):
    farm_city: str
    lines: list[PendingOrderLine]
