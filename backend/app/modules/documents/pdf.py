"""Generación de PDF con WeasyPrint a partir de plantillas HTML (Jinja2).

Las plantillas están en `templates/` y solo pintan los datos de `types.py`: no consultan
la base de datos. El HTML se puede generar sin WeasyPrint (`render_*_html`), lo que
permite probar las plantillas en cualquier entorno.

WeasyPrint se importa de forma perezosa: necesita librerías nativas (Pango, HarfBuzz)
que en Windows sin GTK no existen. En ese caso se lanza `PdfUnavailableError`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import ROUND_HALF_UP, Decimal
from functools import lru_cache
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from jinja2 import Environment, FileSystemLoader, select_autoescape

from app.modules.documents.types import DeliveryNoteData, DocLine, InvoiceData, LoadingOrderData

TEMPLATES_DIR = Path(__file__).parent / "templates"
MADRID = ZoneInfo("Europe/Madrid")


class PdfUnavailableError(RuntimeError):
    """WeasyPrint no se puede cargar en este entorno."""


# ─── Filtros de formato (es-ES) ────────────────────────────────────────────────


def format_kg(value: Decimal | float | int | None, unit: bool = True) -> str:
    """Formatea kilos al estilo español: 12500 → "12.500 kg", 12500.5 → "12.500,5 kg"."""
    if value is None:
        return ""
    number = Decimal(str(value)).quantize(Decimal("0.001"))
    if number == number.to_integral_value():
        text = f"{int(number):,}".replace(",", ".")
    else:
        integer, _, decimals = f"{number.normalize():,.3f}".rstrip("0").partition(".")
        text = integer.replace(",", ".") + "," + decimals
    return f"{text} kg" if unit else text


def _es_number(value: Decimal, min_decimals: int, max_decimals: int) -> str:
    """Número con punto de miles y coma decimal, redondeado (mitad hacia arriba) a
    `max_decimals` y sin ceros sobrantes por debajo de `min_decimals`."""
    number = value.quantize(Decimal(1).scaleb(-max_decimals), rounding=ROUND_HALF_UP)
    if number == 0:
        number = abs(number)  # nunca «-0,00»
    text = f"{abs(number):,.{max_decimals}f}"
    integer, _, decimals = text.partition(".")
    decimals = decimals.rstrip("0").ljust(min_decimals, "0")
    result = integer.replace(",", ".") + ("," + decimals if decimals else "")
    return f"-{result}" if number < 0 else result


def format_money(value: Decimal | float | int | None, unit: bool = True) -> str:
    """Importe en euros al estilo español: 1234.5 → "1.234,50 €", -12 → "-12,00 €"."""
    if value is None:
        return ""
    text = _es_number(Decimal(str(value)), 2, 2)
    return f"{text} €" if unit else text


def format_price(value: Decimal | float | int | None) -> str:
    """Precio unitario (€/kg) con 2 a 4 decimales: 0.3 → "0,30", 0.31255 → "0,3126"."""
    if value is None:
        return ""
    return _es_number(Decimal(str(value)), 2, 4)


def format_percent(value: Decimal | float | int | None) -> str:
    """Porcentaje: 21 → "21 %", 5.20 → "5,2 %", 1.75 → "1,75 %"."""
    if value is None:
        return ""
    return f"{_es_number(Decimal(str(value)), 0, 2)} %"


def format_date(value: date | datetime | None) -> str:
    """DD/MM/YYYY (un datetime se pasa antes a hora de Madrid)."""
    if value is None:
        return ""
    if isinstance(value, datetime):
        value = to_madrid(value)
    return value.strftime("%d/%m/%Y")


def format_time(value: datetime | None) -> str:
    return to_madrid(value).strftime("%H:%M") if value else ""


def to_madrid(value: datetime) -> datetime:
    """Convierte a Europe/Madrid; un datetime sin zona se interpreta como UTC."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(MADRID)


@lru_cache
def _env() -> Environment:
    env = Environment(
        loader=FileSystemLoader(TEMPLATES_DIR),
        # Autoescape siempre: los nombres de clientes y observaciones los escribe el usuario
        autoescape=select_autoescape(default=True, default_for_string=True),
        trim_blocks=True,
        lstrip_blocks=True,
    )
    env.filters["kg"] = format_kg
    env.filters["fdate"] = format_date
    env.filters["ftime"] = format_time
    env.filters["money"] = format_money
    env.filters["price"] = format_price
    env.filters["pct"] = format_percent
    return env


# ─── Contexto de las plantillas ────────────────────────────────────────────────


@dataclass(frozen=True)
class _CompartmentRow:
    number: int
    capacity_kg: float
    line: DocLine | None
    stop_sequence: int | None
    customer_name: str


def _compartment_rows(data: LoadingOrderData) -> list[_CompartmentRow]:
    """Una fila por compartimento del camión, con lo que lleva (o vacío)."""
    by_compartment: dict[int, tuple[DocLine, int, str]] = {}
    for stop in data.stops:
        for line in stop.lines:
            if line.compartment is not None:
                by_compartment[line.compartment] = (line, stop.sequence, stop.party.customer_name)
    rows = []
    for number, capacity in enumerate(data.compartments_kg, start=1):
        line, sequence, customer = by_compartment.get(number, (None, None, ""))
        rows.append(_CompartmentRow(number, capacity, line, sequence, customer))
    return rows


def _line_order(line: DocLine) -> tuple[int, str]:
    return (line.compartment or 0, line.item_code)


def render_loading_order_html(data: LoadingOrderData) -> str:
    stops = [
        (stop, sorted(stop.lines, key=_line_order))
        for stop in sorted(data.stops, key=lambda s: s.sequence)
    ]
    total = sum((line.quantity_kg for s in data.stops for line in s.lines), Decimal(0))
    context: dict[str, Any] = {
        "doc": data,
        "title": "Orden de carga",
        "stops": stops,
        "compartments": _compartment_rows(data),
        "capacity_kg": sum(data.compartments_kg),
        "total_kg": total,
    }
    return _env().get_template("loading_order.html").render(context)


def render_delivery_note_html(data: DeliveryNoteData) -> str:
    net = None
    if data.gross_kg is not None and data.tare_kg is not None:
        net = data.gross_kg - data.tare_kg
    context: dict[str, Any] = {
        "doc": data,
        "title": "Albarán",
        "lines": sorted(data.lines, key=_line_order),
        "total_kg": sum((line.quantity_kg for line in data.lines), Decimal(0)),
        "net_kg": net,
    }
    return _env().get_template("delivery_note.html").render(context)


# Tipos de factura de Verifactu (clave TipoFactura del SII / Verifactu)
INVOICE_TYPE_LABELS = {
    "F1": "Factura completa",
    "F2": "Factura simplificada",
    "F3": "Factura en sustitución de simplificadas",
    "R1": "Rectificativa (art. 80 Uno, Dos y Seis LIVA)",
    "R2": "Rectificativa (art. 80.3 LIVA)",
    "R3": "Rectificativa (art. 80.4 LIVA)",
    "R4": "Rectificativa (resto de causas)",
    "R5": "Rectificativa de factura simplificada",
}


def render_invoice_html(data: InvoiceData) -> str:
    credit_note = data.kind == "credit_note"
    customer = data.customer
    city_line = " ".join(part for part in (customer.postal_code, customer.city) if part)
    if customer.province and customer.province != customer.city:
        city_line = f"{city_line} ({customer.province})" if city_line else customer.province
    context: dict[str, Any] = {
        "doc": data,
        "title": "Factura rectificativa" if credit_note else "Factura",
        "credit_note": credit_note,
        "type_label": INVOICE_TYPE_LABELS.get(data.invoice_type, ""),
        "customer_city": city_line,
        "has_surcharge": data.surcharge_amount != 0
        or any(line.surcharge_rate for line in data.lines),
    }
    return _env().get_template("invoice.html").render(context)


# ─── PDF ───────────────────────────────────────────────────────────────────────


def html_to_pdf(html: str) -> bytes:
    """Convierte HTML a PDF. `PdfUnavailableError` si WeasyPrint no puede cargarse."""
    try:
        from weasyprint import HTML
    except (ImportError, OSError) as exc:
        raise PdfUnavailableError(f"WeasyPrint no disponible: {exc}") from exc
    # base_url apunta a las plantillas; no hay recursos remotos (fuentes de sistema)
    return HTML(string=html, base_url=str(TEMPLATES_DIR)).write_pdf()


def render_loading_order(data: LoadingOrderData) -> bytes:
    return html_to_pdf(render_loading_order_html(data))


def render_delivery_note(data: DeliveryNoteData) -> bytes:
    return html_to_pdf(render_delivery_note_html(data))


def render_invoice(data: InvoiceData) -> bytes:
    """PDF de factura o abono con el QR tributario de Verifactu."""
    return html_to_pdf(render_invoice_html(data))
