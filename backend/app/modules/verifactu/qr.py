"""Código QR tributario de las facturas VERI*FACTU.

Sigue el documento de la AEAT «Detalle de las especificaciones técnicas del código QR
de la factura y de la URL del servicio de cotejo o remisión de información por parte del
receptor de la factura» (versión 0.5.0, 10/12/2025) y los artículos 20 y 21 de la Orden
HAC/1177/2024:

- La URL lleva solo cuatro parámetros: `nif`, `numserie`, `fecha` (DD-MM-AAAA) e
  `importe` (punto decimal, hasta 12 dígitos enteros y 2 decimales), con los valores
  URL-encoded en UTF-8 (un `&` en el número de serie va como `%26`).
- El QR sigue ISO/IEC 18004:2015 con nivel de corrección de errores M, mide entre 30x30
  y 40x40 mm y deja al menos 2 mm en blanco alrededor (se recomiendan 6 mm).
- Encima del QR va «QR tributario:» y debajo «VERI*FACTU» o «Factura verificable en la
  sede electrónica de la AEAT», con letra igual o mayor que el resto de la factura. La
  maquetación es cosa de la plantilla del PDF; aquí solo se exponen los textos.
"""

import io
from datetime import date
from decimal import Decimal
from enum import StrEnum
from urllib.parse import quote

import segno

from app.modules.verifactu.hashing import format_amount, format_date

QR_HEADER = "QR tributario:"
VERIFACTU_LABEL = "VERI*FACTU"
VERIFACTU_LONG_LABEL = "Factura verificable en la sede electrónica de la AEAT"

# Tamaño del lado del QR (sin la zona en blanco) permitido por el art. 21.1 de la orden.
MIN_SIZE_MM = 30
MAX_SIZE_MM = 40
DEFAULT_SIZE_MM = 35
_MM_PER_INCH = Decimal("25.4")
# Zona en blanco de 4 módulos que pide ISO/IEC 18004. Con un QR de 30-40 mm son unos
# 3-4 mm, por encima del mínimo de 2 mm; el margen recomendado de 6 mm lo pone el PDF.
QUIET_ZONE_MODULES = 4
_MAX_NUMSERIE = 60
_MAX_INTEGER_DIGITS = 12


class QREnvironment(StrEnum):
    TEST = "test"  # Portal de Pruebas Externas de la AEAT
    PRODUCTION = "production"


_BASE_URLS: dict[tuple[QREnvironment, bool], str] = {
    (QREnvironment.TEST, True): "https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR",
    (QREnvironment.PRODUCTION, True): (
        "https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR"
    ),
    (QREnvironment.TEST, False): "https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQRNoVerifactu",
    (QREnvironment.PRODUCTION, False): (
        "https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQRNoVerifactu"
    ),
}


def _encode(value: str) -> str:
    # `safe=""` codifica también «/», «&», «=», «?» y «+». Espacio → «%20».
    # VERIFICAR: el ejemplo Java del documento (apartado 4.1) es una imagen que no hemos
    # podido leer; si usa URLEncoder, el espacio sería «+». Ambos se decodifican igual
    # en el servidor, pero conviene confirmarlo con el portal de pruebas.
    return quote(value, safe="", encoding="utf-8")


def _validate_numserie(value: str) -> str:
    value = value.strip()
    if not value or len(value) > _MAX_NUMSERIE:
        raise ValueError(f"El número de serie debe tener entre 1 y {_MAX_NUMSERIE} caracteres.")
    if any(not 32 <= ord(char) <= 126 for char in value):
        # La AEAT responde 2003 («caracteres no permitidos») fuera de ASCII imprimible.
        raise ValueError("El número de serie solo puede contener caracteres ASCII imprimibles.")
    return value


def qr_url(
    nif: str,
    invoice_number: str,
    issue_date: date,
    total_amount: Decimal,
    environment: QREnvironment = QREnvironment.TEST,
    verifactu: bool = True,
) -> str:
    """URL de cotejo que va dentro del QR.

    Por defecto apunta al entorno de pruebas: producción hay que pedirla explícitamente
    para que una configuración olvidada nunca genere QR «reales» desde desarrollo.
    """
    nif = nif.strip()
    if len(nif) != 9:
        raise ValueError("El NIF del emisor debe tener 9 caracteres.")
    amount = format_amount(total_amount)
    if len(amount.lstrip("-").split(".")[0]) > _MAX_INTEGER_DIGITS:
        raise ValueError(f"El importe supera los {_MAX_INTEGER_DIGITS} dígitos enteros.")
    params = {
        "nif": nif,
        "numserie": _validate_numserie(invoice_number),
        "fecha": format_date(issue_date),
        # VERIFICAR: siempre 2 decimales («241.40»); los ejemplos de la AEAT usan «241.4»
        # y el formato dice «NNNNNNNNN.DD», así que ambos deberían aceptarse.
        "importe": amount,
    }
    query = "&".join(f"{name}={_encode(value)}" for name, value in params.items())
    return f"{_BASE_URLS[(environment, verifactu)]}?{query}"


def _make(url: str) -> segno.QRCode:
    # `boost_error=False`: segno subiría el nivel si cabe en la misma versión, y la
    # orden fija el nivel M.
    return segno.make_qr(url, error="m", boost_error=False)


def _check_size(size_mm: float) -> None:
    if not MIN_SIZE_MM <= size_mm <= MAX_SIZE_MM:
        raise ValueError(f"El QR debe medir entre {MIN_SIZE_MM} y {MAX_SIZE_MM} mm.")


def qr_svg(url: str, size_mm: float = DEFAULT_SIZE_MM) -> str:
    """QR en SVG con medidas en milímetros (el lado del código, sin zona en blanco)."""
    _check_size(size_mm)
    qr = _make(url)
    modules, _ = qr.symbol_size(scale=1, border=0)
    buffer = io.BytesIO()
    qr.save(
        buffer,
        kind="svg",
        scale=size_mm / modules,
        unit="mm",
        border=QUIET_ZONE_MODULES,
        xmldecl=False,
    )
    return buffer.getvalue().decode("utf-8")


def qr_png(url: str, size_mm: float = DEFAULT_SIZE_MM, min_dpi: int = 300) -> bytes:
    """QR en PNG que mide `size_mm` al imprimirse según los DPI guardados en el fichero.

    Se usa un número entero de píxeles por módulo (sin interpolación, bordes nítidos) y
    se ajustan los DPI del fichero para que el tamaño físico sea exacto.
    """
    _check_size(size_mm)
    qr = _make(url)
    modules, _ = qr.symbol_size(scale=1, border=0)
    size_inches = Decimal(str(size_mm)) / _MM_PER_INCH
    scale = max(1, -(-int(size_inches * min_dpi) // modules))  # techo de la división
    dpi = round(modules * scale / size_inches)
    buffer = io.BytesIO()
    qr.save(buffer, kind="png", scale=scale, border=QUIET_ZONE_MODULES, dpi=dpi)
    return buffer.getvalue()
