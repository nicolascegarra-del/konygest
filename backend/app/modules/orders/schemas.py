"""Esquemas de los pedidos de los comerciales (contrato en docs/api-fase2.md)."""

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, Field, PlainSerializer, StringConstraints

from app.core.numbers import Kg, Money, PositiveKg, Price
from app.modules.orders.models import OrderStatus, PriceSource

# Importe con signo (el disponible de riesgo puede ser negativo)
SignedMoney = Annotated[
    Decimal,
    Field(max_digits=14, decimal_places=2),
    PlainSerializer(float, return_type=float, when_used="json"),
]
Reason = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
OrderAction = Literal["edit", "submit", "validate", "reject", "cancel"]


class OrderLineIn(BaseModel):
    item_id: UUID
    quantity_kg: PositiveKg
    # Si se omite, el precio que corresponde al cliente (negociado > tarifa > general)
    unit_price: Price | None = None
    farm_silo: Annotated[str, StringConstraints(strip_whitespace=True, max_length=50)] = ""
    notes: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] = ""


class OrderIn(BaseModel):
    """Alta y edición (PUT con el pedido completo: las líneas se reemplazan)."""

    customer_id: UUID
    farm_id: UUID
    requested_date: date
    sales_rep_id: UUID | None = None
    notes: Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)] = ""
    # Guardar y enviar a validar en la misma llamada
    submit: bool = False
    lines: list[OrderLineIn] = Field(min_length=1, max_length=20)


class ValidateIn(BaseModel):
    notes: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] = ""
    # Validar aunque se supere el límite de riesgo del cliente
    force: bool = False


class ReasonIn(BaseModel):
    reason: Reason


class OrderSummary(BaseModel):
    id: UUID
    number: str
    status: OrderStatus
    customer_id: UUID
    customer_code: str
    customer_name: str
    farm_id: UUID
    farm_name: str
    sales_rep_id: UUID | None
    sales_rep_name: str | None
    requested_date: date
    total_kg: Kg
    total_amount: Money
    line_count: int
    has_manual_price: bool
    created_at: datetime
    submitted_at: datetime | None
    updated_at: datetime


class OrderLineOut(BaseModel):
    id: UUID
    position: int
    item_id: UUID
    item_code: str
    item_name: str
    quantity_kg: Kg
    unit_price: Price
    price_source: PriceSource
    reference_price: Price | None
    amount: Money
    farm_silo: str
    notes: str


class OrderDetail(OrderSummary):
    notes: str
    status_reason: str
    validated_by_name: str | None
    validated_at: datetime | None
    created_by_name: str | None
    allowed_actions: list[OrderAction]
    lines: list[OrderLineOut]


class DaySummary(BaseModel):
    date: date
    orders: int
    total_kg: Kg


class CreditCheck(BaseModel):
    credit_limit: Money | None
    outstanding_amount: Money
    order_amount: Money
    available: SignedMoney | None
    exceeded: bool


class PriceCheck(BaseModel):
    line_id: UUID
    item_code: str
    item_name: str
    unit_price: Price
    reference_price: Price
    difference_pct: float


class StockCheck(BaseModel):
    item_id: UUID
    item_code: str
    item_name: str
    requested_kg: Kg
    stock_kg: Kg
    committed_kg: Kg
    short: bool


class OrderChecks(BaseModel):
    credit: CreditCheck
    prices: list[PriceCheck]
    stock: list[StockCheck]
