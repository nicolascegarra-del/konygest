"""Esquemas de los maestros. Se editan con PUT (el formulario envía la ficha entera),
así que el esquema de entrada sirve para crear y para editar."""

from datetime import datetime
from decimal import Decimal
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.core.numbers import Money, NonNegativeKg, Percent, PositiveKg, Price
from app.modules.masters.models import ItemKind, SiloKind

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Code = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=30)]


def _text(max_length: int):
    return Annotated[str, StringConstraints(strip_whitespace=True, max_length=max_length)]


class _Out(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: datetime


# ─── IVA y formas de pago ──────────────────────────


class VatRateIn(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)]
    rate: Percent
    surcharge: Percent = Decimal(0)
    is_default: bool = False
    is_active: bool = True


class VatRateOut(VatRateIn, _Out):
    pass


class PaymentMethodIn(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
    due_days: list[Annotated[int, Field(ge=0, le=365)]] = Field(default=[], max_length=12)
    is_default: bool = False
    is_active: bool = True


class PaymentMethodOut(PaymentMethodIn, _Out):
    pass


# ─── Artículos y silos ─────────────────────────────


class ItemIn(BaseModel):
    code: Code
    name: Name
    kind: ItemKind
    description: _text(1000) = ""
    vat_rate_id: UUID | None = None
    base_price: Price | None = None
    min_stock_kg: NonNegativeKg = Decimal(0)
    is_active: bool = True


class ItemOut(ItemIn, _Out):
    pass


class SiloIn(BaseModel):
    code: Code
    name: Name
    kind: SiloKind = SiloKind.SILO
    capacity_kg: PositiveKg | None = None
    is_active: bool = True


class SiloOut(SiloIn, _Out):
    pass


# ─── Tarifas ───────────────────────────────────────


class PriceLineIn(BaseModel):
    item_id: UUID
    price: Price


class PriceLineOut(PriceLineIn):
    item_code: str
    item_name: str


class PriceListIn(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
    notes: _text(1000) = ""
    is_active: bool = True
    lines: list[PriceLineIn] = Field(default=[], max_length=500)


class PriceListOut(PriceListIn, _Out):
    lines: list[PriceLineOut] = []  # type: ignore[assignment]


# ─── Clientes y explotaciones ──────────────────────


class CustomerIn(BaseModel):
    code: Code
    name: Name
    tax_id: Annotated[str, StringConstraints(strip_whitespace=True, max_length=20)] | None = None
    address: _text(300) = ""
    postal_code: _text(10) = ""
    city: _text(100) = ""
    province: _text(100) = ""
    phone: _text(30) = ""
    email: _text(254) = ""
    sales_rep_id: UUID | None = None
    price_list_id: UUID | None = None
    payment_method_id: UUID | None = None
    credit_limit: Money | None = None
    notes: _text(2000) = ""
    is_active: bool = True
    # Precios negociados; si no se envía, no se tocan
    prices: list[PriceLineIn] | None = Field(default=None, max_length=500)


class CustomerOut(CustomerIn, _Out):
    sales_rep_name: str | None = None
    farm_count: int = 0
    prices: list[PriceLineOut] = []  # type: ignore[assignment]


class FarmSilo(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)]
    # float y no Decimal: se guarda en una columna JSON
    capacity_kg: Annotated[float, Field(gt=0, le=1_000_000)] | None = None


class FarmIn(BaseModel):
    customer_id: UUID
    name: Name
    rega_code: _text(20) = ""
    address: _text(300) = ""
    postal_code: _text(10) = ""
    city: _text(100) = ""
    province: _text(100) = ""
    latitude: Annotated[float, Field(ge=-90, le=90)] | None = None
    longitude: Annotated[float, Field(ge=-180, le=180)] | None = None
    silos: list[FarmSilo] = Field(default=[], max_length=50)
    notes: _text(2000) = ""
    is_active: bool = True


class FarmOut(FarmIn, _Out):
    customer_name: str = ""


# ─── Transporte ────────────────────────────────────


class CarrierIn(BaseModel):
    name: Name
    tax_id: Annotated[str, StringConstraints(strip_whitespace=True, max_length=20)] | None = None
    phone: _text(30) = ""
    email: _text(254) = ""
    is_own_fleet: bool = False
    is_active: bool = True


class CarrierOut(CarrierIn, _Out):
    pass


class TruckIn(BaseModel):
    plate: Annotated[
        str, StringConstraints(strip_whitespace=True, to_upper=True, min_length=1, max_length=15)
    ]
    carrier_id: UUID | None = None
    compartments: list[Annotated[float, Field(gt=0, le=100_000)]] = Field(
        min_length=1, max_length=12
    )
    notes: _text(1000) = ""
    is_active: bool = True


class TruckOut(TruckIn, _Out):
    capacity_kg: float = 0
    carrier_name: str | None = None


class DriverIn(BaseModel):
    full_name: Name
    phone: _text(30) = ""
    carrier_id: UUID | None = None
    is_active: bool = True


class DriverOut(DriverIn, _Out):
    carrier_name: str | None = None


# ─── Otros ─────────────────────────────────────────


class PriceQuote(BaseModel):
    """Precio que corresponde a un cliente para un pienso y de dónde sale."""

    price: Price | None
    source: str  # customer | price_list | base | none


class Option(BaseModel):
    id: UUID
    name: str
    code: str | None = None
    kind: str | None = None


class MasterLookups(BaseModel):
    """Opciones para los desplegables de los formularios (solo activos)."""

    vat_rates: list[Option]
    payment_methods: list[Option]
    price_lists: list[Option]
    carriers: list[Option]
    sales_reps: list[Option]
    silos: list[Option]
    items: list[Option]
