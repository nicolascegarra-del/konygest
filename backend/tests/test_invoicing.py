"""Facturación: borradores desde pedidos entregados (kg reales, IVA, recargo, redondeos),
emisión con número y registro Verifactu encadenado, abonos, anulación, PDF, permisos,
aislamiento entre empresas, pendiente de facturar, resumen del mes y avisos."""

import os
import threading
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import UUID

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError
from sqlmodel import col, select

from app.core.db import new_session
from app.core.deps import load_current_user
from app.modules import documents
from app.modules.invoicing import service
from app.modules.invoicing.models import Invoice, VerifactuRecord
from app.modules.logistics.models import Load, LoadItem, LoadStatus, LoadStop
from app.modules.masters.models import (
    Customer,
    Farm,
    Item,
    ItemKind,
    PaymentMethod,
    Truck,
    VatRate,
)
from app.modules.notifications.models import Notification
from app.modules.orders.models import Order, OrderLine, OrderStatus, PriceSource
from app.modules.orders.service import today_madrid
from app.modules.platform.models import AuditLog
from app.modules.tenants.models import Tenant
from app.modules.verifactu import qr
from app.modules.verifactu.hashing import ChainedRecord, verify_chain
from tests.conftest import auth, get_user, invite_user

API = "/api/v1/invoices"
TODAY = today_madrid()
YEAR = TODAY.year
NIF = "B30123456"


class MemoryStorage:
    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}

    def save(self, key: str, data: bytes, content_type: str) -> None:
        self.files[key] = data

    def load(self, key: str) -> bytes:
        return self.files[key]

    def exists(self, key: str) -> bool:
        return key in self.files

    def delete(self, key: str) -> None:
        self.files.pop(key, None)


@pytest.fixture(autouse=True)
def fake_documents(monkeypatch) -> Iterator[list]:
    """PDF falso: aquí se prueba la facturación, no la plantilla. Devuelve los datos
    con los que se ha pintado cada PDF."""
    rendered: list = []
    documents.storage.reset(MemoryStorage())

    def render(data):
        rendered.append(data)
        return b"%PDF-fake"

    monkeypatch.setattr(documents, "render_invoice", render)
    yield rendered
    documents.storage.reset()


def _unavailable(data):
    raise documents.PdfUnavailableError("sin WeasyPrint")


@dataclass
class Ctx:
    tenant_id: UUID
    admin: dict[str, str]
    ofi: dict[str, str]  # Oficina: emite y abona
    dir: dict[str, str]  # Dirección: solo ve
    com: dict[str, str]  # Comercial: ve las de sus clientes
    ofi_id: UUID
    com_id: UUID
    m: dict[str, UUID]


def _masters(tenant_id: UUID, com_id: UUID) -> dict[str, UUID]:
    with new_session(tenant_id=tenant_id) as db:

        def add(row):
            db.add(row)
            db.flush()
            return row

        t = tenant_id
        v10 = add(
            VatRate(
                tenant_id=t,
                name="IVA 10",
                rate=Decimal(10),
                surcharge=Decimal("1.4"),
                is_default=True,
            )
        )
        v21 = add(VatRate(tenant_id=t, name="IVA 21", rate=Decimal(21), surcharge=Decimal("5.2")))
        pay = add(PaymentMethod(tenant_id=t, name="Recibo 30-60", due_days=[30, 60]))
        ceb = add(
            Item(tenant_id=t, code="P-CEB", name="Cebo", kind=ItemKind.PRODUCT, vat_rate_id=v10.id)
        )
        pre = add(
            Item(
                tenant_id=t,
                code="P-PRE",
                name="Premezcla",
                kind=ItemKind.PRODUCT,
                vat_rate_id=v21.id,
            )
        )
        sin = add(Item(tenant_id=t, code="P-SIN", name="Sin IVA", kind=ItemKind.PRODUCT))
        c1 = add(
            Customer(
                tenant_id=t,
                code="C1",
                name="Granja Los Pinos",
                tax_id="B11111111",
                address="Camino Viejo 1",
                city="Lorca",
                sales_rep_id=com_id,
                payment_method_id=pay.id,
            )
        )
        c2 = add(
            Customer(
                tenant_id=t,
                code="C2",
                name="Tienda Agrícola",
                tax_id="B22222222",
                equivalence_surcharge=True,
            )
        )
        c3 = add(Customer(tenant_id=t, code="C3", name="Sin NIF"))
        farms = {
            c.code: add(Farm(tenant_id=t, customer_id=c.id, name=f"Explotación {c.code}"))
            for c in (c1, c2, c3)
        }
        truck = add(Truck(tenant_id=t, plate="1234KLM", compartments=[8000] * 6))
        db.commit()
        rows = {"v10": v10, "v21": v21, "ceb": ceb, "pre": pre, "sin": sin, "c1": c1}
        rows |= {"c2": c2, "c3": c3, "truck": truck, "pay": pay}
        rows |= {f"f{k[1]}": f for k, f in farms.items()}
        return {k: v.id for k, v in rows.items()}


def set_fiscal(tenant_id: UUID, **values) -> None:
    with new_session(bypass_rls=True) as db:
        tenant = db.get(Tenant, tenant_id)
        assert tenant is not None
        defaults = {"tax_id": NIF, "address": "Polígono Oeste 12", "postal_code": "30169"}
        defaults |= {"city": "Murcia", "province": "Murcia", "legal_name": "Piensos Norte S.L."}
        for key, value in (defaults | values).items():
            setattr(tenant, key, value)
        db.add(tenant)
        db.commit()


def make_ctx(client, make_tenant, name: str = "Piensos Norte") -> Ctx:
    tenant, admin_email = make_tenant(name)
    admin = auth(client, admin_email)
    slug = name.lower().replace(" ", "")
    ofi = invite_user(client, admin, f"oficina@{slug}.es", ["Oficina"])
    dir_ = invite_user(client, admin, f"direccion@{slug}.es", ["Dirección"])
    com = invite_user(client, admin, f"comercial@{slug}.es", ["Comercial"])
    com_id = get_user(f"comercial@{slug}.es").id
    set_fiscal(tenant.id)
    return Ctx(
        tenant_id=tenant.id,
        admin=admin,
        ofi=ofi,
        dir=dir_,
        com=com,
        ofi_id=get_user(f"oficina@{slug}.es").id,
        com_id=com_id,
        m=_masters(tenant.id, com_id),
    )


@pytest.fixture
def ctx(client, make_tenant) -> Ctx:
    return make_ctx(client, make_tenant)


_counter = iter(range(1, 100_000))


def delivered(
    ctx: Ctx,
    customer: str = "c1",
    lines: list[tuple[str, str, list[str]]] | None = None,
    days_ago: int = 1,
    status: OrderStatus = OrderStatus.DELIVERED,
) -> dict:
    """Pedido entregado con su carga pesada directamente en la BD (los flujos de pedidos y
    logística ya se prueban en sus tests). `lines`: [(pienso, precio, [kg por compartimento])]."""
    lines = lines or [("ceb", "0.3000", ["10000"])]
    when = datetime.now(UTC) - timedelta(days=days_ago)
    n = next(_counter)
    with new_session(tenant_id=ctx.tenant_id) as db:
        t = ctx.tenant_id
        order = Order(
            tenant_id=t,
            number=f"PED-{YEAR}-{n:04d}",
            customer_id=ctx.m[customer],
            farm_id=ctx.m[f"f{customer[1]}"],
            sales_rep_id=ctx.com_id if customer == "c1" else None,
            status=status,
            requested_date=when.date(),
        )
        db.add(order)
        db.flush()
        load = Load(
            tenant_id=t,
            number=f"CAR-{YEAR}-{n:04d}",
            load_date=when.date(),
            truck_id=ctx.m["truck"],
            status=LoadStatus.DELIVERED if status == OrderStatus.DELIVERED else LoadStatus.LOADED,
        )
        db.add(load)
        db.flush()
        stop = LoadStop(
            tenant_id=t,
            load_id=load.id,
            order_id=order.id,
            sequence=1,
            delivery_note_number=f"ALB-{YEAR}-{n:04d}",
            delivered_at=when if status == OrderStatus.DELIVERED else None,
        )
        db.add(stop)
        db.flush()
        compartment = 0
        for position, (item, price, kgs) in enumerate(lines, start=1):
            planned = sum(Decimal(k) for k in kgs)
            line = OrderLine(
                tenant_id=t,
                order_id=order.id,
                position=position,
                item_id=ctx.m[item],
                quantity_kg=planned.quantize(Decimal(1)),
                unit_price=Decimal(price),
                price_source=PriceSource.BASE,
                amount=Decimal(0),
            )
            db.add(line)
            db.flush()
            for kg in kgs:
                compartment += 1
                db.add(
                    LoadItem(
                        tenant_id=t,
                        load_id=load.id,
                        stop_id=stop.id,
                        order_line_id=line.id,
                        compartment=compartment,
                        planned_kg=Decimal(kg),
                        actual_kg=Decimal(kg),
                    )
                )
        db.commit()
        return {"id": str(order.id), "number": order.number, "note": stop.delivery_note_number}


def order_status(ctx: Ctx, order: dict) -> OrderStatus:
    with new_session(tenant_id=ctx.tenant_id) as db:
        found = db.get(Order, UUID(order["id"]))
        assert found is not None
        return found.status


def draft(client, ctx: Ctx, orders: list[dict], customer: str = "c1", **extra) -> dict:
    r = client.post(
        API,
        headers=ctx.ofi,
        json={"customer_id": str(ctx.m[customer]), "order_ids": [o["id"] for o in orders]} | extra,
    )
    assert r.status_code == 201, r.text
    return r.json()


def issue(client, ctx: Ctx, invoice: dict, headers=None, **body) -> dict:
    r = client.post(f"{API}/{invoice['id']}/issue", headers=headers or ctx.ofi, json=body)
    assert r.status_code == 200, r.text
    return r.json()


def issued_invoice(client, ctx: Ctx, customer: str = "c1", **kw) -> dict:
    return issue(client, ctx, draft(client, ctx, [delivered(ctx, customer, **kw)], customer))


def error(r, status: int, code: str) -> dict:
    assert r.status_code == status, r.text
    body = r.json()["error"]
    assert body["code"] == code, body
    return body


def owner_engine():
    return create_engine(os.environ["DATABASE_URL"])


def chain_rows(tenant_id: UUID) -> list[VerifactuRecord]:
    with new_session(tenant_id=tenant_id) as db:
        return list(db.exec(select(VerifactuRecord).order_by(col(VerifactuRecord.sequence))).all())


# ─── Borradores ────────────────────────────────────


def test_borrador_cuando_pedido_entregado_entonces_kg_reales_precios_iva_y_redondeo(client, ctx):
    order = delivered(
        ctx,
        lines=[("ceb", "0.3155", ["7990", "4003.33"]), ("pre", "1.2345", ["498.50"])],
    )
    inv = draft(client, ctx, [order], notes="Entrega de octubre")
    assert inv["status"] == "draft" and inv["number"] is None and inv["kind"] == "invoice"
    assert inv["invoice_type"] == "F1"
    lines = inv["lines"]
    assert [ln["item_code"] for ln in lines] == ["P-CEB", "P-PRE"]
    # 11.993,33 kg × 0,3155 = 3.783,89562 → 3.783,90
    assert lines[0]["quantity_kg"] == 11993.33 and lines[0]["amount"] == 3783.90
    assert lines[0]["unit_price"] == 0.3155 and lines[0]["vat_rate"] == 10
    assert lines[0]["delivery_note_number"] == order["note"]
    assert lines[0]["description"] == f"Cebo · Albarán {order['note']}"
    assert lines[0]["order_number"] == order["number"]
    # 498,5 × 1,2345 = 615,39825 → 615,40
    assert lines[1]["amount"] == 615.40 and lines[1]["vat_rate"] == 21
    assert inv["tax_breakdown"] == [
        {"vat_rate": 21, "surcharge_rate": 0, "base": 615.40, "vat": 129.23, "surcharge": 0},
        {"vat_rate": 10, "surcharge_rate": 0, "base": 3783.90, "vat": 378.39, "surcharge": 0},
    ]
    assert inv["taxable_base"] == 4399.30 and inv["vat_amount"] == 507.62
    assert inv["total"] == 4906.92 and inv["total_kg"] == 12491.83
    assert inv["surcharge_amount"] == 0
    assert inv["allowed_actions"] == ["edit", "delete", "issue"]
    assert inv["verifactu"] is None and inv["pdf_ready"] is False
    assert inv["notes"] == "Entrega de octubre"
    assert inv["customer_code"] == "C1" and inv["payment_method_name"] == "Recibo 30-60"
    assert [d["amount"] for d in inv["due_dates"]] == [2453.46, 2453.46]
    assert order_status(ctx, order) == OrderStatus.DELIVERED
    log = []
    with new_session(tenant_id=ctx.tenant_id) as db:
        log = db.exec(select(AuditLog.action).where(AuditLog.entity == "sales_invoice")).all()
    assert log == ["factura.crear"]


def test_borrador_cuando_cliente_con_recargo_entonces_recargo_y_iva_por_defecto(client, ctx):
    order = delivered(ctx, "c2", lines=[("ceb", "0.3000", ["10000"]), ("sin", "0.5000", ["101"])])
    inv = draft(client, ctx, [order], "c2")
    # P-SIN no tiene IVA: se usa el tipo por defecto (10 %), con su recargo 1,4 %
    assert [ln["surcharge_rate"] for ln in inv["lines"]] == [1.4, 1.4]
    assert inv["lines"][1]["vat_rate"] == 10
    assert inv["tax_breakdown"] == [
        {"vat_rate": 10, "surcharge_rate": 1.4, "base": 3050.50, "vat": 305.05, "surcharge": 42.71}
    ]
    assert inv["total"] == 3398.26
    # Sin forma de pago: un vencimiento a la fecha de factura por el total
    assert inv["due_dates"] == [{"date": TODAY.isoformat(), "amount": 3398.26}]


def test_borrador_cuando_no_hay_iva_por_defecto_entonces_vat_not_configured(client, ctx):
    with new_session(tenant_id=ctx.tenant_id) as db:
        rate = db.get(VatRate, ctx.m["v10"])
        assert rate is not None
        rate.is_default = False
        db.add(rate)
        db.commit()
    order = delivered(ctx, lines=[("sin", "0.3000", ["1000"])])
    r = client.post(
        API, headers=ctx.ofi, json={"customer_id": str(ctx.m["c1"]), "order_ids": [order["id"]]}
    )
    error(r, 409, "VAT_NOT_CONFIGURED")


def test_borrador_cuando_pedido_no_facturable_entonces_409_con_campo(client, ctx):
    ok = delivered(ctx)
    loaded = delivered(ctx, status=OrderStatus.LOADED)
    other = delivered(ctx, "c2")
    body = {"customer_id": str(ctx.m["c1"])}
    r = client.post(API, headers=ctx.ofi, json=body | {"order_ids": [ok["id"], loaded["id"]]})
    assert error(r, 409, "ORDER_NOT_INVOICEABLE")["field"] == "order_ids.1"
    r = client.post(API, headers=ctx.ofi, json=body | {"order_ids": [other["id"]]})
    assert error(r, 409, "ORDER_NOT_INVOICEABLE")["field"] == "order_ids.0"
    draft(client, ctx, [ok])
    # Ya está en otro borrador
    r = client.post(API, headers=ctx.ofi, json=body | {"order_ids": [ok["id"]]})
    error(r, 409, "ORDER_NOT_INVOICEABLE")
    r = client.post(API, headers=ctx.ofi, json=body | {"order_ids": []})
    assert r.status_code == 422


def test_bulk_y_pendiente_cuando_varios_clientes_entonces_un_borrador_por_cliente(client, ctx):
    a1 = delivered(ctx, "c1", days_ago=3)
    a2 = delivered(ctx, "c1", lines=[("ceb", "0.3000", ["5000"])], days_ago=1)
    b1 = delivered(ctx, "c2", days_ago=2)
    delivered(ctx, "c2", days_ago=20)  # fuera del periodo
    r = client.get("/api/v1/invoicing/pending", headers=ctx.ofi)
    assert r.status_code == 200, r.text
    page = r.json()
    assert page["total"] == 2
    first = page["items"][0]
    assert first["customer_code"] == "C2" and first["order_count"] == 2  # la entrega más antigua
    c1 = next(i for i in page["items"] if i["customer_code"] == "C1")
    assert c1["total_kg"] == 15000 and c1["estimated_base"] == 4500
    assert [o["number"] for o in c1["orders"]] == [a1["number"], a2["number"]]
    r = client.get(
        "/api/v1/invoicing/pending",
        headers=ctx.ofi,
        params={"date_from": (TODAY - timedelta(days=5)).isoformat(), "search": "Pinos"},
    )
    assert [i["customer_code"] for i in r.json()["items"]] == ["C1"]

    r = client.post(
        f"{API}/bulk",
        headers=ctx.ofi,
        json={"date_from": (TODAY - timedelta(days=5)).isoformat(), "date_to": TODAY.isoformat()},
    )
    assert r.status_code == 201, r.text
    created = r.json()["created"]
    assert sorted(c["customer_code"] for c in created) == ["C1", "C2"]
    assert {c["status"] for c in created} == {"draft"}
    by_code = {c["customer_code"]: c for c in created}
    assert by_code["C1"]["total_kg"] == 15000 and by_code["C2"]["total_kg"] == 10000
    # Lo que ya está en borrador no sale como pendiente ni vuelve a entrar en otro bulk
    r = client.get("/api/v1/invoicing/pending", headers=ctx.ofi)
    assert [i["order_count"] for i in r.json()["items"]] == [1]
    r = client.post(
        f"{API}/bulk",
        headers=ctx.ofi,
        json={"date_to": TODAY.isoformat(), "customer_ids": [str(ctx.m["c1"])]},
    )
    assert r.json()["created"] == []
    assert b1  # usado en el bulk
    r = client.get("/api/v1/invoicing/pending", headers=ctx.ofi, params={"limit": 5})
    assert r.status_code == 200


def test_borrador_cuando_se_edita_y_se_borra_entonces_recalcula_y_libera_pedidos(client, ctx):
    o1, o2 = delivered(ctx), delivered(ctx, lines=[("ceb", "0.3000", ["2000"])])
    inv = draft(client, ctx, [o1, o2])
    assert inv["total_kg"] == 12000
    r = client.put(
        f"{API}/{inv['id']}",
        headers=ctx.ofi,
        json={"order_ids": [o2["id"]], "notes": "Solo el segundo", "issue_date": TODAY.isoformat()},
    )
    assert r.status_code == 200, r.text
    assert r.json()["total_kg"] == 2000 and r.json()["notes"] == "Solo el segundo"
    # o1 queda libre para otra factura
    other = draft(client, ctx, [o1])
    r = client.delete(f"{API}/{inv['id']}", headers=ctx.ofi)
    assert r.status_code == 204
    assert client.get(f"{API}/{inv['id']}", headers=ctx.ofi).status_code == 404
    assert draft(client, ctx, [o2])["total_kg"] == 2000
    assert other["status"] == "draft"
    r = client.put(f"{API}/{other['id']}", headers=ctx.ofi, json={"notes": "x"})
    error(r, 422, "VALIDATION_ERROR")


# ─── Emisión ───────────────────────────────────────


def test_emitir_cuando_borrador_valido_entonces_numero_congelado_y_pedidos_facturados(
    client, ctx, fake_documents
):
    o1 = delivered(ctx)
    inv = issue(client, ctx, draft(client, ctx, [o1]))
    assert inv["number"] == f"F-{YEAR}-0001" and inv["status"] == "issued"
    assert inv["issued_at"] and inv["issued_by_name"]
    assert inv["customer_snapshot"]["tax_id"] == "B11111111"
    assert inv["due_dates"] == [
        {"date": (TODAY + timedelta(days=30)).isoformat(), "amount": 1650.0},
        {"date": (TODAY + timedelta(days=60)).isoformat(), "amount": 1650.0},
    ]
    assert inv["verifactu"]["previous_hash"] is None and len(inv["verifactu"]["hash"]) == 64
    assert inv["pdf_ready"] is True
    assert inv["allowed_actions"] == ["credit_note", "cancel"]
    assert order_status(ctx, o1) == OrderStatus.INVOICED
    data = fake_documents[-1]
    assert data.number == inv["number"] and data.company.tax_id == NIF
    assert data.qr_url == inv["verifactu"]["qr_url"] and "<svg" in data.qr_svg
    assert data.company.address == "Polígono Oeste 12, 30169 Murcia"

    # Los datos del cliente quedan congelados aunque cambie el maestro
    with new_session(tenant_id=ctx.tenant_id) as db:
        customer = db.get(Customer, ctx.m["c1"])
        assert customer is not None
        customer.name = "Nombre nuevo"
        db.add(customer)
        db.commit()
    again = client.get(f"{API}/{inv['id']}", headers=ctx.ofi).json()
    assert again["customer_name"] == "Granja Los Pinos"

    second = issue(client, ctx, draft(client, ctx, [delivered(ctx)]))
    assert second["number"] == f"F-{YEAR}-0002"
    assert second["verifactu"]["previous_hash"] == inv["verifactu"]["hash"]

    # Una emitida no se edita ni se borra ni se vuelve a emitir
    r = client.put(f"{API}/{inv['id']}", headers=ctx.ofi, json={"order_ids": [o1["id"]]})
    error(r, 409, "INVALID_STATUS")
    error(client.delete(f"{API}/{inv['id']}", headers=ctx.ofi), 409, "INVALID_STATUS")
    error(client.post(f"{API}/{inv['id']}/issue", headers=ctx.ofi), 409, "INVALID_STATUS")
    # Pedido ya facturado
    r = client.post(
        API, headers=ctx.ofi, json={"customer_id": str(ctx.m["c1"]), "order_ids": [o1["id"]]}
    )
    error(r, 409, "ORDER_NOT_INVOICEABLE")

    r = client.get(f"{API}/{inv['id']}/pdf", headers=ctx.ofi)
    assert r.status_code == 200 and r.content == b"%PDF-fake"
    assert r.headers["content-disposition"] == f'inline; filename="F-{YEAR}-0001.pdf"'
    with new_session(tenant_id=ctx.tenant_id) as db:
        actions = db.exec(select(AuditLog.action).where(AuditLog.entity == "sales_invoice")).all()
    assert actions.count("factura.emitir") == 2


def test_emitir_cuando_fecha_fuera_de_orden_entonces_issue_date_out_of_order(client, ctx):
    issue(client, ctx, draft(client, ctx, [delivered(ctx)]))
    late = draft(client, ctx, [delivered(ctx)])
    yesterday = (TODAY - timedelta(days=1)).isoformat()
    r = client.post(f"{API}/{late['id']}/issue", headers=ctx.ofi, json={"issue_date": yesterday})
    assert error(r, 409, "ISSUE_DATE_OUT_OF_ORDER")["field"] == "issue_date"
    tomorrow = (TODAY + timedelta(days=1)).isoformat()
    r = client.post(f"{API}/{late['id']}/issue", headers=ctx.ofi, json={"issue_date": tomorrow})
    error(r, 409, "ISSUE_DATE_OUT_OF_ORDER")
    # Un número que se intenta y no se emite no se consume
    assert issue(client, ctx, late)["number"] == f"F-{YEAR}-0002"


def test_emitir_cuando_faltan_datos_entonces_409(client, ctx):
    inv = draft(client, ctx, [delivered(ctx)])
    set_fiscal(ctx.tenant_id, address="")
    r = client.post(f"{API}/{inv['id']}/issue", headers=ctx.ofi)
    assert error(r, 409, "COMPANY_FISCAL_DATA_MISSING")["field"] == "address"
    set_fiscal(ctx.tenant_id, tax_id=None)
    r = client.post(f"{API}/{inv['id']}/issue", headers=ctx.ofi)
    assert error(r, 409, "COMPANY_FISCAL_DATA_MISSING")["field"] == "tax_id"
    set_fiscal(ctx.tenant_id)

    no_nif = draft(client, ctx, [delivered(ctx, "c3")], "c3")
    error(
        client.post(f"{API}/{no_nif['id']}/issue", headers=ctx.ofi), 409, "CUSTOMER_TAX_ID_MISSING"
    )

    free = draft(client, ctx, [delivered(ctx, lines=[("ceb", "0", ["1000"])])])
    error(client.post(f"{API}/{free['id']}/issue", headers=ctx.ofi), 409, "EMPTY_INVOICE")

    # IVA que deja de estar configurado entre el borrador y la emisión
    sin = draft(client, ctx, [delivered(ctx, lines=[("sin", "0.3", ["1000"])])])
    with new_session(tenant_id=ctx.tenant_id) as db:
        rate = db.get(VatRate, ctx.m["v10"])
        assert rate is not None
        rate.is_default = False
        db.add(rate)
        db.commit()
    error(client.post(f"{API}/{sin['id']}/issue", headers=ctx.ofi), 409, "VAT_NOT_CONFIGURED")
    assert chain_rows(ctx.tenant_id) == []
    # Ninguna emisión fallida ha gastado número
    assert issue(client, ctx, inv)["number"] == f"F-{YEAR}-0001"


def test_emitir_cuando_pdf_no_disponible_entonces_emite_y_pdf_503(client, ctx, monkeypatch):
    monkeypatch.setattr(documents, "render_invoice", _unavailable)
    inv = issue(client, ctx, draft(client, ctx, [delivered(ctx)]))
    assert inv["status"] == "issued" and inv["pdf_ready"] is False
    error(client.get(f"{API}/{inv['id']}/pdf", headers=ctx.ofi), 503, "PDF_UNAVAILABLE")
    monkeypatch.setattr(documents, "render_invoice", lambda d: b"%PDF-later")
    r = client.get(f"{API}/{inv['id']}/pdf", headers=ctx.ofi)
    assert r.status_code == 200 and r.content == b"%PDF-later"
    assert client.get(f"{API}/{inv['id']}", headers=ctx.ofi).json()["pdf_ready"] is True
    draft_inv = draft(client, ctx, [delivered(ctx)])
    error(client.get(f"{API}/{draft_inv['id']}/pdf", headers=ctx.ofi), 409, "INVALID_STATUS")


# ─── Abonos ────────────────────────────────────────


def _credit(client, ctx, invoice, headers=None, **body):
    return client.post(
        f"{API}/{invoice['id']}/credit-note",
        headers=headers or ctx.ofi,
        json={"rectification_reason": "Devolución"} | body,
    )


def test_abono_cuando_por_kg_e_importe_entonces_negativo_serie_r_y_limites(client, ctx):
    order = delivered(ctx, lines=[("ceb", "0.3000", ["10000"]), ("pre", "1.0000", ["500"])])
    inv = issue(client, ctx, draft(client, ctx, [order]))
    ceb, pre = inv["lines"]

    r = _credit(client, ctx, inv, lines=[{"invoice_line_id": ceb["id"], "quantity_kg": 1000}])
    assert r.status_code == 201, r.text
    cn = r.json()
    assert cn["kind"] == "credit_note" and cn["invoice_type"] == "R1" and cn["status"] == "draft"
    assert cn["rectified_invoice_id"] == inv["id"] and cn["rectified_number"] == inv["number"]
    assert cn["lines"][0]["quantity_kg"] == -1000 and cn["lines"][0]["amount"] == -300
    assert cn["taxable_base"] == -300 and cn["vat_amount"] == -30 and cn["total"] == -330
    cn = issue(client, ctx, cn)
    assert cn["number"] == f"R-{YEAR}-0001"
    assert cn["verifactu"]["previous_hash"] == inv["verifactu"]["hash"]
    assert order_status(ctx, order) == OrderStatus.INVOICED  # un abono no cambia el pedido

    detail = client.get(f"{API}/{inv['id']}", headers=ctx.ofi).json()
    assert detail["lines"][0]["credited_kg"] == 1000
    assert detail["lines"][0]["credited_amount"] == 300
    assert [c["number"] for c in detail["credit_notes"]] == [cn["number"]]
    assert detail["allowed_actions"] == ["credit_note"]  # con abonos ya no se anula

    # Descuento por importe en la premezcla (R4)
    r = _credit(
        client, ctx, inv, invoice_type="R4", lines=[{"invoice_line_id": pre["id"], "amount": 50}]
    )
    assert r.status_code == 201, r.text
    discount = r.json()
    assert discount["invoice_type"] == "R4"
    assert discount["lines"][0]["quantity_kg"] == 0 and discount["lines"][0]["amount"] == -50
    assert discount["lines"][0]["description"].startswith("Descuento · ")
    assert discount["total"] == -60.5
    issue(client, ctx, discount)

    # Más kilos o más importe de lo que queda → CREDIT_EXCEEDS_INVOICE
    r = _credit(client, ctx, inv, lines=[{"invoice_line_id": ceb["id"], "quantity_kg": 9000.01}])
    assert error(r, 409, "CREDIT_EXCEEDS_INVOICE")["field"] == "lines.0.quantity_kg"
    r = _credit(client, ctx, inv, lines=[{"invoice_line_id": pre["id"], "amount": 450.01}])
    assert error(r, 409, "CREDIT_EXCEEDS_INVOICE")["field"] == "lines.0.amount"
    r = _credit(
        client, ctx, inv, lines=[{"invoice_line_id": ceb["id"], "quantity_kg": 1, "amount": 1}]
    )
    assert r.status_code == 422

    # Lo pendiente de una línea por importe (como lo envía el frontend) = devolución total
    r = _credit(client, ctx, inv, lines=[{"invoice_line_id": ceb["id"], "amount": 2700}])
    whole = r.json()["lines"][0]
    assert (whole["quantity_kg"], whole["unit_price"], whole["amount"]) == (-9000, 0.3, -2700)
    assert client.delete(f"{API}/{r.json()['id']}", headers=ctx.ofi).status_code == 204

    # Abono total de lo pendiente
    r = _credit(client, ctx, inv, full=True)
    assert r.status_code == 201, r.text
    full = r.json()
    assert [ln["amount"] for ln in full["lines"]] == [-2700, -450]
    assert [ln["quantity_kg"] for ln in full["lines"]] == [-9000, -500]
    # Dos borradores que juntos superan lo facturado: el segundo no se puede emitir
    other = _credit(
        client, ctx, inv, lines=[{"invoice_line_id": ceb["id"], "quantity_kg": 10}]
    ).json()
    issue(client, ctx, full)
    error(client.post(f"{API}/{other['id']}/issue", headers=ctx.ofi), 409, "CREDIT_EXCEEDS_INVOICE")
    error(_credit(client, ctx, inv, full=True), 409, "CREDIT_EXCEEDS_INVOICE")

    detail = client.get(f"{API}/{inv['id']}", headers=ctx.ofi).json()
    assert [ln["credited_amount"] for ln in detail["lines"]] == [3000, 500]
    assert detail["allowed_actions"] == []
    error(
        client.post(f"{API}/{inv['id']}/cancel", headers=ctx.ofi, json={"reason": "x"}),
        409,
        "HAS_CREDIT_NOTES",
    )

    # Editar un borrador de abono
    r = client.put(
        f"{API}/{other['id']}",
        headers=ctx.ofi,
        json={
            "rectification_reason": "Otro motivo",
            "invoice_type": "R4",
            "lines": [{"invoice_line_id": ceb["id"], "amount": 0.01}],
        },
    )
    error(r, 409, "CREDIT_EXCEEDS_INVOICE")
    assert client.delete(f"{API}/{other['id']}", headers=ctx.ofi).status_code == 204
    assert full["lines"][0]["rectified_line_id"] == ceb["id"]
    # De un borrador o de un abono no se hace abono
    error(_credit(client, ctx, full, full=True), 409, "INVALID_STATUS")


def test_abono_cuando_sin_permiso_abonar_entonces_403(client, ctx):
    inv = issued_invoice(client, ctx)
    error(_credit(client, ctx, inv, headers=ctx.dir, full=True), 403, "FORBIDDEN")
    error(
        client.post(f"{API}/{inv['id']}/cancel", headers=ctx.dir, json={"reason": "x"}),
        403,
        "FORBIDDEN",
    )
    assert client.get(f"{API}/{inv['id']}", headers=ctx.dir).json()["allowed_actions"] == []


# ─── Anulación ─────────────────────────────────────


def test_anular_cuando_emitida_sin_abonos_entonces_registro_anulacion_y_pedidos_entregados(
    client, ctx, fake_documents
):
    order = delivered(ctx)
    inv = issue(client, ctx, draft(client, ctx, [order]))
    r = client.post(
        f"{API}/{inv['id']}/cancel", headers=ctx.ofi, json={"reason": "Cliente equivocado"}
    )
    assert r.status_code == 200, r.text
    cancelled = r.json()
    assert cancelled["status"] == "cancelled" and cancelled["status_reason"] == "Cliente equivocado"
    assert cancelled["allowed_actions"] == []
    assert order_status(ctx, order) == OrderStatus.DELIVERED
    assert fake_documents[-1].cancelled is True
    rows = chain_rows(ctx.tenant_id)
    assert [(r.record_type.value, r.invoice_number) for r in rows] == [
        ("alta", inv["number"]),
        ("anulacion", inv["number"]),
    ]
    assert rows[1].previous_hash == rows[0].hash and rows[1].total_amount is None
    error(
        client.post(f"{API}/{inv['id']}/cancel", headers=ctx.ofi, json={"reason": "x"}),
        409,
        "INVALID_STATUS",
    )
    # El pedido se puede volver a facturar (con número nuevo)
    again = issue(client, ctx, draft(client, ctx, [order]))
    assert again["number"] == f"F-{YEAR}-0002"
    r = client.get(API, headers=ctx.ofi, params={"status": "cancelled"})
    assert [i["number"] for i in r.json()["items"]] == [inv["number"]]


# ─── Cadena Verifactu ──────────────────────────────


def test_cadena_cuando_varias_emisiones_y_anulaciones_entonces_huellas_encadenadas(client, ctx):
    a = issued_invoice(client, ctx)
    b = issued_invoice(client, ctx, "c2")
    client.post(f"{API}/{a['id']}/cancel", headers=ctx.ofi, json={"reason": "Error"})
    cn = issue(client, ctx, _credit(client, ctx, b, full=True).json())
    issued_invoice(client, ctx)

    rows = chain_rows(ctx.tenant_id)
    assert [r.sequence for r in rows] == [1, 2, 3, 4, 5]
    assert [r.record_type.value for r in rows] == ["alta", "alta", "anulacion", "alta", "alta"]
    assert rows[3].invoice_number == cn["number"] and rows[3].invoice_type == "R1"
    assert rows[3].total_amount == Decimal(str(cn["total"]))
    assert all(r.send_status == "not_sent" for r in rows)
    for previous, row in zip(rows, rows[1:], strict=False):
        assert row.previous_hash == previous.hash
    chained = [ChainedRecord(service.record_from_row(r), r.hash) for r in rows]
    assert verify_chain(chained) == []

    r = client.get("/api/v1/verifactu/verify", headers=ctx.ofi)
    assert r.json() == {"ok": True, "records": 5, "broken": []}
    r = client.get("/api/v1/verifactu/records", headers=ctx.dir)
    assert r.status_code == 200, r.text
    page = r.json()
    assert page["total"] == 5 and [i["sequence"] for i in page["items"]] == [5, 4, 3, 2, 1]
    assert page["items"][2]["record_type"] == "anulacion"
    r = client.get("/api/v1/verifactu/records", headers=ctx.ofi, params={"invoice_id": a["id"]})
    assert [i["record_type"] for i in r.json()["items"]] == ["anulacion", "alta"]

    # Manipulación directa con el dueño de las tablas: la comprobación la detecta
    engine = owner_engine()
    with engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE verifactu_record SET total_amount = total_amount + 1"
                " WHERE tenant_id = :t AND sequence = 2"
            ),
            {"t": ctx.tenant_id},
        )
    engine.dispose()
    r = client.get("/api/v1/verifactu/verify", headers=ctx.ofi).json()
    assert r["ok"] is False and r["broken"] == [{"sequence": 2, "invoice_number": b["number"]}]


def test_verifactu_record_cuando_api_intenta_modificar_entonces_permiso_denegado(client, ctx):
    issued_invoice(client, ctx)
    for sql in (
        "UPDATE verifactu_record SET hash = 'X'",
        "DELETE FROM verifactu_record",
    ):
        with new_session(tenant_id=ctx.tenant_id) as db, pytest.raises(DBAPIError) as exc:
            db.execute(text(sql))
        assert "permission denied" in str(exc.value).lower()
    assert len(chain_rows(ctx.tenant_id)) == 1


def test_qr_cuando_emite_entonces_url_con_datos_de_la_factura(client, ctx):
    inv = issued_invoice(client, ctx)
    expected = qr.qr_url(
        NIF, inv["number"], TODAY, Decimal(str(inv["total"])), qr.QREnvironment.TEST
    )
    assert inv["verifactu"]["qr_url"] == expected
    assert expected.startswith("https://prewww2.aeat.es/")
    assert f"numserie={inv['number']}" in expected and "importe=3300.00" in expected
    assert f"fecha={TODAY:%d-%m-%Y}" in expected and f"nif={NIF}" in expected


def test_emisiones_simultaneas_cuando_dos_sesiones_entonces_cadena_y_numeros_correctos(client, ctx):
    drafts = [draft(client, ctx, [delivered(ctx)]) for _ in range(2)]
    user = load_current_user(ctx.ofi_id, ctx.tenant_id, False)
    barrier = threading.Barrier(2)
    errors: list[Exception] = []

    def run(invoice_id: str) -> None:
        try:
            with new_session(tenant_id=ctx.tenant_id) as db:
                barrier.wait()
                invoice, _ = service.get_for_update(db, user, UUID(invoice_id))
                service.ensure_manage(user, invoice)
                service.issue(db, user, invoice, None)
                db.commit()
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=run, args=(d["id"],)) for d in drafts]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    assert errors == []
    rows = chain_rows(ctx.tenant_id)
    assert [r.sequence for r in rows] == [1, 2]
    assert sorted(r.invoice_number for r in rows) == [f"F-{YEAR}-0001", f"F-{YEAR}-0002"]
    assert rows[1].previous_hash == rows[0].hash
    assert client.get("/api/v1/verifactu/verify", headers=ctx.ofi).json()["ok"] is True


# ─── Permisos, aislamiento y consultas ─────────────


def test_comercial_cuando_lista_entonces_solo_facturas_de_sus_clientes(client, ctx):
    mine = issued_invoice(client, ctx, "c1")
    other = issued_invoice(client, ctx, "c2")
    r = client.get(API, headers=ctx.com)
    assert r.status_code == 200, r.text
    assert [i["id"] for i in r.json()["items"]] == [mine["id"]]
    assert client.get(f"{API}/{other['id']}", headers=ctx.com).status_code == 404
    assert client.get(f"{API}/{mine['id']}/pdf", headers=ctx.com).status_code == 200
    assert client.get(f"{API}/{mine['id']}", headers=ctx.com).json()["allowed_actions"] == []
    error(client.get("/api/v1/verifactu/records", headers=ctx.com), 403, "FORBIDDEN")
    error(client.get("/api/v1/verifactu/verify", headers=ctx.com), 403, "FORBIDDEN")
    error(client.get("/api/v1/invoicing/pending", headers=ctx.com), 403, "FORBIDDEN")
    r = client.post(
        API,
        headers=ctx.com,
        json={"customer_id": str(ctx.m["c1"]), "order_ids": [delivered(ctx)["id"]]},
    )
    error(r, 403, "FORBIDDEN")
    summary = client.get("/api/v1/invoicing/summary", headers=ctx.com).json()
    assert summary["invoiced_total"] == mine["total"] and summary["invoice_count"] == 1


def test_aislamiento_cuando_otra_empresa_entonces_no_ve_ni_comparte_cadena(
    client, ctx, make_tenant
):
    inv = issued_invoice(client, ctx)
    other = make_ctx(client, make_tenant, "Piensos Sur")
    assert client.get(f"{API}/{inv['id']}", headers=other.ofi).status_code == 404
    assert client.get(API, headers=other.ofi).json()["total"] == 0
    assert client.get("/api/v1/verifactu/records", headers=other.ofi).json()["total"] == 0
    own = issued_invoice(client, other)
    # Numeración y cadena propias de cada empresa
    assert own["number"] == f"F-{YEAR}-0001" and own["verifactu"]["previous_hash"] is None
    r = client.post(
        API,
        headers=other.ofi,
        json={"customer_id": str(other.m["c1"]), "order_ids": [delivered(ctx)["id"]]},
    )
    error(r, 409, "ORDER_NOT_INVOICEABLE")


def test_listado_y_resumen_cuando_facturas_y_abonos_entonces_filtros_y_neto(client, ctx):
    inv = issued_invoice(client, ctx)
    cn = issue(
        client,
        ctx,
        _credit(
            client, ctx, inv, lines=[{"invoice_line_id": inv["lines"][0]["id"], "amount": 100}]
        ).json(),
    )
    pending_draft = draft(client, ctx, [delivered(ctx, "c2")], "c2")
    items = client.get(API, headers=ctx.ofi).json()["items"]
    assert [i["id"] for i in items] == [pending_draft["id"], cn["id"], inv["id"]]
    r = client.get(API, headers=ctx.ofi, params={"kind": "credit_note"})
    assert [i["number"] for i in r.json()["items"]] == [cn["number"]]
    r = client.get(API, headers=ctx.ofi, params={"status": "draft,issued", "search": "Tienda"})
    assert [i["id"] for i in r.json()["items"]] == [pending_draft["id"]]
    r = client.get(API, headers=ctx.ofi, params={"search": inv["number"]})
    assert [i["id"] for i in r.json()["items"]] == [inv["id"]]
    assert client.get(API, headers=ctx.ofi, params={"status": "nope"}).status_code == 400

    summary = client.get("/api/v1/invoicing/summary", headers=ctx.dir).json()
    assert summary == {
        "month": TODAY.strftime("%Y-%m"),
        "invoiced_total": 3300.0,
        "credit_total": -110.0,
        "net_total": 3190.0,
        "invoice_count": 1,
        "previous_month_net": 0.0,
    }
    r = client.get("/api/v1/invoicing/summary", headers=ctx.dir, params={"month": "2020-13"})
    assert r.status_code == 400


def test_aviso_cuando_oficina_emite_entonces_avisa_al_comercial_del_cliente(client, ctx):
    inv = issued_invoice(client, ctx, "c1")
    issued_invoice(client, ctx, "c2")  # sin comercial: sin aviso
    with new_session(tenant_id=ctx.tenant_id) as db:
        notes = db.exec(select(Notification).where(Notification.type == "factura_emitida")).all()
    assert [(n.user_id, n.title) for n in notes] == [
        (ctx.com_id, f"Factura {inv['number']} emitida")
    ]
    assert notes[0].link == f"/facturacion/facturas/{inv['id']}"


def test_datos_fiscales_cuando_se_editan_entonces_tenant_y_cliente_los_devuelven(client, ctx):
    r = client.patch(
        "/api/v1/tenant",
        headers=ctx.admin,
        json={
            "legal_name": "Piensos Norte S.A.",
            "feed_registration": "αES30001234",
            "province": None,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["legal_name"] == "Piensos Norte S.A." and body["feed_registration"] == "αES30001234"
    assert body["province"] == "" and body["address"] == "Polígono Oeste 12"
    r = client.get(f"/api/v1/masters/customers/{ctx.m['c2']}", headers=ctx.admin)
    assert r.status_code == 200, r.text
    assert r.json()["equivalence_surcharge"] is True
    r = client.post(
        "/api/v1/masters/customers",
        headers=ctx.admin,
        json={"code": "C9", "name": "Nuevo", "equivalence_surcharge": True},
    )
    assert r.status_code == 201, r.text
    assert r.json()["equivalence_surcharge"] is True
    with new_session(tenant_id=ctx.tenant_id) as db:
        assert db.exec(select(Invoice)).all() == []


def test_emitida_cuando_cambian_datos_de_la_empresa_entonces_el_pdf_conserva_los_originales(
    client, ctx
):
    inv = issued_invoice(client, ctx)
    set_fiscal(ctx.tenant_id, address="Otra calle 99", legal_name="Razón Nueva S.L.")

    with new_session(tenant_id=ctx.tenant_id) as db:
        invoice = db.get(Invoice, UUID(inv["id"]))
        assert invoice is not None
        data = service.invoice_data(db, invoice)
    assert data.company.address == "Polígono Oeste 12, 30169 Murcia"
    assert data.company.name != "Razón Nueva S.L."
