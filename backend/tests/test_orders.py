"""Pedidos de los comerciales: ciclo de estados, precios, alcance, riesgo, avisos y resumen."""

from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal
from uuid import UUID

import pytest
from sqlmodel import select

from app.core.db import new_session
from app.modules.masters.models import (
    Customer,
    CustomerPrice,
    Farm,
    Item,
    ItemKind,
    PriceList,
    PriceListLine,
    Silo,
)
from app.modules.notifications.models import Notification
from app.modules.orders.service import today_madrid
from app.modules.platform.models import AuditLog
from app.modules.stock.models import MovementKind, StockMovement
from tests.conftest import auth, get_user, invite_user

API = "/api/v1/orders"


@dataclass
class Ctx:
    tenant_id: UUID
    admin: dict[str, str]
    com: dict[str, str]  # comercial@ (lleva C1)
    otro: dict[str, str]  # otro comercial (lleva C2)
    ofi: dict[str, str]  # oficina (valida)
    com_id: UUID
    otro_id: UUID
    ofi_id: UUID
    admin_id: UUID
    m: dict[str, str]


def _masters(tenant_id: UUID, com_id: UUID, otro_id: UUID) -> dict[str, str]:
    """Piensos, tarifa, dos clientes con su explotación y stock de P-CEB."""
    with new_session(tenant_id=tenant_id) as db:

        def add(row):
            db.add(row)
            db.flush()
            return row

        t = tenant_id
        ceb = add(
            Item(
                tenant_id=t,
                code="P-CEB",
                name="Cebo",
                kind=ItemKind.PRODUCT,
                base_price=Decimal("0.3150"),
            )
        )
        lec = add(
            Item(
                tenant_id=t,
                code="P-LEC",
                name="Lechones",
                kind=ItemKind.PRODUCT,
                base_price=Decimal("0.4500"),
            )
        )
        sin = add(Item(tenant_id=t, code="P-SIN", name="Sin precio", kind=ItemKind.PRODUCT))
        mp = add(Item(tenant_id=t, code="MP-MAI", name="Maíz", kind=ItemKind.RAW_MATERIAL))
        tariff = add(PriceList(tenant_id=t, name="Tarifa"))
        add(
            PriceListLine(
                tenant_id=t, price_list_id=tariff.id, item_id=lec.id, price=Decimal("0.4300")
            )
        )
        c1 = add(
            Customer(
                tenant_id=t,
                code="C1",
                name="Granja Los Pinos",
                sales_rep_id=com_id,
                price_list_id=tariff.id,
                credit_limit=Decimal(10000),
            )
        )
        add(CustomerPrice(tenant_id=t, customer_id=c1.id, item_id=ceb.id, price=Decimal("0.30")))
        c2 = add(Customer(tenant_id=t, code="C2", name="Porcinos del Segura", sales_rep_id=otro_id))
        silos = [{"name": "Silo 1", "capacity_kg": 14000}, {"name": "Silo 2", "capacity_kg": 10000}]
        f1 = add(Farm(tenant_id=t, customer_id=c1.id, name="Explotación Lorca", silos=silos))
        f2 = add(Farm(tenant_id=t, customer_id=c2.id, name="Explotación Cieza", silos=silos))
        s1 = add(Silo(tenant_id=t, code="S1", name="Silo 1"))
        add(
            StockMovement(
                tenant_id=t,
                item_id=ceb.id,
                silo_id=s1.id,
                kind=MovementKind.INVENTORY,
                quantity_kg=Decimal(20000),
            )
        )
        db.commit()
        rows = {"ceb": ceb, "lec": lec, "sin": sin, "mp": mp, "c1": c1, "c2": c2}
        rows |= {"f1": f1, "f2": f2}
        return {k: str(v.id) for k, v in rows.items()}


@pytest.fixture
def ctx(client, make_tenant) -> Ctx:
    tenant, admin_email = make_tenant()
    admin = auth(client, admin_email)
    com = invite_user(client, admin, "comercial@norte.es", ["Comercial"])
    otro = invite_user(client, admin, "otro@norte.es", ["Comercial"])
    ofi = invite_user(client, admin, "oficina@norte.es", ["Oficina"])
    ids = {e: get_user(e).id for e in ("comercial@norte.es", "otro@norte.es", "oficina@norte.es")}
    return Ctx(
        tenant_id=tenant.id,
        admin=admin,
        com=com,
        otro=otro,
        ofi=ofi,
        com_id=ids["comercial@norte.es"],
        otro_id=ids["otro@norte.es"],
        ofi_id=ids["oficina@norte.es"],
        admin_id=get_user(admin_email).id,
        m=_masters(tenant.id, ids["comercial@norte.es"], ids["otro@norte.es"]),
    )


def _day(offset: int = 1) -> str:
    return (today_madrid() + timedelta(days=offset)).isoformat()


def body(ctx: Ctx, customer="c1", farm="f1", lines=None, days=1, **extra) -> dict:
    return {
        "customer_id": ctx.m[customer],
        "farm_id": ctx.m[farm],
        "requested_date": _day(days),
        "lines": lines
        if lines is not None
        else [{"item_id": ctx.m["ceb"], "quantity_kg": 12000, "farm_silo": "Silo 1"}],
        **extra,
    }


def create(client, headers, data: dict, status: int = 201) -> dict:
    r = client.post(API, headers=headers, json=data)
    assert r.status_code == status, r.text
    return r.json()


def act(client, headers, order: dict, action: str, data: dict | None = None, status=200):
    r = client.post(f"{API}/{order['id']}/{action}", headers=headers, json=data or {})
    assert r.status_code == status, r.text
    return r.json()


def confirmed(client, ctx: Ctx, data: dict) -> dict:
    """Pedido creado por oficina, enviado y validado (forzando el riesgo si hace falta)."""
    order = create(client, ctx.ofi, {**data, "submit": True})
    return act(client, ctx.ofi, order, "validate", {"force": True})


def notifications(type_: str) -> list[Notification]:
    with new_session(bypass_rls=True) as db:
        return list(db.exec(select(Notification).where(Notification.type == type_)).all())


def audits(action: str) -> list[AuditLog]:
    with new_session(bypass_rls=True) as db:
        return list(db.exec(select(AuditLog).where(AuditLog.action == action)).all())


def error(r) -> dict:
    """Error de una respuesta o del JSON ya devuelto por `act`."""
    return (r if isinstance(r, dict) else r.json())["error"]


# ─── Ciclo de estados ──────────────────────────────


def test_ciclo_cuando_borrador_se_envia_y_valida_entonces_confirmado_y_avisa(client, ctx):
    order = create(client, ctx.com, body(ctx))
    assert order["status"] == "draft"
    assert order["number"] == f"PED-{today_madrid().year}-0001"
    assert order["sales_rep_id"] == str(ctx.com_id)
    assert order["created_by_name"] == "comercial"
    assert set(order["allowed_actions"]) == {"edit", "submit", "cancel"}

    pending = act(client, ctx.com, order, "submit")
    assert pending["status"] == "pending"
    assert pending["submitted_at"] is not None
    assert pending["allowed_actions"] == ["cancel"]
    # Avisa a quienes pueden validar (oficina y admin), no a quien lo envía
    recipients = {n.user_id for n in notifications("pedido_pendiente")}
    assert recipients == {ctx.ofi_id, ctx.admin_id}
    assert notifications("pedido_pendiente")[0].link == f"/pedidos/{order['id']}"

    done = act(client, ctx.ofi, order, "validate", {"notes": "OK"})
    assert done["status"] == "confirmed"
    assert done["validated_by_name"] == "oficina"
    assert done["validated_at"] is not None
    assert done["updated_at"] > pending["updated_at"]
    assert [n.user_id for n in notifications("pedido_confirmado")] == [ctx.com_id]
    assert [a.data for a in audits("pedido.validar")] == [
        {"numero": order["number"], "notas": "OK"}
    ]
    assert len(audits("pedido.crear")) == 1
    assert len(audits("pedido.enviar")) == 1


def test_rechazo_cuando_se_corrige_y_reenvia_entonces_vuelve_a_pendiente(client, ctx):
    order = create(client, ctx.com, body(ctx, submit=True))
    assert order["status"] == "pending"

    rejected = act(client, ctx.ofi, order, "reject", {"reason": "Precio fuera de tarifa"})
    assert rejected["status"] == "rejected"
    assert rejected["status_reason"] == "Precio fuera de tarifa"
    avisos = notifications("pedido_rechazado")
    assert [n.user_id for n in avisos] == [ctx.com_id]
    assert "Precio fuera de tarifa" in avisos[0].body

    lines = [{"item_id": ctx.m["ceb"], "quantity_kg": 8000, "farm_silo": "Silo 2"}]
    r = client.put(
        f"{API}/{order['id']}", headers=ctx.com, json=body(ctx, lines=lines, submit=True)
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "pending"
    assert r.json()["total_kg"] == 8000
    assert len(audits("pedido.editar")) == 1
    assert len(audits("pedido.rechazar")) == 1


def test_transicion_cuando_no_permitida_desde_el_estado_entonces_409(client, ctx):
    order = create(client, ctx.ofi, body(ctx))
    assert error(act(client, ctx.ofi, order, "validate", status=409))["code"] == "INVALID_STATUS"
    assert error(act(client, ctx.ofi, order, "reject", {"reason": "x"}, 409))["code"] == (
        "INVALID_STATUS"
    )
    done = confirmed(client, ctx, body(ctx))
    assert error(act(client, ctx.ofi, done, "submit", status=409))["code"] == "INVALID_STATUS"
    r = client.put(f"{API}/{done['id']}", headers=ctx.ofi, json=body(ctx))
    assert error(r)["code"] == "INVALID_STATUS"
    cancelled = act(client, ctx.ofi, done, "cancel", {"reason": "El cliente no lo quiere"})
    assert cancelled["status"] == "cancelled"
    assert cancelled["status_reason"] == "El cliente no lo quiere"
    assert error(act(client, ctx.ofi, done, "cancel", {"reason": "x"}, 409))["code"] == (
        "INVALID_STATUS"
    )


def test_motivo_cuando_falta_en_rechazo_o_cancelacion_entonces_error_de_validacion(client, ctx):
    order = create(client, ctx.com, body(ctx, submit=True))
    assert act(client, ctx.ofi, order, "reject", {"reason": "  "}, 422)
    assert act(client, ctx.com, order, "cancel", {}, 422)


def test_comercial_cuando_cancela_su_pendiente_entonces_cancelado(client, ctx):
    order = create(client, ctx.com, body(ctx, submit=True))
    cancelled = act(client, ctx.com, order, "cancel", {"reason": "Duplicado"})
    assert cancelled["status"] == "cancelled"
    assert cancelled["allowed_actions"] == []
    assert len(audits("pedido.cancelar")) == 1


# ─── Precios ───────────────────────────────────────


def test_precio_cuando_se_omite_entonces_negociado_tarifa_o_general(client, ctx):
    lines = [
        {"item_id": ctx.m["ceb"], "quantity_kg": 1000},
        {"item_id": ctx.m["lec"], "quantity_kg": 1000},
    ]
    order = create(client, ctx.ofi, body(ctx, lines=lines))
    got = [(ln["price_source"], ln["unit_price"], ln["reference_price"]) for ln in order["lines"]]
    assert got == [("customer", 0.30, 0.30), ("price_list", 0.43, 0.43)]
    assert [ln["position"] for ln in order["lines"]] == [1, 2]

    other = create(
        client,
        ctx.ofi,
        body(ctx, "c2", "f2", lines=[{"item_id": ctx.m["ceb"], "quantity_kg": 1000}]),
    )
    assert other["lines"][0]["price_source"] == "base"
    assert other["lines"][0]["unit_price"] == 0.315


def test_precio_cuando_se_envia_entonces_manual_si_difiere_de_referencia(client, ctx):
    lines = [
        {"item_id": ctx.m["ceb"], "quantity_kg": 1000, "unit_price": 0.29},
        {"item_id": ctx.m["lec"], "quantity_kg": 1000, "unit_price": 0.43},
        {"item_id": ctx.m["sin"], "quantity_kg": 1000, "unit_price": 0.5},
    ]
    order = create(client, ctx.com, body(ctx, lines=lines))
    got = [(ln["price_source"], ln["reference_price"]) for ln in order["lines"]]
    assert got == [("manual", 0.30), ("price_list", 0.43), ("manual", None)]
    # Por debajo de su referencia en la primera línea
    assert order["has_manual_price"] is True
    listed = client.get(API, headers=ctx.com).json()["items"][0]
    assert listed["has_manual_price"] is True
    assert listed["line_count"] == 3


def test_precio_cuando_no_hay_ninguno_y_se_omite_entonces_price_required(client, ctx):
    lines = [
        {"item_id": ctx.m["ceb"], "quantity_kg": 1000},
        {"item_id": ctx.m["sin"], "quantity_kg": 1000},
    ]
    r = client.post(API, headers=ctx.com, json=body(ctx, lines=lines))
    assert r.status_code == 400
    assert error(r)["code"] == "PRICE_REQUIRED"
    assert error(r)["field"] == "lines.1.unit_price"


def test_totales_cuando_varias_lineas_entonces_se_calculan_y_redondean(client, ctx):
    lines = [
        {"item_id": ctx.m["ceb"], "quantity_kg": 12000},  # 0,30 → 3600
        {"item_id": ctx.m["lec"], "quantity_kg": 5000},  # 0,43 → 2150
        {"item_id": ctx.m["sin"], "quantity_kg": 333.33, "unit_price": 0.3333},  # 111,0989
    ]
    order = create(client, ctx.com, body(ctx, lines=lines))
    assert [ln["amount"] for ln in order["lines"]] == [3600, 2150, 111.10]
    assert order["total_kg"] == 17333.33
    assert order["total_amount"] == 5861.10


# ─── Validación de la entrada ──────────────────────


def test_explotacion_cuando_es_de_otro_cliente_entonces_400(client, ctx):
    r = client.post(API, headers=ctx.ofi, json=body(ctx, "c1", "f2"))
    assert r.status_code == 400
    assert (error(r)["code"], error(r)["field"]) == ("INVALID_REFERENCE", "farm_id")


def test_silo_cuando_no_existe_en_la_explotacion_entonces_400(client, ctx):
    lines = [{"item_id": ctx.m["ceb"], "quantity_kg": 1000, "farm_silo": "Silo 9"}]
    r = client.post(API, headers=ctx.ofi, json=body(ctx, lines=lines))
    assert r.status_code == 400
    assert (error(r)["code"], error(r)["field"]) == ("INVALID_REFERENCE", "lines.0.farm_silo")


def test_articulo_cuando_es_materia_prima_entonces_invalid_item_kind(client, ctx):
    lines = [{"item_id": ctx.m["mp"], "quantity_kg": 1000}]
    r = client.post(API, headers=ctx.ofi, json=body(ctx, lines=lines))
    assert r.status_code == 400
    assert (error(r)["code"], error(r)["field"]) == ("INVALID_ITEM_KIND", "lines.0.item_id")


def test_lineas_cuando_se_repite_pienso_y_silo_entonces_400_con_linea(client, ctx):
    line = {"item_id": ctx.m["ceb"], "quantity_kg": 1000, "farm_silo": "Silo 1"}
    other_silo = {**line, "farm_silo": "Silo 2"}
    r = client.post(API, headers=ctx.ofi, json=body(ctx, lines=[line, other_silo, line]))
    assert r.status_code == 400
    assert (error(r)["code"], error(r)["field"]) == ("VALIDATION_ERROR", "lines.2")
    assert client.post(API, headers=ctx.ofi, json=body(ctx, lines=[])).status_code == 422


def test_fecha_cuando_es_anterior_a_hoy_entonces_400(client, ctx):
    r = client.post(API, headers=ctx.com, json=body(ctx, days=-1))
    assert r.status_code == 400
    assert (error(r)["code"], error(r)["field"]) == ("VALIDATION_ERROR", "requested_date")
    # Hoy sí vale
    assert client.post(API, headers=ctx.com, json=body(ctx, days=0)).status_code == 201


def test_numeracion_cuando_varios_pedidos_entonces_correlativa(client, ctx):
    year = today_madrid().year
    numbers = [create(client, ctx.com, body(ctx))["number"] for _ in range(2)]
    assert numbers == [f"PED-{year}-0001", f"PED-{year}-0002"]
    # Una petición errónea no gasta número
    client.post(API, headers=ctx.com, json=body(ctx, days=-3))
    assert create(client, ctx.com, body(ctx))["number"] == f"PED-{year}-0003"


def test_comercial_cuando_omite_sales_rep_entonces_oficina_usa_el_del_cliente(client, ctx):
    order = create(client, ctx.ofi, body(ctx))
    assert order["sales_rep_id"] == str(ctx.com_id)
    assert order["sales_rep_name"] == "comercial"
    explicit = create(client, ctx.ofi, body(ctx, sales_rep_id=str(ctx.otro_id)))
    assert explicit["sales_rep_id"] == str(ctx.otro_id)


# ─── Alcance del comercial y permisos ──────────────


def test_comercial_cuando_pedido_de_cliente_ajeno_entonces_404_y_no_lo_lista(client, ctx):
    ajeno = create(client, ctx.otro, body(ctx, "c2", "f2"))
    # Lo crea oficina, pero el cliente es suyo: lo ve
    suyo = create(client, ctx.ofi, body(ctx, sales_rep_id=str(ctx.otro_id)))

    listed = client.get(API, headers=ctx.com).json()
    assert [o["id"] for o in listed["items"]] == [suyo["id"]]
    assert client.get(f"{API}/{ajeno['id']}", headers=ctx.com).status_code == 404
    assert client.get(f"{API}/{ajeno['id']}/checks", headers=ctx.com).status_code == 404
    assert client.put(f"{API}/{ajeno['id']}", headers=ctx.com, json=body(ctx)).status_code == 404
    act(client, ctx.com, ajeno, "submit", status=404)
    act(client, ctx.com, ajeno, "cancel", {"reason": "x"}, 404)
    assert client.get(f"{API}/{suyo['id']}", headers=ctx.com).status_code == 200


def test_comercial_cuando_crea_para_cliente_ajeno_entonces_400(client, ctx):
    r = client.post(API, headers=ctx.com, json=body(ctx, "c2", "f2"))
    assert r.status_code == 400
    assert (error(r)["code"], error(r)["field"]) == ("INVALID_REFERENCE", "customer_id")


def test_comercial_cuando_envia_otro_sales_rep_entonces_se_fuerza_el_suyo(client, ctx):
    order = create(client, ctx.com, body(ctx, sales_rep_id=str(ctx.otro_id)))
    assert order["sales_rep_id"] == str(ctx.com_id)


def test_comercial_cuando_valida_o_rechaza_entonces_403(client, ctx):
    order = create(client, ctx.com, body(ctx, submit=True))
    assert error(act(client, ctx.com, order, "validate", status=403))["code"] == "FORBIDDEN"
    act(client, ctx.com, order, "reject", {"reason": "x"}, 403)
    # Editar un pendiente es cosa de oficina
    r = client.put(f"{API}/{order['id']}", headers=ctx.com, json=body(ctx))
    assert r.status_code == 403


def test_allowed_actions_cuando_cambia_rol_y_estado_entonces_las_que_tocan(client, ctx):
    def actions(headers, order):
        return set(client.get(f"{API}/{order['id']}", headers=headers).json()["allowed_actions"])

    draft = create(client, ctx.com, body(ctx))
    assert actions(ctx.com, draft) == {"edit", "submit", "cancel"}
    assert actions(ctx.ofi, draft) == {"edit", "submit", "cancel"}

    act(client, ctx.com, draft, "submit")
    assert actions(ctx.com, draft) == {"cancel"}
    assert actions(ctx.ofi, draft) == {"edit", "validate", "reject", "cancel"}

    act(client, ctx.ofi, draft, "validate")
    assert actions(ctx.com, draft) == set()
    assert actions(ctx.ofi, draft) == {"cancel"}
    act(client, ctx.com, draft, "cancel", {"reason": "x"}, 403)


def test_oficina_cuando_edita_pendiente_entonces_guarda_y_sigue_pendiente(client, ctx):
    order = create(client, ctx.com, body(ctx, submit=True))
    lines = [{"item_id": ctx.m["ceb"], "quantity_kg": 9000, "unit_price": 0.31}]
    r = client.put(f"{API}/{order['id']}", headers=ctx.ofi, json=body(ctx, lines=lines, days=3))
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["status"] == "pending"
    assert data["total_amount"] == 2790
    assert data["sales_rep_id"] == str(ctx.com_id)
    assert data["updated_at"] > order["updated_at"]
    r = client.put(f"{API}/{order['id']}", headers=ctx.ofi, json=body(ctx, days=-1))
    assert error(r)["field"] == "requested_date"


# ─── Riesgo y comprobaciones ───────────────────────


def test_validar_cuando_supera_riesgo_entonces_409_y_con_force_pasa_auditado(client, ctx):
    # C1 tiene 10.000 € de límite; ya hay 6.000 € confirmados
    confirmed(client, ctx, body(ctx, lines=[{"item_id": ctx.m["ceb"], "quantity_kg": 20000}]))
    order = create(
        client,
        ctx.com,
        body(ctx, lines=[{"item_id": ctx.m["ceb"], "quantity_kg": 15000}], submit=True),
    )
    checks = client.get(f"{API}/{order['id']}/checks", headers=ctx.ofi).json()
    assert checks["credit"] == {
        "credit_limit": 10000,
        "outstanding_amount": 6000,
        "order_amount": 4500,
        "available": -500,
        "exceeded": True,
    }
    r = client.post(f"{API}/{order['id']}/validate", headers=ctx.ofi, json={})
    assert r.status_code == 409
    assert error(r)["code"] == "CREDIT_LIMIT_EXCEEDED"
    assert client.get(f"{API}/{order['id']}", headers=ctx.ofi).json()["status"] == "pending"

    done = act(client, ctx.ofi, order, "validate", {"force": True})
    assert done["status"] == "confirmed"
    forced = [a.data for a in audits("pedido.validar") if a.entity_id == order["id"]]
    assert forced == [{"numero": order["number"], "forzado": True}]


def test_riesgo_cuando_cliente_sin_limite_entonces_nunca_excede(client, ctx):
    order = create(client, ctx.ofi, body(ctx, "c2", "f2"))
    credit = client.get(f"{API}/{order['id']}/checks", headers=ctx.ofi).json()["credit"]
    assert credit["credit_limit"] is None
    assert credit["available"] is None
    assert credit["exceeded"] is False


def test_checks_cuando_precio_bajo_y_stock_comprometido_entonces_los_detalla(client, ctx):
    # 8.000 kg de P-CEB ya comprometidos en otro pedido confirmado (sin cargar)
    confirmed(client, ctx, body(ctx, "c2", "f2", [{"item_id": ctx.m["ceb"], "quantity_kg": 8000}]))
    lines = [
        {"item_id": ctx.m["ceb"], "quantity_kg": 10000, "unit_price": 0.29, "farm_silo": "Silo 1"},
        {"item_id": ctx.m["ceb"], "quantity_kg": 5000, "farm_silo": "Silo 2"},
        {"item_id": ctx.m["lec"], "quantity_kg": 1000},
    ]
    order = create(client, ctx.com, body(ctx, lines=lines))
    checks = client.get(f"{API}/{order['id']}/checks", headers=ctx.com).json()
    assert checks["prices"] == [
        {
            "line_id": order["lines"][0]["id"],
            "item_code": "P-CEB",
            "item_name": "Cebo",
            "unit_price": 0.29,
            "reference_price": 0.30,
            "difference_pct": -3.33,
        }
    ]
    by_code = {s["item_code"]: s for s in checks["stock"]}
    assert by_code["P-CEB"] == {
        "item_id": ctx.m["ceb"],
        "item_code": "P-CEB",
        "item_name": "Cebo",
        "requested_kg": 15000,
        "stock_kg": 20000,
        "committed_kg": 8000,
        "short": True,
    }
    assert by_code["P-LEC"]["stock_kg"] == 0
    assert by_code["P-LEC"]["short"] is True


# ─── Aislamiento, resumen y filtros ────────────────


def test_aislamiento_cuando_otra_empresa_entonces_no_ve_sus_pedidos(client, ctx, make_tenant):
    order = create(client, ctx.com, body(ctx))
    _, other_email = make_tenant("Piensos Sur")
    other = auth(client, other_email)
    assert client.get(API, headers=other).json()["total"] == 0
    assert client.get(f"{API}/{order['id']}", headers=other).status_code == 404
    act(client, other, order, "cancel", {"reason": "x"}, 404)
    # Tampoco puede usar los maestros de la primera
    r = client.post(API, headers=other, json=body(ctx))
    assert error(r)["code"] == "INVALID_REFERENCE"


def test_summary_cuando_hay_aceptados_entonces_agrupa_por_dia_y_alcance(client, ctx):
    confirmed(client, ctx, body(ctx, days=1))
    confirmed(client, ctx, body(ctx, days=1))
    confirmed(client, ctx, body(ctx, "c2", "f2", days=2))
    create(client, ctx.ofi, body(ctx, days=1, submit=True))  # pendiente: no cuenta
    params = {"date_from": _day(0), "date_to": _day(6)}

    r = client.get(f"{API}/summary", headers=ctx.ofi, params=params)
    assert r.status_code == 200, r.text
    assert r.json() == [
        {"date": _day(1), "orders": 2, "total_kg": 24000},
        {"date": _day(2), "orders": 1, "total_kg": 12000},
    ]
    mine = client.get(f"{API}/summary", headers=ctx.com, params=params).json()
    assert mine == [{"date": _day(1), "orders": 2, "total_kg": 24000}]


def test_summary_cuando_rango_supera_62_dias_entonces_400(client, ctx):
    ok = {"date_from": _day(0), "date_to": _day(61)}
    assert client.get(f"{API}/summary", headers=ctx.ofi, params=ok).status_code == 200
    wide = {"date_from": _day(0), "date_to": _day(62)}
    r = client.get(f"{API}/summary", headers=ctx.ofi, params=wide)
    assert r.status_code == 400
    assert error(r)["code"] == "VALIDATION_ERROR"
    reversed_ = {"date_from": _day(3), "date_to": _day(1)}
    assert client.get(f"{API}/summary", headers=ctx.ofi, params=reversed_).status_code == 400


def test_listado_cuando_filtros_status_mine_y_search_entonces_filtra(client, ctx):
    draft = create(client, ctx.com, body(ctx, days=1))
    pending = create(client, ctx.com, body(ctx, days=2, submit=True))
    done = confirmed(client, ctx, body(ctx, "c2", "f2", days=3))

    def ids(headers, **params):
        r = client.get(API, headers=headers, params=params)
        assert r.status_code == 200, r.text
        return [o["id"] for o in r.json()["items"]]

    # Orden: fecha de entrega descendente
    assert ids(ctx.ofi) == [done["id"], pending["id"], draft["id"]]
    assert ids(ctx.ofi, status="draft,pending") == [pending["id"], draft["id"]]
    assert ids(ctx.ofi, status="confirmed") == [done["id"]]
    assert ids(ctx.com, mine="true") == [pending["id"], draft["id"]]
    assert ids(ctx.ofi, mine="true") == [done["id"]]  # lo creó oficina
    assert ids(ctx.ofi, search="segura") == [done["id"]]
    assert ids(ctx.ofi, search="c2") == [done["id"]]
    assert ids(ctx.ofi, search=draft["number"]) == [draft["id"]]
    assert ids(ctx.ofi, customer_id=ctx.m["c2"]) == [done["id"]]
    assert ids(ctx.ofi, sales_rep_id=str(ctx.otro_id)) == [done["id"]]
    assert ids(ctx.ofi, date_from=_day(2), date_to=_day(2)) == [pending["id"]]
    r = client.get(API, headers=ctx.ofi, params={"status": "draft,nope"})
    assert (r.status_code, error(r)["field"]) == (400, "status")

    summary = client.get(API, headers=ctx.ofi, params={"status": "draft"}).json()["items"][0]
    assert summary["customer_code"] == "C1"
    assert summary["farm_name"] == "Explotación Lorca"
    assert summary["line_count"] == 1
    assert summary["has_manual_price"] is False


def test_sin_permiso_cuando_rol_fabrica_entonces_403(client, ctx):
    fabrica = invite_user(client, ctx.admin, "fabrica@norte.es", ["Fábrica"])
    assert client.get(API, headers=fabrica).status_code == 403
    assert client.post(API, headers=fabrica, json=body(ctx)).status_code == 403
