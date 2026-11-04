"""Facturación: facturas desde albaranes entregados, abonos (rectificativas) y el
registro de facturación de Verifactu.

Una factura nace en borrador (editable y borrable). Al emitirse recibe su número
correlativo, se congelan los datos del cliente y los importes, se genera el registro
Verifactu con su huella encadenada y el PDF con el QR. Una factura emitida ya no se
edita: se corrige con un abono (factura rectificativa) o, si se emitió por error, se
anula (registro de anulación de Verifactu).
"""

from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any
from uuid import UUID

from sqlalchemy import JSON, Column, DateTime, Index
from sqlmodel import Field, SQLModel, UniqueConstraint

from app.core.models import created_at_field, dt_field, id_field, tenant_fk
from app.core.security import utcnow


def _money(nullable: bool = False) -> Any:
    return Field(default=Decimal(0), max_digits=14, decimal_places=2, nullable=nullable)


class InvoiceKind(StrEnum):
    INVOICE = "invoice"  # factura (serie F)
    CREDIT_NOTE = "credit_note"  # abono / factura rectificativa (serie R)


class InvoiceStatus(StrEnum):
    DRAFT = "draft"
    ISSUED = "issued"
    CANCELLED = "cancelled"  # anulada (registro de anulación Verifactu)


class Invoice(SQLModel, table=True):
    __tablename__ = "sales_invoice"
    __table_args__ = (
        Index("ix_sales_invoice_tenant_status_date", "tenant_id", "status", "issue_date"),
        UniqueConstraint("tenant_id", "number"),
    )

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    kind: InvoiceKind = InvoiceKind.INVOICE
    # Número definitivo al emitir (F-2026-0001 / R-2026-0001); en borrador es None
    number: str | None = Field(default=None, max_length=30)
    # Tipo Verifactu: F1 factura completa; R1..R5 rectificativas
    invoice_type: str = Field(default="F1", max_length=2)
    status: InvoiceStatus = Field(default=InvoiceStatus.DRAFT)
    customer_id: UUID = Field(foreign_key="customer.id", index=True, ondelete="RESTRICT")
    # Factura que rectifica (solo abonos)
    rectified_invoice_id: UUID | None = Field(
        default=None, foreign_key="sales_invoice.id", index=True, ondelete="RESTRICT"
    )
    rectification_reason: str = Field(default="", max_length=500)
    issue_date: date  # fecha de expedición (la fija quien emite; por defecto hoy)
    # Periodo de las entregas facturadas (informativo, sale en el PDF)
    period_from: date | None = None
    period_to: date | None = None
    # Datos del cliente congelados al emitir (los maestros pueden cambiar después)
    customer_snapshot: dict[str, Any] = Field(
        default_factory=dict, sa_column=Column(JSON, nullable=False)
    )
    # Datos del emisor congelados al emitir: un PDF regenerado debe salir igual aunque la
    # empresa cambie después de dirección o razón social
    company_snapshot: dict[str, Any] = Field(
        default_factory=dict, sa_column=Column(JSON, nullable=False)
    )
    payment_method_name: str = Field(default="", max_length=100)
    # Vencimientos: [{"date": "2026-12-04", "amount": 1234.56}]
    due_dates: list[dict[str, Any]] = Field(
        default_factory=list, sa_column=Column(JSON, nullable=False)
    )
    # Desglose por tipo de IVA: [{"vat_rate", "surcharge_rate", "base", "vat", "surcharge"}]
    tax_breakdown: list[dict[str, Any]] = Field(
        default_factory=list, sa_column=Column(JSON, nullable=False)
    )
    total_kg: Decimal = Field(default=Decimal(0), max_digits=14, decimal_places=2)
    taxable_base: Decimal = _money()
    vat_amount: Decimal = _money()
    surcharge_amount: Decimal = _money()
    total: Decimal = _money()  # con signo: los abonos van en negativo
    notes: str = Field(default="", max_length=2000)
    status_reason: str = Field(default="", max_length=500)  # motivo de la anulación
    issued_at: datetime | None = dt_field()
    issued_by: UUID | None = Field(default=None, foreign_key="app_user.id", ondelete="SET NULL")
    cancelled_at: datetime | None = dt_field()
    created_by: UUID | None = Field(default=None, foreign_key="app_user.id", ondelete="SET NULL")
    created_at: datetime = created_at_field()
    updated_at: datetime = Field(
        default_factory=utcnow, sa_type=DateTime(timezone=True), nullable=False
    )


class InvoiceLine(SQLModel, table=True):
    __tablename__ = "sales_invoice_line"

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    invoice_id: UUID = Field(foreign_key="sales_invoice.id", index=True, ondelete="CASCADE")
    position: int = 0
    # Origen: línea de pedido entregada (facturas) o línea de la factura rectificada (abonos)
    order_id: UUID | None = Field(
        default=None, foreign_key="sales_order.id", index=True, ondelete="RESTRICT"
    )
    order_line_id: UUID | None = Field(
        default=None, foreign_key="sales_order_line.id", ondelete="RESTRICT"
    )
    load_stop_id: UUID | None = Field(default=None, foreign_key="load_stop.id", ondelete="SET NULL")
    rectified_line_id: UUID | None = Field(
        default=None, foreign_key="sales_invoice_line.id", ondelete="RESTRICT"
    )
    # Datos congelados
    item_id: UUID | None = Field(default=None, foreign_key="item.id", ondelete="SET NULL")
    item_code: str = Field(default="", max_length=30)
    description: str = Field(max_length=300)  # «Cebo cerdos · Albarán ALB-2026-0003»
    delivery_note_number: str | None = Field(default=None, max_length=30)
    delivery_date: date | None = None
    quantity_kg: Decimal = Field(max_digits=14, decimal_places=2)  # con signo en abonos
    unit_price: Decimal = Field(max_digits=10, decimal_places=4)
    vat_rate: Decimal = Field(max_digits=5, decimal_places=2)
    surcharge_rate: Decimal = Field(default=Decimal(0), max_digits=5, decimal_places=2)
    amount: Decimal = _money()  # base imponible de la línea, con signo


class VerifactuRecordType(StrEnum):
    ALTA = "alta"
    ANULACION = "anulacion"


class VerifactuRecord(SQLModel, table=True):
    """Registro de facturación de Verifactu. Libro inmutable y encadenado por empresa:
    la API solo puede leer e insertar (ver migración). `sequence` da el orden de la
    cadena; `previous_hash` es la huella del registro anterior de la misma empresa."""

    __tablename__ = "verifactu_record"
    __table_args__ = (UniqueConstraint("tenant_id", "sequence"),)

    id: UUID = id_field()
    tenant_id: UUID = tenant_fk()
    sequence: int
    record_type: VerifactuRecordType
    invoice_id: UUID = Field(foreign_key="sales_invoice.id", index=True, ondelete="RESTRICT")
    issuer_nif: str = Field(max_length=20)
    invoice_number: str = Field(max_length=60)
    issue_date: date
    invoice_type: str = Field(default="", max_length=2)  # solo altas
    total_tax: Decimal | None = Field(default=None, max_digits=14, decimal_places=2)
    total_amount: Decimal | None = Field(default=None, max_digits=14, decimal_places=2)
    generated_at: datetime = Field(sa_type=DateTime(timezone=True), nullable=False)
    previous_hash: str | None = Field(default=None, max_length=64)
    hash: str = Field(max_length=64)
    qr_url: str | None = Field(default=None, max_length=500)
    # Envío a la AEAT (fase 7); hoy siempre "not_sent"
    send_status: str = Field(default="not_sent", max_length=20)
    created_at: datetime = created_at_field()
