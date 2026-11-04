"""Esquemas de facturación, abonos y registro Verifactu (contrato en docs/api-fase4.md)."""

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, PlainSerializer, StringConstraints, model_validator

from app.core.numbers import Kg, Percent, Price
from app.modules.invoicing.models import InvoiceKind, InvoiceStatus, VerifactuRecordType

# Importe con signo: los abonos van en negativo
SignedMoney = Annotated[
    Decimal,
    Field(max_digits=14, decimal_places=2),
    PlainSerializer(float, return_type=float, when_used="json"),
]
PositiveMoney = Annotated[
    Decimal,
    Field(gt=0, max_digits=14, decimal_places=2),
    PlainSerializer(float, return_type=float, when_used="json"),
]
PositiveKgIn = Annotated[
    Decimal,
    Field(gt=0, max_digits=14, decimal_places=2),
    PlainSerializer(float, return_type=float, when_used="json"),
]
Reason = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
Notes = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)]
InvoiceAction = Literal["edit", "delete", "issue", "credit_note", "cancel"]
CreditType = Literal["R1", "R4"]


# ─── Entrada ───────────────────────────────────────


class InvoiceCreate(BaseModel):
    customer_id: UUID
    order_ids: list[UUID] = Field(min_length=1, max_length=200)
    issue_date: date | None = None
    notes: Notes = ""


class BulkCreate(BaseModel):
    date_from: date | None = None
    date_to: date
    customer_ids: list[UUID] | None = Field(default=None, max_length=500)
    issue_date: date | None = None


class CreditLineIn(BaseModel):
    invoice_line_id: UUID
    # Kilos devueltos (al precio de la línea) o descuento en €: uno de los dos
    quantity_kg: PositiveKgIn | None = None
    amount: PositiveMoney | None = None

    @model_validator(mode="after")
    def _one_of(self) -> "CreditLineIn":
        if (self.quantity_kg is None) == (self.amount is None):
            raise ValueError("Indica los kg devueltos o el importe del descuento (uno de los dos).")
        return self


class CreditNoteIn(BaseModel):
    """Alta (POST /invoices/{id}/credit-note) y edición (PUT) de un borrador de abono."""

    invoice_type: CreditType = "R1"
    rectification_reason: Reason
    full: bool = False
    lines: list[CreditLineIn] | None = Field(default=None, max_length=500)
    issue_date: date | None = None
    notes: Notes = ""

    @model_validator(mode="after")
    def _lines_or_full(self) -> "CreditNoteIn":
        if not self.full and not self.lines:
            raise ValueError("Indica las líneas que se abonan o `full: true`.")
        return self


class InvoiceUpdate(BaseModel):
    """PUT de un borrador: los campos de factura o los de abono según su tipo."""

    # Factura
    order_ids: list[UUID] | None = Field(default=None, min_length=1, max_length=200)
    # Abono
    invoice_type: CreditType | None = None
    rectification_reason: Reason | None = None
    full: bool = False
    lines: list[CreditLineIn] | None = Field(default=None, max_length=500)
    # Ambos
    issue_date: date | None = None
    notes: Notes = ""


class IssueIn(BaseModel):
    issue_date: date | None = None


class CancelIn(BaseModel):
    reason: Reason


# ─── Salida ────────────────────────────────────────


class PendingOrder(BaseModel):
    id: UUID
    number: str
    delivered_at: date | None
    total_kg: Kg
    amount: SignedMoney


class PendingCustomer(BaseModel):
    customer_id: UUID
    customer_code: str
    customer_name: str
    order_count: int
    total_kg: Kg
    estimated_base: SignedMoney
    oldest_delivery: date | None
    orders: list[PendingOrder]


class InvoiceSummary(BaseModel):
    id: UUID
    kind: InvoiceKind
    number: str | None
    invoice_type: str
    status: InvoiceStatus
    customer_id: UUID
    customer_code: str
    customer_name: str
    issue_date: date
    total_kg: Kg
    taxable_base: SignedMoney
    vat_amount: SignedMoney
    surcharge_amount: SignedMoney
    total: SignedMoney
    rectified_invoice_id: UUID | None
    rectified_number: str | None
    created_at: datetime
    issued_at: datetime | None


class BulkOut(BaseModel):
    created: list[InvoiceSummary]


class DueDate(BaseModel):
    date: date
    amount: SignedMoney


class TaxLine(BaseModel):
    vat_rate: Percent
    surcharge_rate: Percent
    base: SignedMoney
    vat: SignedMoney
    surcharge: SignedMoney


class InvoiceLineOut(BaseModel):
    id: UUID
    position: int
    order_id: UUID | None
    order_number: str | None
    # Solo abonos: la línea de la factura rectificada
    rectified_line_id: UUID | None
    item_code: str
    description: str
    delivery_note_number: str | None
    delivery_date: date | None
    quantity_kg: Kg
    unit_price: Price
    vat_rate: Percent
    surcharge_rate: Percent
    amount: SignedMoney
    # Lo ya abonado de esta línea en abonos emitidos (positivo)
    credited_kg: Kg
    credited_amount: SignedMoney


class VerifactuInfo(BaseModel):
    hash: str
    previous_hash: str | None
    generated_at: datetime
    qr_url: str | None


class InvoiceDetail(InvoiceSummary):
    notes: str
    status_reason: str
    rectification_reason: str
    period_from: date | None
    period_to: date | None
    customer_snapshot: dict[str, Any]
    payment_method_name: str
    due_dates: list[DueDate]
    tax_breakdown: list[TaxLine]
    lines: list[InvoiceLineOut]
    credit_notes: list[InvoiceSummary]
    verifactu: VerifactuInfo | None
    pdf_ready: bool
    issued_by_name: str | None
    created_by_name: str | None
    allowed_actions: list[InvoiceAction]


class MonthSummary(BaseModel):
    month: str
    invoiced_total: SignedMoney
    credit_total: SignedMoney
    net_total: SignedMoney
    invoice_count: int
    previous_month_net: SignedMoney


class VerifactuRecordOut(BaseModel):
    id: UUID
    sequence: int
    record_type: VerifactuRecordType
    invoice_id: UUID
    invoice_number: str
    issue_date: date
    invoice_type: str
    total_tax: SignedMoney | None
    total_amount: SignedMoney | None
    generated_at: datetime
    previous_hash: str | None
    hash: str
    send_status: str


class BrokenRecord(BaseModel):
    sequence: int
    invoice_number: str


class ChainCheck(BaseModel):
    ok: bool
    records: int
    broken: list[BrokenRecord]
