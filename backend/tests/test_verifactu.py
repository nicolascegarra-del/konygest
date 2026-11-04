"""Núcleo VERI*FACTU: huella encadenada, URL y QR tributario, envío desactivado.

Los vectores `AEAT_*` son los ejemplos del apartado 6 del documento de la AEAT
«Detalle de las especificaciones técnicas para generación de la huella o hash de los
registros de facturación», versión 0.1.2 (27/08/2024). Funciones puras: sin BD.
"""

from dataclasses import replace
from datetime import UTC, date, datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.modules.verifactu.hashing import (
    CancellationRecord,
    ChainedRecord,
    InvoiceRecord,
    InvoiceType,
    build_chain,
    chain_hash,
    format_amount,
    format_date,
    format_timestamp,
    hash_input,
    verify_chain,
)
from app.modules.verifactu.qr import (
    QREnvironment,
    qr_png,
    qr_svg,
    qr_url,
)
from app.modules.verifactu.sender import DisabledSender, SendStatus, VerifactuSender

CET = timezone(timedelta(hours=1))

AEAT_HASH_1 = "3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60"
AEAT_HASH_2 = "F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97"
AEAT_HASH_3 = "177547C0D57AC74748561D054A9CEC14B4C4EA23D1BEFD6F2E69E3A388F90C68"

AEAT_ALTA_1 = InvoiceRecord(
    issuer_nif="89890001K",
    invoice_number="12345678/G33",
    issue_date=date(2024, 1, 1),
    invoice_type=InvoiceType.F1,
    total_tax=Decimal("12.35"),
    total_amount=Decimal("123.45"),
    generated_at=datetime(2024, 1, 1, 19, 20, 30, tzinfo=CET),
)
AEAT_ALTA_2 = replace(
    AEAT_ALTA_1,
    invoice_number="12345679/G34",
    generated_at=datetime(2024, 1, 1, 19, 20, 35, tzinfo=CET),
)
AEAT_ANULACION_3 = CancellationRecord(
    issuer_nif="89890001K",
    invoice_number="12345679/G34",
    issue_date=date(2024, 1, 1),
    generated_at=datetime(2024, 1, 1, 19, 20, 40, tzinfo=CET),
)


def _invoices(count: int) -> list[InvoiceRecord]:
    start = datetime(2026, 11, 3, 9, 0, tzinfo=CET)
    return [
        replace(
            AEAT_ALTA_1,
            invoice_number=f"FA-2026-{n:04d}",
            issue_date=date(2026, 11, 3),
            generated_at=start + timedelta(minutes=n),
        )
        for n in range(1, count + 1)
    ]


# ─── Vectores oficiales de la AEAT ─────────────────


def test_hash_input_cuando_primer_alta_aeat_entonces_cadena_exacta_con_huella_vacia():
    assert hash_input(AEAT_ALTA_1, None) == (
        "IDEmisorFactura=89890001K&NumSerieFactura=12345678/G33"
        "&FechaExpedicionFactura=01-01-2024&TipoFactura=F1&CuotaTotal=12.35"
        "&ImporteTotal=123.45&Huella=&FechaHoraHusoGenRegistro=2024-01-01T19:20:30+01:00"
    )


def test_chain_hash_cuando_caso1_aeat_primer_registro_entonces_coincide_con_vector():
    assert chain_hash(AEAT_ALTA_1, None) == AEAT_HASH_1
    assert chain_hash(AEAT_ALTA_1, "") == AEAT_HASH_1


def test_chain_hash_cuando_caso2_aeat_alta_encadenada_entonces_coincide_con_vector():
    assert chain_hash(AEAT_ALTA_2, AEAT_HASH_1) == AEAT_HASH_2


def test_chain_hash_cuando_caso3_aeat_anulacion_entonces_coincide_con_vector():
    assert hash_input(AEAT_ANULACION_3, AEAT_HASH_2) == (
        "IDEmisorFacturaAnulada=89890001K&NumSerieFacturaAnulada=12345679/G34"
        f"&FechaExpedicionFacturaAnulada=01-01-2024&Huella={AEAT_HASH_2}"
        "&FechaHoraHusoGenRegistro=2024-01-01T19:20:40+01:00"
    )
    assert chain_hash(AEAT_ANULACION_3, AEAT_HASH_2) == AEAT_HASH_3


def test_build_chain_cuando_tres_registros_aeat_entonces_reproduce_los_tres_vectores():
    chain = build_chain([AEAT_ALTA_1, AEAT_ALTA_2, AEAT_ANULACION_3])
    assert [c.huella for c in chain] == [AEAT_HASH_1, AEAT_HASH_2, AEAT_HASH_3]
    assert verify_chain(chain) == []


def test_chain_hash_cuando_valores_con_espacios_entonces_se_recortan():
    padded = replace(AEAT_ALTA_1, issuer_nif=" 89890001K ", invoice_number="  12345678/G33  ")
    assert chain_hash(padded, None) == AEAT_HASH_1


def test_chain_hash_cuando_cualquier_caso_entonces_64_hex_mayusculas():
    huella = chain_hash(_invoices(1)[0], None)
    assert len(huella) == 64
    assert huella == huella.upper()
    int(huella, 16)


# ─── Encadenamiento y manipulaciones ───────────────


def test_build_chain_cuando_varios_registros_entonces_cada_uno_usa_la_huella_anterior():
    records = _invoices(4)
    chain = build_chain(records)
    previous = None
    for chained in chain:
        assert chained.huella == chain_hash(chained.record, previous)
        previous = chained.huella
    assert len({c.huella for c in chain}) == 4


def test_build_chain_cuando_huella_anterior_dada_entonces_continua_la_cadena():
    first = build_chain(_invoices(2))
    rest = build_chain(_invoices(5)[2:], previous_hash=first[-1].huella)
    assert build_chain(_invoices(5)) == first + rest
    assert verify_chain(rest, previous_hash=first[-1].huella) == []
    assert verify_chain(rest) == [0]


@pytest.mark.parametrize(
    "changes",
    [
        {"issuer_nif": "B12345678"},
        {"invoice_number": "FA-2026-9999"},
        {"issue_date": date(2026, 11, 4)},
        {"invoice_type": InvoiceType.R1},
        {"total_tax": Decimal("12.36")},
        {"total_amount": Decimal("123.46")},
        {"generated_at": datetime(2026, 11, 3, 9, 2, 1, tzinfo=CET)},
    ],
)
def test_verify_chain_cuando_se_altera_un_campo_intermedio_entonces_rompe_desde_ahi(changes):
    chain = build_chain(_invoices(5))
    tampered = list(chain)
    tampered[2] = ChainedRecord(record=replace(chain[2].record, **changes), huella=chain[2].huella)
    broken = verify_chain(tampered)
    assert broken
    assert broken[0] == 2  # los anteriores siguen siendo íntegros


def test_verify_chain_cuando_se_altera_la_huella_guardada_entonces_rompe_ese_y_el_siguiente():
    chain = build_chain(_invoices(5))
    tampered = list(chain)
    tampered[2] = replace(chain[2], huella="0" * 64)
    assert verify_chain(tampered) == [2, 3]


def test_verify_chain_cuando_se_borra_un_registro_entonces_rompe_en_el_hueco():
    chain = build_chain(_invoices(5))
    assert verify_chain(chain[:2] + chain[3:]) == [2]


def test_verify_chain_cuando_se_reordenan_registros_entonces_detecta_la_rotura():
    chain = build_chain(_invoices(4))
    assert verify_chain([chain[0], chain[2], chain[1], chain[3]]) == [1, 2, 3]


def test_verify_chain_cuando_cadena_mixta_alta_y_anulacion_entonces_integra():
    records = _invoices(2)
    cancel = CancellationRecord(
        issuer_nif=records[1].issuer_nif,
        invoice_number=records[1].invoice_number,
        issue_date=records[1].issue_date,
        generated_at=records[1].generated_at + timedelta(hours=1),
    )
    assert verify_chain(build_chain([*records, cancel])) == []


# ─── Formatos ──────────────────────────────────────


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (Decimal("123.45"), "123.45"),
        (Decimal("123.1"), "123.10"),
        (Decimal("7"), "7.00"),
        (Decimal("0"), "0.00"),
        (Decimal("-0.00"), "0.00"),
        (Decimal("-12.35"), "-12.35"),
        (Decimal("-1234567.5"), "-1234567.50"),
        (Decimal("1234567890.00"), "1234567890.00"),
    ],
)
def test_format_amount_cuando_decimal_entonces_dos_decimales_con_punto(value, expected):
    assert format_amount(value) == expected


def test_format_amount_cuando_mas_de_dos_decimales_entonces_error_sin_redondear():
    with pytest.raises(ValueError):
        format_amount(Decimal("1.005"))
    with pytest.raises(ValueError):
        format_amount(Decimal("NaN"))


def test_chain_hash_cuando_rectificativa_negativa_entonces_importes_con_signo():
    rectificativa = replace(
        AEAT_ALTA_1,
        invoice_type=InvoiceType.R4,
        total_tax=Decimal("-2.1"),
        total_amount=Decimal("-12.10"),
    )
    cadena = hash_input(rectificativa, AEAT_HASH_1)
    assert "&TipoFactura=R4&CuotaTotal=-2.10&ImporteTotal=-12.10&" in cadena


def test_format_date_cuando_fecha_entonces_dd_mm_aaaa():
    assert format_date(date(2026, 3, 5)) == "05-03-2026"


def test_format_timestamp_cuando_con_zona_entonces_iso_con_huso_y_sin_microsegundos():
    value = datetime(2026, 7, 1, 8, 5, 9, 123456, tzinfo=timezone(timedelta(hours=2)))
    assert format_timestamp(value) == "2026-07-01T08:05:09+02:00"
    assert format_timestamp(datetime(2026, 1, 1, tzinfo=UTC)) == "2026-01-01T00:00:00+00:00"


def test_format_timestamp_cuando_sin_zona_entonces_error():
    with pytest.raises(ValueError):
        format_timestamp(datetime(2026, 1, 1, 10, 0))


# ─── QR ────────────────────────────────────────────


def test_qr_url_cuando_ejemplo_aeat_con_ampersand_entonces_codifica_como_en_la_especificacion():
    url = qr_url("89890001K", "12345678&G33", date(2024, 1, 1), Decimal("241.4"))
    assert url == (
        "https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR"
        "?nif=89890001K&numserie=12345678%26G33&fecha=01-01-2024&importe=241.40"
    )


def test_qr_url_cuando_produccion_entonces_dominio_de_produccion():
    url = qr_url(
        "89890001K",
        "12345678-G33",
        date(2024, 9, 1),
        Decimal("241.4"),
        environment=QREnvironment.PRODUCTION,
    )
    assert url == (
        "https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR"
        "?nif=89890001K&numserie=12345678-G33&fecha=01-09-2024&importe=241.40"
    )


def test_qr_url_cuando_no_verifactu_entonces_servicio_no_verifactu():
    url = qr_url("89890001K", "A1", date(2024, 1, 1), Decimal("1"), verifactu=False)
    assert url.startswith("https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQRNoVerifactu?")


def test_qr_url_cuando_caracteres_especiales_en_numserie_entonces_url_encoded():
    url = qr_url("89890001K", "FA 2026/1?=+#%", date(2026, 11, 3), Decimal("-50.5"))
    assert "&numserie=FA%202026%2F1%3F%3D%2B%23%25&" in url
    assert url.endswith("&importe=-50.50")


def test_qr_url_cuando_numserie_no_ascii_o_largo_entonces_error():
    with pytest.raises(ValueError):
        qr_url("89890001K", "FACTURA-Ñ1", date(2026, 1, 1), Decimal("1"))
    with pytest.raises(ValueError):
        qr_url("89890001K", "X" * 61, date(2026, 1, 1), Decimal("1"))


def test_qr_url_cuando_nif_o_importe_invalidos_entonces_error():
    with pytest.raises(ValueError):
        qr_url("891K", "A1", date(2026, 1, 1), Decimal("1"))
    with pytest.raises(ValueError):
        qr_url("89890001K", "A1", date(2026, 1, 1), Decimal("1234567890123"))


def test_qr_png_cuando_url_entonces_png_valido_y_nivel_m():
    import segno

    url = qr_url("89890001K", "12345678&G33", date(2024, 1, 1), Decimal("241.4"))
    png = qr_png(url)
    assert png.startswith(b"\x89PNG\r\n\x1a\n")
    assert b"pHYs" in png  # DPI guardados para que imprima al tamaño indicado
    assert segno.make_qr(url, error="m", boost_error=False).error == "M"


def test_qr_svg_cuando_url_entonces_svg_en_milimetros():
    url = qr_url("89890001K", "12345678&G33", date(2024, 1, 1), Decimal("241.4"))
    svg = qr_svg(url, size_mm=40)
    assert svg.startswith("<svg")
    assert 'width="' in svg and 'mm"' in svg


def test_qr_svg_cuando_tamano_fuera_de_30_40_mm_entonces_error():
    with pytest.raises(ValueError):
        qr_svg("https://example.org", size_mm=25)
    with pytest.raises(ValueError):
        qr_png("https://example.org", size_mm=45)


# ─── Envío ─────────────────────────────────────────


def test_disabled_sender_cuando_envia_entonces_no_enviado_por_modulo_desactivado():
    sender: VerifactuSender = DisabledSender()
    result = sender.send(build_chain(_invoices(3)))
    assert result.status == SendStatus.NOT_SENT
    assert not result.sent
    assert "desactivado" in result.message
