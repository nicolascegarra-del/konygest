"""Logística: reparto en compartimentos, estados de cargas y pedidos, pesada con salida de
stock, albaranes en PDF, entregas, permisos, avisos y aislamiento entre empresas."""

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal
from uuid import UUID

import pytest
from sqlmodel import select

from app.core.db import new_session
from app.modules import documents
from app.modules.masters.models import Customer, Driver, Farm, Item, ItemKind, Silo, Truck
from app.modules.notifications.models import Notification
from app.modules.orders.models import Order, OrderLine, OrderStatus, PriceSource
from app.modules.orders.service import today_madrid
from app.modules.platform.models import AuditLog
from app.modules.stock.models import MovementKind, StockMovement
from tests.conftest import auth, get_user, invite_user

API = "/api/v1/loads"
YEAR = today_madrid().year


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
def fake_documents(monkeypatch) -> Iterator[MemoryStorage]:
    """PDF y almacenamiento de Konygest falsos: estos tests prueban la logística, no las
    plantillas. Sin destino configurado, los albaranes van al almacenamiento de Konygest."""
    storage = MemoryStorage()
    documents.storage.reset(storage)
    monkeypatch.setattr(documents, "render_delivery_note", lambda data: b"%PDF-fake albaran")
    monkeypatch.setattr(documents, "render_loading_order", lambda data: b"%PDF-fake orden")
    yield storage
    documents.storage.reset()


def note_key(tenant_id: UUID, number: str) -> str:
    return f"{tenant_id}/Albaranes/{YEAR}/{number}.pdf"


def _unavailable(data):
    raise documents.PdfUnavailableError("sin WeasyPrint")


@dataclass
class Ctx:
    tenant_id: UUID
    admin: dict[str, str]
    ofi: dict[str, str]  # Oficina: planifica
    fab: dict[str, str]  # Fábrica: pesa
    com: dict[str, str]  # Comercial: no ve logística
    admin_id: UUID
    ofi_id: UUID
    fab_id: UUID
    com_id: UUID
    m: dict[str, UUID]


def _masters(tenant_id: UUID, com_id: UUID) -> dict[str, UUID]:
    with new_session(tenant_id=tenant_id) as db:

        def add(row):
            db.add(row)
            db.flush()
            return row

        t = tenant_id
        ceb = add(Item(tenant_id=t, code="P-CEB", name="Cebo", kind=ItemKind.PRODUCT))
        lec = add(Item(tenant_id=t, code="P-LEC", name="Lechones", kind=ItemKind.PRODUCT))
        c1 = add(Customer(tenant_id=t, code="C1", name="Granja Los Pinos", sales_rep_id=com_id))
        c2 = add(Customer(tenant_id=t, code="C2", name="Porcinos del Segura"))
        silos = [{"name": "Silo 1", "capacity_kg": 14000}]
        f1 = add(
            Farm(
                tenant_id=t,
                customer_id=c1.id,
                name="Explotación Lorca",
                city="Lorca",
                rega_code="ES300240000101",
                silos=silos,
            )
        )
        f2 = add(Farm(tenant_id=t, customer_id=c2.id, name="Explotación Cieza", city="Cieza"))
        s1 = add(Silo(tenant_id=t, code="S1", name="Silo 1"))
        s2 = add(Silo(tenant_id=t, code="S2", name="Silo 2"))
        truck = add(Truck(tenant_id=t, plate="1234KLM", compartments=[8000, 8000, 8000]))
        old = add(Truck(tenant_id=t, plate="0000AAA", compartments=[8000], is_active=False))
        driver = add(Driver(tenant_id=t, full_name="Paco Martínez"))
        for item, silo, kg in ((ceb, s1, 30000), (lec, s2, 3000)):
            add(
                StockMovement(
                    tenant_id=t,
                    item_id=item.id,
                    silo_id=silo.id,
                    kind=MovementKind.INVENTORY,
                    quantity_kg=Decimal(kg),
                )
            )
        db.commit()
        rows = {"ceb": ceb, "lec": lec, "c1": c1, "c2": c2, "f1": f1, "f2": f2, "s1": s1}
        rows |= {"s2": s2, "truck": truck, "old": old, "driver": driver}
        return {k: v.id for k, v in rows.items()}


@pytest.fixture
def ctx(client, make_tenant) -> Ctx:
    tenant, admin_email = make_tenant()
    admin = auth(client, admin_email)
    ofi = invite_user(client, admin, "oficina@norte.es", ["Oficina"])
    fab = invite_user(client, admin, "fabrica@norte.es", ["Fábrica"])
    com = invite_user(client, admin, "comercial@norte.es", ["Comercial"])
    ids = {e: get_user(e).id for e in ("oficina@norte.es", "fabrica@norte.es")}
    com_id = get_user("comercial@norte.es").id
    return Ctx(
        tenant_id=tenant.id,
        admin=admin,
        ofi=ofi,
        fab=fab,
        com=com,
        admin_id=get_user(admin_email).id,
        ofi_id=ids["oficina@norte.es"],
        fab_id=ids["fabrica@norte.es"],
        com_id=com_id,
        m=_masters(tenant.id, com_id),
    )


_counter = iter(range(1, 10_000))


def make_order(
    ctx: Ctx,
    customer: str = "c1",
    lines: list[tuple[str, int]] | None = None,
    status: OrderStatus = OrderStatus.CONFIRMED,
    days: int = 1,
) -> dict:
    """Pedido directamente en la BD (su flujo ya se prueba en test_orders)."""
    lines = lines or [("ceb", 12000)]
    farm = {"c1": "f1", "c2": "f2"}[customer]
    with new_session(tenant_id=ctx.tenant_id) as db:
        order = Order(
            tenant_id=ctx.tenant_id,
            number=f"PED-{YEAR}-{next(_counter):04d}",
            customer_id=ctx.m[customer],
            farm_id=ctx.m[farm],
            sales_rep_id=ctx.com_id if customer == "c1" else None,
            status=status,
            requested_date=today_madrid() + timedelta(days=days),
            total_kg=Decimal(sum(kg for _, kg in lines)),
        )
        db.add(order)
        db.flush()
        line_ids = []
        for position, (item, kg) in enumerate(lines, start=1):
            line = OrderLine(
                tenant_id=ctx.tenant_id,
                order_id=order.id,
                position=position,
                item_id=ctx.m[item],
                quantity_kg=Decimal(kg),
                unit_price=Decimal("0.30"),
                price_source=PriceSource.BASE,
                amount=Decimal(kg) * Decimal("0.30"),
                farm_silo="Silo 1" if customer == "c1" else "",
            )
            db.add(line)
            db.flush()
            line_ids.append(str(line.id))
        db.commit()
        return {"id": str(order.id), "number": order.number, "lines": line_ids}


def order_status(ctx: Ctx, order: dict) -> OrderStatus:
    with new_session(tenant_id=ctx.tenant_id) as db:
        found = db.get(Order, UUID(order["id"]))
        assert found is not None
        return found.status


def body(ctx: Ctx, orders: list[dict], items=None, days: int = 1, **extra) -> dict:
    data = {
        "load_date": (today_madrid() + timedelta(days=days)).isoformat(),
        "truck_id": str(ctx.m["truck"]),
        "driver_id": str(ctx.m["driver"]),
        "stops": [{"order_id": o["id"], "sequence": i} for i, o in enumerate(orders, start=1)],
        **extra,
    }
    if items is not None:
        data["items"] = items
    return data


def create(client, ctx: Ctx, data: dict, status: int = 201, headers=None) -> dict:
    r = client.post(API, headers=headers or ctx.ofi, json=data)
    assert r.status_code == status, r.text
    return r.json()


def act(client, headers, load: dict, action: str, data: dict | None = None, status=200):
    r = client.post(f"{API}/{load['id']}/{action}", headers=headers, json=data or {})
    assert r.status_code == status, r.text
    return r.json()


def weigh_body(load: dict, silo_for: dict[str, UUID], factor: float = 1.0) -> dict:
    """Pesada de cada compartimento desde el silo de su pienso."""
    return {
        "gross_kg": 38420,
        "tare_kg": 14200,
        "items": [
            {
                "item_id": i["id"],
                "actual_kg": round(i["planned_kg"] * factor, 2),
                "silo_id": str(silo_for[i["item_code"]]),
                "lot": "L-1",
            }
            for i in load["items"]
        ],
    }


def silos(ctx: Ctx) -> dict[str, UUID]:
    return {"P-CEB": ctx.m["s1"], "P-LEC": ctx.m["s2"]}


def notifications(type_: str) -> list[Notification]:
    with new_session(bypass_rls=True) as db:
        return list(db.exec(select(Notification).where(Notification.type == type_)).all())


def audits(action: str) -> list[AuditLog]:
    with new_session(bypass_rls=True) as db:
        return list(db.exec(select(AuditLog).where(AuditLog.action == action)).all())


def load_out(ctx: Ctx) -> list[StockMovement]:
    with new_session(tenant_id=ctx.tenant_id) as db:
        return list(
            db.exec(select(StockMovement).where(StockMovement.kind == MovementKind.LOAD_OUT)).all()
        )


def error(r) -> dict:
    return (r if isinstance(r, dict) else r.json())["error"]


# ─── Alta y reparto ────────────────────────────────


def test_alta_cuando_sin_items_entonces_reparte_en_orden_partiendo_lineas_sin_mezclar(client, ctx):
    a = make_order(ctx, "c1", [("ceb", 12000)])
    b = make_order(ctx, "c2", [("lec", 3000)])
    load = create(client, ctx, body(ctx, [a, b]))

    assert load["number"] == f"CAR-{YEAR}-0001"
    assert load["status"] == "planned"
    assert load["truck_plate"] == "1234KLM"
    assert load["driver_name"] == "Paco Martínez"
    assert load["capacity_kg"] == 24000
    assert load["planned_kg"] == 15000
    assert load["stop_count"] == 2
    assert load["customers"] == ["Granja Los Pinos", "Porcinos del Segura"]
    assert load["compartments"] == [8000, 8000, 8000]
    assert load["created_by_name"] == "oficina"
    assert set(load["allowed_actions"]) == {"edit", "release", "cancel"}
    # La línea de 12.000 kg ocupa 1 entero y parte del 2; la siguiente empieza en el 3
    reparto = [(i["compartment"], i["item_code"], i["planned_kg"]) for i in load["items"]]
    assert reparto == [(1, "P-CEB", 8000), (2, "P-CEB", 4000), (3, "P-LEC", 3000)]
    stops = {s["id"]: s for s in load["stops"]}
    assert [stops[i["stop_id"]]["sequence"] for i in load["items"]] == [1, 1, 2]
    first = load["stops"][0]
    assert first["order_number"] == a["number"]
    assert first["farm_rega"] == "ES300240000101"
    assert first["farm_city"] == "Lorca"
    assert first["order_status"] == "planned"
    assert first["delivery_note_number"] is None
    assert first["delivery_note_ready"] is False

    assert order_status(ctx, a) == order_status(ctx, b) == OrderStatus.PLANNED
    assert len(audits("carga.crear")) == 1

    listing = client.get(API, headers=ctx.ofi).json()
    assert listing["total"] == 1
    assert listing["items"][0]["customers"] == ["Granja Los Pinos", "Porcinos del Segura"]
    assert listing["items"][0]["planned_kg"] == 15000


def test_alta_cuando_no_cabe_entonces_load_does_not_fit_con_kg_y_sin_efectos(client, ctx):
    a = make_order(ctx, "c1", [("ceb", 12000)])
    b = make_order(ctx, "c2", [("ceb", 8000), ("lec", 1000)])
    r = client.post(API, headers=ctx.ofi, json=body(ctx, [a, b]))
    assert r.status_code == 409
    assert error(r)["code"] == "LOAD_DOES_NOT_FIT"
    # 12.000 en 1 y 2, 8.000 en 3: los 1.000 kg de lechones se quedan fuera
    assert "1.000,00 kg" in error(r)["message"]
    assert order_status(ctx, a) == OrderStatus.CONFIRMED
    assert client.get(API, headers=ctx.ofi).json()["total"] == 0
    # El número no se ha gastado
    assert create(client, ctx, body(ctx, [a]))["number"] == f"CAR-{YEAR}-0001"


def test_alta_manual_cuando_compartimento_desborda_entonces_compartment_overflow(client, ctx):
    a = make_order(ctx, "c1", [("ceb", 12000)])
    line = a["lines"][0]
    items = [
        {"order_line_id": line, "compartment": 1, "planned_kg": 9000},
        {"order_line_id": line, "compartment": 2, "planned_kg": 3000},
    ]
    r = client.post(API, headers=ctx.ofi, json=body(ctx, [a], items))
    assert r.status_code == 409
    assert error(r)["code"] == "COMPARTMENT_OVERFLOW"
    assert error(r)["field"] == "items.0"


def test_alta_manual_cuando_suma_por_linea_no_cuadra_entonces_validation_error(client, ctx):
    a = make_order(ctx, "c1", [("ceb", 12000)])
    line = a["lines"][0]
    items = [
        {"order_line_id": line, "compartment": 1, "planned_kg": 8000},
        {"order_line_id": line, "compartment": 3, "planned_kg": 3000},
    ]
    r = client.post(API, headers=ctx.ofi, json=body(ctx, [a], items))
    assert r.status_code == 400
    assert error(r)["code"] == "VALIDATION_ERROR"
    assert error(r)["field"] == "items"
    assert "P-CEB" in error(r)["message"] and a["number"] in error(r)["message"]

    # Compartimento repetido o fuera del camión
    dup = [
        {"order_line_id": line, "compartment": 1, "planned_kg": 6000},
        {"order_line_id": line, "compartment": 1, "planned_kg": 6000},
    ]
    r = client.post(API, headers=ctx.ofi, json=body(ctx, [a], dup))
    assert (r.status_code, error(r)["field"]) == (400, "items.1.compartment")
    out = [{"order_line_id": line, "compartment": 4, "planned_kg": 12000}]
    r = client.post(API, headers=ctx.ofi, json=body(ctx, [a], out))
    assert (r.status_code, error(r)["field"]) == (400, "items.0.compartment")

    # Línea de un pedido que no va en la carga
    other = make_order(ctx, "c2", [("lec", 1000)])
    foreign = [{"order_line_id": other["lines"][0], "compartment": 1, "planned_kg": 1000}]
    r = client.post(API, headers=ctx.ofi, json=body(ctx, [a], foreign))
    assert (r.status_code, error(r)["code"]) == (400, "INVALID_REFERENCE")

    # Reparto manual correcto: se respeta tal cual
    ok = [
        {"order_line_id": line, "compartment": 3, "planned_kg": 8000},
        {"order_line_id": line, "compartment": 1, "planned_kg": 4000},
    ]
    load = create(client, ctx, body(ctx, [a], ok))
    assert [(i["compartment"], i["planned_kg"]) for i in load["items"]] == [(1, 4000), (3, 8000)]


def test_alta_cuando_pedido_no_confirmado_o_en_otra_carga_entonces_order_not_plannable(client, ctx):
    pending = make_order(ctx, status=OrderStatus.PENDING)
    r = client.post(API, headers=ctx.ofi, json=body(ctx, [pending]))
    assert r.status_code == 409
    assert error(r)["code"] == "ORDER_NOT_PLANNABLE"
    assert error(r)["field"] == "stops.0.order_id"

    a = make_order(ctx, "c1", [("ceb", 6000)])
    b = make_order(ctx, "c2", [("lec", 1000)])
    create(client, ctx, body(ctx, [a]))
    r = client.post(API, headers=ctx.ofi, json=body(ctx, [b, a]))
    assert r.status_code == 409
    assert error(r)["code"] == "ORDER_NOT_PLANNABLE"
    assert error(r)["field"] == "stops.1.order_id"
    assert order_status(ctx, b) == OrderStatus.CONFIRMED

    missing = {"id": "00000000-0000-0000-0000-000000000001"}
    r = client.post(API, headers=ctx.ofi, json=body(ctx, [missing]))
    assert (r.status_code, error(r)["code"]) == (400, "INVALID_REFERENCE")
    assert error(r)["field"] == "stops.0.order_id"


def test_alta_cuando_datos_no_validos_entonces_400(client, ctx):
    a = make_order(ctx)
    r = client.post(API, headers=ctx.ofi, json=body(ctx, [a], days=-1))
    assert (r.status_code, error(r)["field"]) == (400, "load_date")
    r = client.post(API, headers=ctx.ofi, json=body(ctx, [a], truck_id=str(ctx.m["old"])))
    assert (r.status_code, error(r)["code"], error(r)["field"]) == (
        400,
        "INVALID_REFERENCE",
        "truck_id",
    )
    bad = body(ctx, [a])
    bad["stops"][0]["sequence"] = 2
    r = client.post(API, headers=ctx.ofi, json=bad)
    assert (r.status_code, error(r)["field"]) == (400, "stops")
    r = client.post(API, headers=ctx.ofi, json=body(ctx, [a, a]))
    assert (r.status_code, error(r)["field"]) == (400, "stops")


# ─── Edición y cancelación ─────────────────────────


def test_editar_y_cancelar_cuando_cambian_paradas_entonces_pedidos_planned_confirmed(client, ctx):
    a = make_order(ctx, "c1", [("ceb", 6000)])
    b = make_order(ctx, "c2", [("lec", 2000)])
    load = create(client, ctx, body(ctx, [a]))

    # Se puede reenviar el mismo pedido (ya está en esta carga) y añadir otro
    r = client.put(f"{API}/{load['id']}", headers=ctx.ofi, json=body(ctx, [b, a], days=2))
    assert r.status_code == 200, r.text
    edited = r.json()
    assert [s["order_number"] for s in edited["stops"]] == [b["number"], a["number"]]
    assert [i["item_code"] for i in edited["items"]] == ["P-LEC", "P-CEB"]
    assert order_status(ctx, a) == order_status(ctx, b) == OrderStatus.PLANNED

    # Sale A: vuelve a confirmado
    r = client.put(f"{API}/{load['id']}", headers=ctx.ofi, json=body(ctx, [b]))
    assert r.status_code == 200, r.text
    assert order_status(ctx, a) == OrderStatus.CONFIRMED
    assert order_status(ctx, b) == OrderStatus.PLANNED
    assert len(audits("carga.editar")) == 2

    r = client.post(f"{API}/{load['id']}/cancel", headers=ctx.ofi, json={"reason": ""})
    assert r.status_code == 422
    cancelled = act(client, ctx.ofi, load, "cancel", {"reason": "Camión averiado"})
    assert cancelled["status"] == "cancelled"
    assert cancelled["status_reason"] == "Camión averiado"
    assert cancelled["allowed_actions"] == []
    assert order_status(ctx, b) == OrderStatus.CONFIRMED
    # Una carga cancelada ya no retiene el pedido
    assert create(client, ctx, body(ctx, [b]))["status"] == "planned"
    # Ni se edita ni se vuelve a cancelar
    r = client.put(f"{API}/{load['id']}", headers=ctx.ofi, json=body(ctx, [a]))
    assert (r.status_code, error(r)["code"]) == (409, "INVALID_STATUS")
    act(client, ctx.ofi, load, "cancel", {"reason": "otra vez"}, status=409)


def test_release_unrelease_cuando_lista_entonces_no_editable_y_vuelve(client, ctx):
    a = make_order(ctx)
    load = create(client, ctx, body(ctx, [a]))
    ready = act(client, ctx.ofi, load, "release")
    assert ready["status"] == "ready"
    assert ready["released_at"] is not None
    assert set(ready["allowed_actions"]) == {"unrelease", "cancel"}
    r = client.put(f"{API}/{load['id']}", headers=ctx.ofi, json=body(ctx, [a]))
    assert (r.status_code, error(r)["code"]) == (409, "INVALID_STATUS")
    act(client, ctx.ofi, load, "release", status=409)
    fab_view = client.get(f"{API}/{load['id']}", headers=ctx.fab).json()
    assert fab_view["allowed_actions"] == ["load"]

    back = act(client, ctx.ofi, load, "unrelease")
    assert back["status"] == "planned"
    assert back["released_at"] is None
    assert len(audits("carga.emitir")) == len(audits("carga.devolver")) == 1


# ─── Pesada, albaranes y entregas ──────────────────


def test_ciclo_completo_cuando_se_pesa_y_entrega_entonces_stock_albaranes_y_avisos(
    client, ctx, fake_documents
):
    a = make_order(ctx, "c1", [("ceb", 12000)])
    b = make_order(ctx, "c2", [("lec", 3000)])
    load = create(client, ctx, body(ctx, [a, b]))
    act(client, ctx.ofi, load, "release")
    # carga_lista: a quien pesa (fábrica y admin), no a quien emite
    assert {n.user_id for n in notifications("carga_lista")} == {ctx.fab_id, ctx.admin_id}
    assert notifications("carga_lista")[0].link == f"/logistica/cargas/{load['id']}"

    # Orden de carga en PDF
    r = client.get(f"{API}/{load['id']}/loading-order.pdf", headers=ctx.fab)
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert r.headers["content-disposition"] == f'inline; filename="{load["number"]}.pdf"'

    # Antes de pesar no hay albarán
    stop_a = load["stops"][0]
    r = client.get(f"{API}/{load['id']}/stops/{stop_a['id']}/delivery-note.pdf", headers=ctx.fab)
    assert r.status_code == 404

    ready = client.get(f"{API}/{load['id']}", headers=ctx.fab).json()
    data = weigh_body(ready, silos(ctx))
    data["items"][0]["actual_kg"] = 7980
    loaded = act(client, ctx.fab, load, "load", data)
    assert loaded["status"] == "loaded"
    assert loaded["loaded_by_name"] == "fabrica"
    assert loaded["gross_kg"] == 38420 and loaded["tare_kg"] == 14200
    assert loaded["items"][0]["actual_kg"] == 7980
    assert loaded["items"][0]["silo_name"] == "Silo 1"
    assert loaded["items"][0]["lot"] == "L-1"
    assert [s["delivery_note_number"] for s in loaded["stops"]] == [
        f"ALB-{YEAR}-0001",
        f"ALB-{YEAR}-0002",
    ]
    assert all(s["delivery_note_ready"] for s in loaded["stops"])
    assert all(s["order_status"] == "loaded" for s in loaded["stops"])
    assert note_key(ctx.tenant_id, f"ALB-{YEAR}-0001") in fake_documents.files
    with new_session(bypass_rls=True) as db:
        doc = db.exec(
            select(documents.StoredDocument).where(
                documents.StoredDocument.number == f"ALB-{YEAR}-0001"
            )
        ).one()
    assert (doc.kind, doc.provider, doc.source_type) == ("delivery_note", "platform", "load_stop")
    assert str(doc.source_id) == loaded["stops"][0]["id"]
    assert len(audits("carga.cargar")) == 1

    movements = load_out(ctx)
    assert sorted(m.quantity_kg for m in movements) == [-7980, -4000, -3000]
    assert all(m.source_type == "truck_load" for m in movements)
    assert all(str(m.source_id) == load["id"] for m in movements)

    # carga_cargada: planificación (oficina y admin) con la carga; el comercial, su pedido
    cargadas = notifications("carga_cargada")
    planners = {n.user_id: n for n in cargadas if n.link == f"/logistica/cargas/{load['id']}"}
    assert set(planners) == {ctx.ofi_id, ctx.admin_id}
    reps = [n for n in cargadas if n.user_id == ctx.com_id]
    assert [n.link for n in reps] == [f"/pedidos/{a['id']}"]
    assert ctx.fab_id not in {n.user_id for n in cargadas}

    # Albarán descargable
    r = client.get(f"{API}/{load['id']}/stops/{stop_a['id']}/delivery-note.pdf", headers=ctx.ofi)
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert r.content == b"%PDF-fake albaran"
    assert f'filename="ALB-{YEAR}-0001.pdf"' in r.headers["content-disposition"]

    # Entrega parcial: la carga sigue cargada
    assert loaded["allowed_actions"] == ["deliver"]
    url = f"{API}/{load['id']}/stops"
    r = client.post(
        f"{url}/{stop_a['id']}/deliver", headers=ctx.fab, json={"received_by": "Juan, encargado"}
    )
    assert r.status_code == 200, r.text
    partial = r.json()
    assert partial["status"] == "loaded"
    assert partial["stops"][0]["received_by"] == "Juan, encargado"
    assert partial["stops"][0]["delivered_at"] is not None
    assert partial["stops"][0]["order_status"] == "delivered"
    assert order_status(ctx, a) == OrderStatus.DELIVERED
    assert [n.user_id for n in notifications("pedido_entregado")] == [ctx.com_id]

    r = client.post(f"{url}/{stop_a['id']}/deliver", headers=ctx.fab, json={})
    assert (r.status_code, error(r)["code"]) == (409, "INVALID_STATUS")

    stop_b = load["stops"][1]
    r = client.post(f"{url}/{stop_b['id']}/deliver", headers=ctx.ofi, json={"notes": "Sin incid."})
    assert r.status_code == 200, r.text
    done = r.json()
    assert done["status"] == "delivered"
    assert done["delivered_at"] is not None
    assert done["allowed_actions"] == []
    assert order_status(ctx, b) == OrderStatus.DELIVERED
    # B no tiene comercial: no hay más avisos
    assert len(notifications("pedido_entregado")) == 1
    assert len(audits("carga.entregar")) == 2

    # Ya no se cancela una carga entregada
    act(client, ctx.ofi, load, "cancel", {"reason": "x"}, status=409)


def test_pesada_cuando_no_hay_stock_entonces_insufficient_stock_sin_efectos(client, ctx):
    a = make_order(ctx, "c1", [("ceb", 6000)])
    b = make_order(ctx, "c2", [("lec", 2000)])
    load = create(client, ctx, body(ctx, [a, b]))
    ready = act(client, ctx.ofi, load, "release")
    # Los lechones se intentan sacar del silo 1, que no tiene
    wrong = weigh_body(ready, {"P-CEB": ctx.m["s1"], "P-LEC": ctx.m["s1"]})
    r = client.post(f"{API}/{load['id']}/load", headers=ctx.fab, json=wrong)
    assert r.status_code == 409
    assert error(r)["code"] == "INSUFFICIENT_STOCK"

    after = client.get(f"{API}/{load['id']}", headers=ctx.fab).json()
    assert after["status"] == "ready"
    assert all(i["actual_kg"] is None for i in after["items"])
    assert all(s["delivery_note_number"] is None for s in after["stops"])
    assert load_out(ctx) == []
    assert order_status(ctx, a) == OrderStatus.PLANNED
    assert notifications("carga_cargada") == []

    loaded = act(client, ctx.fab, load, "load", weigh_body(ready, silos(ctx)))
    # Los números de albarán del intento fallido no se han gastado
    assert loaded["stops"][0]["delivery_note_number"] == f"ALB-{YEAR}-0001"


def test_pesada_cuando_datos_no_validos_entonces_400(client, ctx):
    a = make_order(ctx, "c1", [("ceb", 12000)])
    load = create(client, ctx, body(ctx, [a]))
    ready = act(client, ctx.ofi, load, "release")
    data = weigh_body(ready, silos(ctx))

    missing = {**data, "items": data["items"][:1]}
    r = client.post(f"{API}/{load['id']}/load", headers=ctx.fab, json=missing)
    assert (r.status_code, error(r)["field"]) == (400, "items")
    dup = {**data, "items": [data["items"][0], data["items"][0]]}
    r = client.post(f"{API}/{load['id']}/load", headers=ctx.fab, json=dup)
    assert (r.status_code, error(r)["field"]) == (400, "items")
    heavy_tare = {**data, "gross_kg": 10000, "tare_kg": 14000}
    r = client.post(f"{API}/{load['id']}/load", headers=ctx.fab, json=heavy_tare)
    assert (r.status_code, error(r)["field"]) == (400, "gross_kg")
    bad_silo = {**data, "items": [dict(i) for i in data["items"]]}
    bad_silo["items"][1]["silo_id"] = "00000000-0000-0000-0000-000000000001"
    r = client.post(f"{API}/{load['id']}/load", headers=ctx.fab, json=bad_silo)
    assert (r.status_code, error(r)["code"], error(r)["field"]) == (
        400,
        "INVALID_REFERENCE",
        "items.1.silo_id",
    )
    zero = {**data, "items": [{**data["items"][0], "actual_kg": 0}, data["items"][1]]}
    r = client.post(f"{API}/{load['id']}/load", headers=ctx.fab, json=zero)
    assert r.status_code == 422
    assert load_out(ctx) == []

    # Una carga planificada (no emitida) no se pesa
    act(client, ctx.ofi, load, "unrelease")
    r = client.post(f"{API}/{load['id']}/load", headers=ctx.fab, json=data)
    assert (r.status_code, error(r)["code"]) == (409, "INVALID_STATUS")


def test_pesada_cuando_no_hay_pdf_entonces_registra_y_albaran_503_hasta_poder(
    client, ctx, monkeypatch, fake_documents
):
    a = make_order(ctx)
    load = create(client, ctx, body(ctx, [a]))
    ready = act(client, ctx.ofi, load, "release")
    monkeypatch.setattr(documents, "render_delivery_note", _unavailable)
    monkeypatch.setattr(documents, "render_loading_order", _unavailable)

    r = client.get(f"{API}/{load['id']}/loading-order.pdf", headers=ctx.fab)
    assert (r.status_code, error(r)["code"]) == (503, "PDF_UNAVAILABLE")

    loaded = act(client, ctx.fab, load, "load", weigh_body(ready, silos(ctx)))
    assert loaded["status"] == "loaded"
    stop = loaded["stops"][0]
    assert stop["delivery_note_number"] == f"ALB-{YEAR}-0001"
    assert stop["delivery_note_ready"] is False
    assert fake_documents.files == {}
    url = f"{API}/{load['id']}/stops/{stop['id']}/delivery-note.pdf"
    r = client.get(url, headers=ctx.ofi)
    assert (r.status_code, error(r)["code"]) == (503, "PDF_UNAVAILABLE")

    # Cuando vuelve a poder, se genera al pedirlo y queda guardado
    monkeypatch.setattr(documents, "render_delivery_note", lambda data: b"%PDF-tarde")
    r = client.get(url, headers=ctx.ofi)
    assert r.status_code == 200
    assert r.content == b"%PDF-tarde"
    assert fake_documents.files[note_key(ctx.tenant_id, f"ALB-{YEAR}-0001")] == b"%PDF-tarde"
    detail = client.get(f"{API}/{load['id']}", headers=ctx.ofi).json()
    assert detail["stops"][0]["delivery_note_ready"] is True


def test_pdf_cuando_render_recibe_datos_entonces_reparto_y_pesada_reales(client, ctx, monkeypatch):
    captured = {}
    monkeypatch.setattr(
        documents, "render_loading_order", lambda data: captured.setdefault("lo", data) and b"%P"
    )
    monkeypatch.setattr(
        documents, "render_delivery_note", lambda data: captured.setdefault("dn", data) and b"%P"
    )
    a = make_order(ctx, "c1", [("ceb", 12000)])
    load = create(client, ctx, body(ctx, [a]))
    assert client.get(f"{API}/{load['id']}/loading-order.pdf", headers=ctx.ofi).status_code == 200
    order_data = captured["lo"]
    assert order_data.number == load["number"]
    assert order_data.transport.truck_plate == "1234KLM"
    assert order_data.compartments_kg == [8000, 8000, 8000]
    assert [(ln.compartment, ln.quantity_kg) for ln in order_data.stops[0].lines] == [
        (1, Decimal(8000)),
        (2, Decimal(4000)),
    ]
    assert order_data.stops[0].party.farm_rega == "ES300240000101"

    ready = act(client, ctx.ofi, load, "release")
    data = weigh_body(ready, silos(ctx))
    data["items"][1]["actual_kg"] = 3990
    act(client, ctx.fab, load, "load", data)
    note = captured["dn"]
    assert note.number == f"ALB-{YEAR}-0001"
    assert note.load_number == load["number"]
    assert note.company.name == "Piensos Norte"
    assert [ln.quantity_kg for ln in note.lines] == [Decimal(8000), Decimal(3990)]
    assert note.lines[0].factory_silo == "Silo 1"


# ─── Permisos, aislamiento y pendientes ────────────


def test_permisos_cuando_fabrica_o_comercial_entonces_403_segun_rol(client, ctx):
    a = make_order(ctx)
    # Fábrica ve y pesa, pero no planifica
    r = client.post(API, headers=ctx.fab, json=body(ctx, [a]))
    assert r.status_code == 403
    load = create(client, ctx, body(ctx, [a]))
    assert client.get(API, headers=ctx.fab).status_code == 200
    detail = client.get(f"{API}/{load['id']}", headers=ctx.fab).json()
    assert detail["allowed_actions"] == []
    act(client, ctx.fab, load, "release", status=403)
    act(client, ctx.fab, load, "cancel", {"reason": "x"}, status=403)
    ready = act(client, ctx.ofi, load, "release")
    # Oficina planifica pero no pesa
    act(client, ctx.ofi, load, "load", weigh_body(ready, silos(ctx)), status=403)

    # El comercial no ve logística
    assert client.get(API, headers=ctx.com).status_code == 403
    assert client.get(f"{API}/{load['id']}", headers=ctx.com).status_code == 403
    assert client.get("/api/v1/logistics/pending-orders", headers=ctx.com).status_code == 403
    r = client.get(f"{API}/{load['id']}/loading-order.pdf", headers=ctx.com)
    assert r.status_code == 403
    stop = ready["stops"][0]["id"]
    r = client.post(f"{API}/{load['id']}/stops/{stop}/deliver", headers=ctx.com, json={})
    assert r.status_code == 403


def test_aislamiento_cuando_otra_empresa_entonces_no_ve_ni_usa_cargas_ni_pedidos(
    client, ctx, make_tenant
):
    a = make_order(ctx)
    load = create(client, ctx, body(ctx, [a]))
    _other, other_email = make_tenant("Piensos Sur")
    other = auth(client, other_email)

    assert client.get(API, headers=other).json()["total"] == 0
    assert client.get(f"{API}/{load['id']}", headers=other).status_code == 404
    assert client.post(f"{API}/{load['id']}/release", headers=other).status_code == 404
    r = client.get(f"{API}/{load['id']}/loading-order.pdf", headers=other)
    assert r.status_code == 404
    pending = client.get("/api/v1/logistics/pending-orders", headers=other).json()
    assert pending["total"] == 0

    # Con su propio camión, el pedido de la otra empresa no existe
    with new_session(tenant_id=_other.id) as db:
        truck = Truck(tenant_id=_other.id, plate="9999ZZZ", compartments=[30000])
        db.add(truck)
        db.commit()
        truck_id = str(truck.id)
    b = make_order(ctx, "c2", [("lec", 1000)])
    r = client.post(API, headers=other, json=body(ctx, [b], truck_id=truck_id, driver_id=None))
    assert (r.status_code, error(r)["code"], error(r)["field"]) == (
        400,
        "INVALID_REFERENCE",
        "stops.0.order_id",
    )
    r = client.post(API, headers=other, json=body(ctx, [b], driver_id=None))
    assert (r.status_code, error(r)["field"]) == (400, "truck_id")


def test_pending_orders_cuando_hay_pedidos_entonces_solo_confirmados_sin_carga_en_plazo(
    client, ctx
):
    soon = make_order(ctx, "c1", [("ceb", 6000), ("lec", 1000)], days=1)
    today = make_order(ctx, "c2", [("lec", 2000)], days=0)
    make_order(ctx, "c1", status=OrderStatus.PENDING)
    far = make_order(ctx, "c2", days=20)
    planned = make_order(ctx, "c1", [("ceb", 4000)])
    create(client, ctx, body(ctx, [planned]))

    url = "/api/v1/logistics/pending-orders"
    r = client.get(url, headers=ctx.fab)
    assert r.status_code == 200, r.text
    page = r.json()
    assert [o["number"] for o in page["items"]] == [today["number"], soon["number"]]
    assert page["total"] == 2
    first = page["items"][1]
    assert first["customer_name"] == "Granja Los Pinos"
    assert first["farm_city"] == "Lorca"
    assert first["status"] == "confirmed"
    assert [(ln["item_code"], ln["quantity_kg"]) for ln in first["lines"]] == [
        ("P-CEB", 6000),
        ("P-LEC", 1000),
    ]
    assert first["lines"][0]["farm_silo"] == "Silo 1"

    later = (today_madrid() + timedelta(days=30)).isoformat()
    numbers = [
        o["number"] for o in client.get(f"{url}?date_to={later}", headers=ctx.ofi).json()["items"]
    ]
    assert far["number"] in numbers and planned["number"] not in numbers
    found = client.get(f"{url}?search=segura", headers=ctx.ofi).json()
    assert [o["number"] for o in found["items"]] == [today["number"]]


def test_listado_cuando_filtros_entonces_por_fecha_estado_y_camion(client, ctx):
    a = make_order(ctx, "c1", [("ceb", 4000)])
    b = make_order(ctx, "c2", [("lec", 1000)])
    first = create(client, ctx, body(ctx, [a], days=1))
    second = create(client, ctx, body(ctx, [b], days=2))
    act(client, ctx.ofi, second, "release")

    def numbers(query: str) -> list[str]:
        r = client.get(f"{API}{query}", headers=ctx.ofi)
        assert r.status_code == 200, r.text
        return [i["number"] for i in r.json()["items"]]

    assert numbers("") == [second["number"], first["number"]]
    tomorrow = (today_madrid() + timedelta(days=1)).isoformat()
    assert numbers(f"?date={tomorrow}") == [first["number"]]
    assert numbers(f"?date_from={tomorrow}&date_to={tomorrow}") == [first["number"]]
    assert numbers("?status=ready") == [second["number"]]
    assert numbers("?status=planned,ready") == [second["number"], first["number"]]
    assert numbers(f"?truck_id={ctx.m['old']}") == []
    r = client.get(f"{API}?status=nope", headers=ctx.ofi)
    assert (r.status_code, error(r)["field"]) == (400, "status")
