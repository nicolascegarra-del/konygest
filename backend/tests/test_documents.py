"""Documentos: almacenamiento (local y S3 simulado) y plantillas/PDF de orden de carga y albarán.

Los tests de PDF real se saltan si WeasyPrint no puede cargar sus librerías nativas
(Windows sin GTK); en CI (Ubuntu con Pango) se ejecutan. Los de HTML corren siempre.
"""

import io
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import pytest
from botocore.exceptions import ClientError

from app.modules.documents import PdfUnavailableError, render_delivery_note, render_loading_order
from app.modules.documents import storage as public_storage
from app.modules.documents.pdf import (
    format_date,
    format_kg,
    format_time,
    render_delivery_note_html,
    render_loading_order_html,
)
from app.modules.documents.storage import (
    InvalidStorageKeyError,
    LocalStorage,
    S3Storage,
    build_storage,
    validate_key,
)
from app.modules.documents.types import (
    CompanyInfo,
    DeliveryNoteData,
    DocLine,
    LoadingOrderData,
    LoadingOrderStop,
    PartyInfo,
    TransportInfo,
)

KEY = "6f1c2d3e-0000-4000-8000-000000000001/albaranes/ALB-2026-0001.pdf"

# ─── Datos de ejemplo ──────────────────────────────────────────────────────────

COMPANY = CompanyInfo(
    name="Piensos del Norte S.L.",
    tax_id="B12345678",
    address="Polígono Industrial 3, 50001 Zaragoza",
    registration="αES50001234",
)
TRANSPORT = TransportInfo(
    truck_plate="1234-BCD", carrier_name="Transportes Ebro", driver_name="Juan Pérez"
)
PARTY_1 = PartyInfo(
    customer_code="C0001",
    customer_name="Granja Los Olivos",
    customer_tax_id="B87654321",
    farm_name="Los Olivos 1",
    farm_rega="ES501230000123",
    farm_address="Camino del Monte s/n, Ejea",
)
PARTY_2 = PartyInfo(
    customer_code="C0002",
    customer_name="Porcino Ribera",
    customer_tax_id=None,
    farm_name="La Ribera",
    farm_rega="ES501230000456",
)


def loading_order(**overrides: Any) -> LoadingOrderData:
    values: dict[str, Any] = {
        "company": COMPANY,
        "number": "CAR-2026-0001",
        "load_date": date(2026, 11, 5),
        "transport": TRANSPORT,
        "compartments_kg": [6000.0, 7000.0, 8000.0, 5000.0],
        "stops": [
            LoadingOrderStop(
                sequence=2,
                order_number="PED-2026-0002",
                party=PARTY_2,
                lines=[DocLine("P200", "Cebo cerdos", Decimal("4000"), 3, "S1")],
            ),
            LoadingOrderStop(
                sequence=1,
                order_number="PED-2026-0001",
                party=PARTY_1,
                lines=[
                    DocLine("P100", "Lechones inicio", Decimal("6000"), 1, "S2", "L-77", "F3"),
                    DocLine("P101", "Lechones crecimiento", Decimal("6500"), 2, "S3"),
                ],
            ),
        ],
        "notes": "Entrar por la puerta trasera",
    }
    values.update(overrides)
    return LoadingOrderData(**values)


def delivery_note(**overrides: Any) -> DeliveryNoteData:
    values: dict[str, Any] = {
        "company": COMPANY,
        "number": "ALB-2026-0001",
        # 08:30 UTC → 09:30 en Madrid (horario de invierno)
        "issued_at": datetime(2026, 11, 5, 8, 30, tzinfo=UTC),
        "load_number": "CAR-2026-0001",
        "order_number": "PED-2026-0001",
        "party": PARTY_1,
        "transport": TRANSPORT,
        "lines": [
            DocLine("P100", "Lechones inicio", Decimal("5980"), 1, "S2", "L-77", "F3"),
            DocLine("P101", "Lechones crecimiento", Decimal("6520"), 2, "S3", "L-78"),
        ],
        "gross_kg": Decimal("38420"),
        "tare_kg": Decimal("14200"),
        "notes": "Descargar con cuidado",
    }
    values.update(overrides)
    return DeliveryNoteData(**values)


def pdf_or_skip(render, data) -> bytes:
    try:
        return render(data)
    except PdfUnavailableError as exc:
        pytest.skip(f"WeasyPrint no disponible en este entorno: {exc}")


def pdf_text(pdf: bytes) -> str:
    from pypdf import PdfReader

    return "\n".join(page.extract_text() for page in PdfReader(io.BytesIO(pdf)).pages)


# ─── Claves ────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "key",
    [
        "",
        "/abs/fichero.pdf",
        "\\abs\\fichero.pdf",
        "tenant/../otro/fichero.pdf",
        "..",
        "tenant/./fichero.pdf",
        "tenant//fichero.pdf",
        "tenant/fichero.pdf/",
        "tenant\\..\\fichero.pdf",
        "tenant/fich ero.pdf",
        "C:/windows/fichero.pdf",
        "tenant/.oculto",
    ],
)
def test_validate_key_cuando_clave_peligrosa_entonces_rechaza(key):
    with pytest.raises(InvalidStorageKeyError):
        validate_key(key)


def test_validate_key_cuando_clave_normal_entonces_la_acepta():
    assert validate_key(KEY) == KEY
    assert validate_key("t/cargas/CAR-2026-0001_v2.pdf")


# ─── Almacenamiento local ──────────────────────────────────────────────────────


def test_local_storage_guarda_lee_y_existe(tmp_path):
    store = LocalStorage(tmp_path)
    assert not store.exists(KEY)
    store.save(KEY, b"%PDF-1.7 hola", "application/pdf")
    assert store.exists(KEY)
    assert store.load(KEY) == b"%PDF-1.7 hola"
    assert (tmp_path / KEY).read_bytes() == b"%PDF-1.7 hola"
    # Sobrescribir reemplaza el contenido y no deja temporales
    store.save(KEY, b"nuevo", "application/pdf")
    assert store.load(KEY) == b"nuevo"
    assert [p.name for p in (tmp_path / KEY).parent.iterdir()] == ["ALB-2026-0001.pdf"]


def test_local_storage_cuando_no_existe_entonces_file_not_found(tmp_path):
    store = LocalStorage(tmp_path)
    with pytest.raises(FileNotFoundError):
        store.load(KEY)


def test_local_storage_cuando_clave_con_puntos_entonces_no_sale_de_la_carpeta(tmp_path):
    store = LocalStorage(tmp_path / "raiz")
    with pytest.raises(InvalidStorageKeyError):
        store.save("../fuera.pdf", b"x", "application/pdf")
    with pytest.raises(InvalidStorageKeyError):
        store.load("a/../../fuera.pdf")
    with pytest.raises(InvalidStorageKeyError):
        store.exists("/etc/passwd")
    assert not (tmp_path / "fuera.pdf").exists()


def test_storage_publico_usa_local_en_tests(tmp_path):
    """conftest fija STORAGE_BACKEND=local en una carpeta temporal."""
    public_storage.reset()
    assert isinstance(public_storage.backend, LocalStorage)
    public_storage.save("t/prueba/x.txt", b"hola", "text/plain")
    assert public_storage.exists("t/prueba/x.txt")
    assert public_storage.load("t/prueba/x.txt") == b"hola"


def test_build_storage_cuando_backend_s3_entonces_configura_minio(monkeypatch):
    from app.core.config import get_settings

    monkeypatch.setenv("STORAGE_BACKEND", "s3")
    monkeypatch.setenv("MINIO_ENDPOINT", "minio:9000")
    monkeypatch.setenv("MINIO_ACCESS_KEY", "clave")
    monkeypatch.setenv("MINIO_SECRET_KEY", "secreto")
    monkeypatch.setenv("MINIO_BUCKET_NAME", "docs")
    monkeypatch.setenv("MINIO_SECURE", "true")
    get_settings.cache_clear()
    try:
        backend = build_storage()
        assert isinstance(backend, S3Storage)
        assert backend.bucket == "docs"
        assert backend.client.meta.endpoint_url == "https://minio:9000"
    finally:
        get_settings.cache_clear()


# ─── Almacenamiento S3 (cliente simulado) ──────────────────────────────────────


class FakeS3:
    """Lo mínimo de la API de boto3 que usa S3Storage, en memoria."""

    def __init__(self, buckets: tuple[str, ...] = ()) -> None:
        self.buckets: dict[str, dict[str, tuple[bytes, str]]] = {b: {} for b in buckets}
        self.calls: list[str] = []

    @staticmethod
    def _error(code: str, op: str) -> ClientError:
        return ClientError({"Error": {"Code": code, "Message": code}}, op)

    def head_bucket(self, Bucket):  # noqa: N803 - nombres de boto3
        self.calls.append("head_bucket")
        if Bucket not in self.buckets:
            raise self._error("404", "HeadBucket")

    def create_bucket(self, Bucket):  # noqa: N803
        self.calls.append("create_bucket")
        self.buckets[Bucket] = {}

    def put_object(self, Bucket, Key, Body, ContentType):  # noqa: N803
        self.buckets[Bucket][Key] = (Body, ContentType)

    def get_object(self, Bucket, Key):  # noqa: N803
        if Key not in self.buckets[Bucket]:
            raise self._error("NoSuchKey", "GetObject")
        return {"Body": io.BytesIO(self.buckets[Bucket][Key][0])}

    def head_object(self, Bucket, Key):  # noqa: N803
        if Key not in self.buckets[Bucket]:
            raise self._error("404", "HeadObject")
        return {}


def test_s3_storage_crea_bucket_y_guarda_lee():
    fake = FakeS3()
    store = S3Storage("konygest", client=fake)
    assert not store.exists(KEY)
    store.save(KEY, b"%PDF", "application/pdf")
    assert store.exists(KEY)
    assert store.load(KEY) == b"%PDF"
    assert fake.buckets["konygest"][KEY] == (b"%PDF", "application/pdf")
    # El bucket se comprueba y se crea una sola vez
    assert fake.calls == ["head_bucket", "create_bucket"]


def test_s3_storage_cuando_bucket_existe_no_lo_crea():
    fake = FakeS3(buckets=("konygest",))
    S3Storage("konygest", client=fake).save(KEY, b"x", "application/pdf")
    assert fake.calls == ["head_bucket"]


def test_s3_storage_cuando_no_existe_entonces_file_not_found():
    store = S3Storage("konygest", client=FakeS3(buckets=("konygest",)))
    with pytest.raises(FileNotFoundError):
        store.load(KEY)


def test_s3_storage_cuando_clave_con_puntos_entonces_rechaza():
    fake = FakeS3(buckets=("konygest",))
    with pytest.raises(InvalidStorageKeyError):
        S3Storage("konygest", client=fake).save("../x.pdf", b"x", "application/pdf")
    assert fake.buckets["konygest"] == {}


def test_s3_storage_cuando_error_distinto_entonces_lo_propaga():
    class Denied(FakeS3):
        def head_bucket(self, Bucket):  # noqa: N803
            raise self._error("403", "HeadBucket")

    with pytest.raises(ClientError):
        S3Storage("konygest", client=Denied()).exists(KEY)


# ─── Formato ───────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (Decimal("12500"), "12.500 kg"),
        (Decimal("12500.000"), "12.500 kg"),
        (12500.5, "12.500,5 kg"),
        (Decimal("1234567.25"), "1.234.567,25 kg"),
        (0, "0 kg"),
        (None, ""),
    ],
)
def test_format_kg_formato_espanol(value, expected):
    assert format_kg(value) == expected


def test_format_fecha_y_hora_en_madrid():
    assert format_date(date(2026, 1, 9)) == "09/01/2026"
    # Verano: UTC+2
    assert format_time(datetime(2026, 7, 1, 22, 15, tzinfo=UTC)) == "00:15"
    assert format_date(datetime(2026, 7, 1, 22, 15, tzinfo=UTC)) == "02/07/2026"
    # Sin zona se interpreta como UTC
    assert format_time(datetime(2026, 11, 5, 8, 30)) == "09:30"


# ─── Plantillas HTML (sin WeasyPrint) ──────────────────────────────────────────


def test_html_orden_de_carga_muestra_los_datos():
    html = render_loading_order_html(loading_order())
    for text in [
        "Orden de carga",
        "CAR-2026-0001",
        "05/11/2026",
        "Piensos del Norte S.L.",
        "B12345678",
        "αES50001234",
        "1234-BCD",
        "Transportes Ebro",
        "Juan Pérez",
        "Granja Los Olivos",
        "ES501230000123",
        "PED-2026-0001",
        "Lechones crecimiento",
        "6.500 kg",
        "16.500 kg",  # total
        "26.000 kg",  # capacidad
        "Vacío",  # compartimento 4
        "L-77",
        "Entrar por la puerta trasera",
        "Cargado por",
    ]:
        assert text in html, text
    # Paradas en orden de descarga aunque lleguen desordenadas
    assert html.index("PED-2026-0001") < html.index("PED-2026-0002")


def test_html_albaran_muestra_los_datos():
    html = render_delivery_note_html(delivery_note())
    for text in [
        "Albarán",
        "ALB-2026-0001",
        "05/11/2026",
        "09:30",
        "CAR-2026-0001",
        "PED-2026-0001",
        "B87654321",
        "Los Olivos 1",
        "ES501230000123",
        "Camino del Monte s/n, Ejea",
        "L-78",
        "12.500 kg",  # total
        "38.420 kg",
        "14.200 kg",
        "24.220 kg",  # neto
        "Descargar con cuidado",
        "DNI",
        "Recibí",
    ]:
        assert text in html, text


def test_html_albaran_sin_pesada_no_muestra_bloque():
    html = render_delivery_note_html(delivery_note(gross_kg=None, tare_kg=None, notes=""))
    assert "Peso bruto" not in html
    assert "Observaciones" not in html


def test_html_escapa_el_contenido():
    evil = "<script>alert('x')</script> & Cía"
    party = PartyInfo("C9", evil, None, f"Granja {evil}")
    html_note = render_delivery_note_html(delivery_note(party=party, notes=evil))
    order = loading_order(
        company=CompanyInfo(name=evil),
        stops=[LoadingOrderStop(1, "PED-1", party, [DocLine("X", evil, Decimal(1), 1)])],
    )
    html_order = render_loading_order_html(order)
    for html in (html_note, html_order):
        assert "<script>" not in html
        assert "&lt;script&gt;" in html
        assert "&amp; Cía" in html


# ─── PDF real (WeasyPrint) ─────────────────────────────────────────────────────


def test_pdf_orden_de_carga():
    pdf = pdf_or_skip(render_loading_order, loading_order())
    assert pdf.startswith(b"%PDF")
    text = pdf_text(pdf)
    for expected in ["CAR-2026-0001", "Granja Los Olivos", "1234-BCD", "16.500 kg", "Página 1"]:
        assert expected in text, expected


def test_pdf_albaran_cabe_en_una_pagina():
    from pypdf import PdfReader

    pdf = pdf_or_skip(render_delivery_note, delivery_note())
    assert pdf.startswith(b"%PDF")
    assert len(PdfReader(io.BytesIO(pdf)).pages) == 1
    text = pdf_text(pdf)
    for expected in ["ALB-2026-0001", "ES501230000123", "24.220 kg", "09:30"]:
        assert expected in text, expected


def test_pdf_con_contenido_malicioso_se_genera_escapado():
    evil = "<script>alert(1)</script>"
    party = PartyInfo("C9", evil, None, "Granja")
    pdf = pdf_or_skip(render_delivery_note, delivery_note(party=party, notes=evil))
    assert pdf.startswith(b"%PDF")
    assert "<script>alert(1)</script>" in pdf_text(pdf)  # se pinta como texto
