"""Datos que reciben las plantillas PDF. Los construye cada módulo (logística,
facturación...) y el módulo de documentos solo los pinta: así las plantillas no
consultan la base de datos y se pueden probar con datos inventados."""

from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal


@dataclass(frozen=True)
class CompanyInfo:
    name: str
    tax_id: str | None = None
    address: str = ""
    # Nº de registro/autorización de establecimiento de piensos (si se configura)
    registration: str = ""


@dataclass(frozen=True)
class PartyInfo:
    """Cliente y su explotación de destino."""

    customer_code: str
    customer_name: str
    customer_tax_id: str | None
    farm_name: str
    farm_rega: str = ""
    farm_address: str = ""


@dataclass(frozen=True)
class TransportInfo:
    truck_plate: str
    carrier_name: str | None = None
    driver_name: str | None = None


@dataclass(frozen=True)
class DocLine:
    item_code: str
    item_name: str
    quantity_kg: Decimal
    compartment: int | None = None
    farm_silo: str = ""
    lot: str | None = None
    factory_silo: str | None = None  # silo de fábrica de donde sale


@dataclass(frozen=True)
class LoadingOrderStop:
    sequence: int
    order_number: str
    party: PartyInfo
    lines: list[DocLine] = field(default_factory=list)


@dataclass(frozen=True)
class LoadingOrderData:
    """Orden de carga para fábrica: qué cargar en cada compartimento y en qué orden."""

    company: CompanyInfo
    number: str  # CAR-2026-0001
    load_date: date
    transport: TransportInfo
    compartments_kg: list[float]
    stops: list[LoadingOrderStop]
    notes: str = ""


@dataclass(frozen=True)
class DeliveryNoteData:
    """Albarán / documento de acompañamiento de una entrega (una parada de la carga)."""

    company: CompanyInfo
    number: str  # ALB-2026-0001
    issued_at: datetime
    load_number: str
    order_number: str
    party: PartyInfo
    transport: TransportInfo
    lines: list[DocLine]
    gross_kg: Decimal | None = None
    tare_kg: Decimal | None = None
    notes: str = ""
