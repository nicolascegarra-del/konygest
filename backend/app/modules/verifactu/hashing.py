"""Huella (hash) encadenada de los registros de facturación VERI*FACTU.

Sigue el documento de la AEAT «Detalle de las especificaciones técnicas para generación
de la huella o hash de los registros de facturación» (versión 0.1.2, 27/08/2024), que
desarrolla el artículo 13 de la Orden HAC/1177/2024:

- Algoritmo SHA-256 (único permitido en la lista L12 del anexo de la orden).
- Entrada: `campo1=valor1&campo2=valor2&...` con los campos y el orden fijados para cada
  tipo de registro, valores sin espacios al principio ni al final, codificada en UTF-8.
- Salida: 64 caracteres hexadecimales en mayúsculas.
- El primer registro del sistema informático no tiene huella anterior: el campo va
  vacío (`...&Huella=&...`), pero su propia huella se calcula y se informa igual.

Altas y anulaciones comparten una única cadena por sistema informático y obligado a
expedir: la huella anterior de un registro es la del último registro generado, sea del
tipo que sea. Los registros de evento (RegistroEvento) tienen su propia cadena y no se
implementan aquí (solo los exigen los sistemas «no VERI*FACTU»).

Importante: el valor de cada campo debe ser exactamente el que se escribe en el XML que
se envía a la AEAT; por eso el formateo de importes y fechas está en funciones públicas
que el generador de XML (fase 7) tiene que reutilizar en lugar de formatear por su cuenta.
"""

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum

# Lista L2 del anexo de la Orden HAC/1177/2024 (TipoFactura).
# VERIFICAR contra el anexo/XSD vigente antes de la fase 4: la lista sale de nuestro
# conocimiento de la orden, no de los documentos técnicos consultados para este módulo.


class InvoiceType(StrEnum):
    F1 = "F1"  # Factura (art. 6, 7.2 y 7.3 del RD 1619/2012)
    F2 = "F2"  # Factura simplificada y facturas sin identificación del destinatario
    F3 = "F3"  # Factura emitida en sustitución de facturas simplificadas
    R1 = "R1"  # Rectificativa (art. 80.1, 80.2 y error fundado en derecho LIVA)
    R2 = "R2"  # Rectificativa (art. 80.3 LIVA, concurso)
    R3 = "R3"  # Rectificativa (art. 80.4 LIVA, créditos incobrables)
    R4 = "R4"  # Rectificativa (resto)
    R5 = "R5"  # Rectificativa en facturas simplificadas


_TWO_PLACES = Decimal("0.01")


@dataclass(frozen=True, slots=True)
class InvoiceRecord:
    """Datos de un registro de facturación de alta (RegistroAlta) que entran en la huella.

    Los importes son los del XML: en rectificativas por diferencias pueden ser negativos.
    `generated_at` es FechaHoraHusoGenRegistro: debe llevar zona horaria.
    """

    issuer_nif: str
    invoice_number: str
    issue_date: date
    invoice_type: InvoiceType
    total_tax: Decimal
    total_amount: Decimal
    generated_at: datetime


@dataclass(frozen=True, slots=True)
class CancellationRecord:
    """Datos de un registro de anulación (RegistroAnulacion) que entran en la huella.

    Identifica la factura anulada (NIF del emisor, número y fecha de expedición).
    """

    issuer_nif: str
    invoice_number: str
    issue_date: date
    generated_at: datetime


type BillingRecord = InvoiceRecord | CancellationRecord


@dataclass(frozen=True, slots=True)
class ChainedRecord:
    """Registro tal y como queda guardado: sus datos y la huella que se le calculó."""

    record: BillingRecord
    huella: str


# ─── Formato de los valores ────────────────────────


def format_amount(value: Decimal) -> str:
    """Importe con punto decimal y exactamente 2 decimales (`1234.50`, `-12.35`).

    La AEAT admite uno o dos decimales en la huella («123.1» y «123.10» son válidos),
    pero el valor tiene que coincidir con el del XML, así que fijamos siempre dos.
    No redondeamos: si llega un importe con más decimales es un error de cálculo aguas
    arriba y preferimos que falle a firmar un importe distinto al facturado.
    """
    if not value.is_finite():
        raise ValueError(f"Importe no válido: {value}")
    quantized = value.quantize(_TWO_PLACES)
    if quantized != value:
        raise ValueError(f"El importe {value} tiene más de 2 decimales.")
    if quantized == 0:
        quantized = abs(quantized)  # evita «-0.00»
    return f"{quantized:.2f}"


def format_date(value: date) -> str:
    """Fecha de expedición en el formato del XML VERI*FACTU: `DD-MM-AAAA`."""
    return value.strftime("%d-%m-%Y")


def format_timestamp(value: datetime) -> str:
    """FechaHoraHusoGenRegistro en ISO 8601 con huso: `2024-01-01T19:20:30+01:00`.

    Se exige un `datetime` con zona horaria porque sin huso la cadena no es válida; los
    microsegundos se descartan (el formato del XML va al segundo).
    """
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("La fecha y hora de generación del registro debe llevar zona horaria.")
    return value.isoformat(timespec="seconds")


def _value(raw: str | None) -> str:
    # La especificación pide quitar los espacios al inicio y al final de cada valor;
    # un campo ausente o vacío se representa como «nombre=» sin valor.
    return (raw or "").strip()


# ─── Huella ────────────────────────────────────────


def hash_input(record: BillingRecord, previous_hash: str | None) -> str:
    """Cadena exacta sobre la que se calcula la huella (útil para depurar con la AEAT)."""
    previous = _value(previous_hash)
    if isinstance(record, InvoiceRecord):
        fields: list[tuple[str, str]] = [
            ("IDEmisorFactura", _value(record.issuer_nif)),
            ("NumSerieFactura", _value(record.invoice_number)),
            ("FechaExpedicionFactura", format_date(record.issue_date)),
            ("TipoFactura", InvoiceType(record.invoice_type).value),
            ("CuotaTotal", format_amount(record.total_tax)),
            ("ImporteTotal", format_amount(record.total_amount)),
            ("Huella", previous),
            ("FechaHoraHusoGenRegistro", format_timestamp(record.generated_at)),
        ]
    else:
        fields = [
            ("IDEmisorFacturaAnulada", _value(record.issuer_nif)),
            ("NumSerieFacturaAnulada", _value(record.invoice_number)),
            ("FechaExpedicionFacturaAnulada", format_date(record.issue_date)),
            ("Huella", previous),
            ("FechaHoraHusoGenRegistro", format_timestamp(record.generated_at)),
        ]
    # Sin URL-encoding: los valores van tal cual aunque contengan «&» o «=»; así lo
    # describe la especificación (concatenación de texto, no una query string).
    return "&".join(f"{name}={value}" for name, value in fields)


def chain_hash(record: BillingRecord, previous_hash: str | None) -> str:
    """Huella SHA-256 (hex en mayúsculas) del registro encadenado a la huella anterior.

    `previous_hash` es None (o vacío) solo para el primer registro del sistema.
    """
    digest = hashlib.sha256(hash_input(record, previous_hash).encode("utf-8"))
    return digest.hexdigest().upper()


def build_chain(
    records: Sequence[BillingRecord], previous_hash: str | None = None
) -> list[ChainedRecord]:
    """Encadena una secuencia de registros a partir de la huella anterior indicada."""
    chained: list[ChainedRecord] = []
    for record in records:
        previous_hash = chain_hash(record, previous_hash)
        chained.append(ChainedRecord(record=record, huella=previous_hash))
    return chained


def verify_chain(records: Sequence[ChainedRecord], previous_hash: str | None = None) -> list[int]:
    """Índices de los registros cuya huella guardada no cuadra con sus datos.

    Cada registro se comprueba contra la huella *guardada* del anterior, de modo que la
    rotura queda localizada: si se alteran los datos del registro i, sale i; si lo que se
    altera es la huella guardada de i, salen i e i+1 (el siguiente apuntaba a la buena).
    Lista vacía = cadena íntegra. `previous_hash` permite verificar un tramo que no
    empieza en el primer registro del sistema.

    Ojo: quien pueda reescribir los datos *y* recalcular todas las huellas siguientes
    pasa esta comprobación; frente a eso protegen la copia remitida a la AEAT y la
    firma de los registros, no este cálculo.
    """
    broken: list[int] = []
    for index, chained in enumerate(records):
        if chain_hash(chained.record, previous_hash) != chained.huella.strip().upper():
            broken.append(index)
        previous_hash = chained.huella
    return broken
