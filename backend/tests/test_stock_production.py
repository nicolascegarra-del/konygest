"""Stock (entradas, ajustes, inventarios, saldos) y órdenes de fabricación."""

from decimal import Decimal
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlmodel import select

from app.core.db import new_session
from app.modules.masters.models import Item, ItemKind, Silo
from app.modules.notifications.models import Notification
from tests.conftest import auth, invite_user

API = "/api/v1"


def make_masters(tenant_id: UUID, min_stock: int = 0) -> dict[str, str]:
    """Crea directamente en BD una materia prima, un pienso y dos silos."""
    with new_session(tenant_id=tenant_id) as db:
        rows = {
            "mp": Item(
                tenant_id=tenant_id,
                code="MP-MAIZ",
                name="Maíz",
                kind=ItemKind.RAW_MATERIAL,
                min_stock_kg=Decimal(min_stock),
            ),
            "pienso": Item(
                tenant_id=tenant_id, code="P-CERDO", name="Pienso cerdo", kind=ItemKind.PRODUCT
            ),
            "inactivo": Item(
                tenant_id=tenant_id,
                code="MP-OLD",
                name="Cebada antigua",
                kind=ItemKind.RAW_MATERIAL,
                is_active=False,
            ),
            "s1": Silo(tenant_id=tenant_id, code="S1", name="Silo 1"),
            "s2": Silo(tenant_id=tenant_id, code="S2", name="Silo 2"),
        }
        for row in rows.values():
            db.add(row)
        db.commit()
        return {k: str(v.id) for k, v in rows.items()}


def receipt(client, headers, m, gross=1000, tare=200, item="mp", silo="s1"):
    return client.post(
        f"{API}/stock/receipts",
        headers=headers,
        json={
            "item_id": m[item],
            "silo_id": m[silo],
            "supplier": "Cereales SA",
            "delivery_note": "AB-1",
            "plate": "1234abc",
            "gross_kg": gross,
            "tare_kg": tare,
        },
    )


def adjust(client, headers, m, qty, item="mp", silo="s1", reason="Merma"):
    return client.post(
        f"{API}/stock/adjustments",
        headers=headers,
        json={"item_id": m[item], "silo_id": m[silo], "quantity_kg": qty, "reason": reason},
    )


def level(client, headers, m, item="mp", silo="s1") -> float:
    r = client.get(
        f"{API}/stock/levels", headers=headers, params={"item_id": m[item], "silo_id": m[silo]}
    )
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    return items[0]["quantity_kg"] if items else 0


@pytest.fixture
def setup(tenant_admin):
    tenant, headers = tenant_admin
    return tenant, headers, make_masters(tenant.id)


# ─── Movimientos y saldos ──────────────────────────


def test_entrada_mp_cuando_bruto_y_tara_validos_entonces_suma_neto_al_stock(client, setup):
    _, headers, m = setup
    r = receipt(client, headers, m)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["number"].startswith("EMP-") and body["number"].endswith("-0001")
    assert body["net_kg"] == 800
    assert body["plate"] == "1234ABC"
    assert body["item_name"] == "Maíz" and body["silo_name"] == "Silo 1"
    assert body["user_name"]
    assert level(client, headers, m) == 800

    movs = client.get(f"{API}/stock/movements", headers=headers).json()
    assert movs["total"] == 1
    mov = movs["items"][0]
    assert mov["kind"] == "raw_material_in"
    assert mov["source_type"] == "raw_material_receipt"
    assert mov["source_id"] == body["id"]
    assert mov["item_code"] == "MP-MAIZ" and mov["silo_code"] == "S1"

    listed = client.get(f"{API}/stock/receipts", headers=headers).json()
    assert listed["total"] == 1 and listed["items"][0]["net_kg"] == 800


def test_entrada_mp_cuando_neto_no_positivo_entonces_400(client, setup):
    _, headers, m = setup
    r = receipt(client, headers, m, gross=500, tare=500)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"
    assert r.json()["error"]["field"] == "tare_kg"


def test_entrada_mp_cuando_articulo_es_pienso_entonces_400(client, setup):
    _, headers, m = setup
    r = receipt(client, headers, m, item="pienso")
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "INVALID_ITEM_KIND"
    assert r.json()["error"]["field"] == "item_id"


def test_entrada_mp_cuando_articulo_inactivo_entonces_invalid_reference(client, setup):
    _, headers, m = setup
    r = receipt(client, headers, m, item="inactivo")
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "INVALID_REFERENCE"
    assert r.json()["error"]["field"] == "item_id"


def test_ajuste_cuando_positivo_y_negativo_entonces_actualiza_saldo(client, setup):
    _, headers, m = setup
    receipt(client, headers, m)
    r = adjust(client, headers, m, 50, reason="Recuento")
    assert r.status_code == 201, r.text
    assert r.json()["kind"] == "adjustment" and r.json()["notes"] == "Recuento"
    assert level(client, headers, m) == 850
    assert adjust(client, headers, m, -150.5).status_code == 201
    assert level(client, headers, m) == 699.5


def test_ajuste_cuando_dejaria_stock_negativo_entonces_409(client, setup):
    _, headers, m = setup
    receipt(client, headers, m)  # 800 en S1
    r = adjust(client, headers, m, -801)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "INSUFFICIENT_STOCK"
    # En otro silo no hay nada, aunque el total del artículo sea positivo
    r = adjust(client, headers, m, -1, silo="s2")
    assert r.status_code == 409
    assert level(client, headers, m) == 800


def test_ajuste_cuando_cantidad_cero_o_sin_motivo_entonces_422(client, setup):
    _, headers, m = setup
    assert adjust(client, headers, m, 0).status_code == 422
    assert adjust(client, headers, m, 10, reason="  ").status_code == 422


def test_inventario_cuando_difiere_entonces_crea_movimiento_con_diferencia(client, setup):
    _, headers, m = setup
    receipt(client, headers, m)  # 800 en S1
    r = client.post(
        f"{API}/stock/inventory",
        headers=headers,
        json={
            "lines": [
                {"item_id": m["mp"], "silo_id": m["s1"], "counted_kg": 750},
                {"item_id": m["mp"], "silo_id": m["s2"], "counted_kg": 0},  # sin cambio
                {"item_id": m["pienso"], "silo_id": m["s2"], "counted_kg": 300},
            ],
            "notes": "Inventario mensual",
        },
    )
    assert r.status_code == 201, r.text
    movements = r.json()["movements"]
    assert [(x["item_code"], x["quantity_kg"]) for x in movements] == [
        ("MP-MAIZ", -50),
        ("P-CERDO", 300),
    ]
    assert all(x["kind"] == "inventory" for x in movements)
    assert level(client, headers, m) == 750
    assert level(client, headers, m, item="pienso", silo="s2") == 300

    # Inventario a 0: el saldo desaparece de /levels
    client.post(
        f"{API}/stock/inventory",
        headers=headers,
        json={"lines": [{"item_id": m["mp"], "silo_id": m["s1"], "counted_kg": 0}]},
    )
    levels = client.get(f"{API}/stock/levels", headers=headers).json()
    assert [(x["item_code"], x["silo_code"]) for x in levels["items"]] == [("P-CERDO", "S2")]


def test_inventario_cuando_linea_duplicada_entonces_400(client, setup):
    _, headers, m = setup
    line = {"item_id": m["mp"], "silo_id": m["s1"], "counted_kg": 1}
    r = client.post(f"{API}/stock/inventory", headers=headers, json={"lines": [line, line]})
    assert r.status_code == 400


def test_resumen_cuando_below_min_entonces_filtra_en_sql(client, tenant_admin):
    tenant, headers = tenant_admin
    m = make_masters(tenant.id, min_stock=1000)
    receipt(client, headers, m)  # 800 < 1000
    r = client.get(f"{API}/stock/summary", headers=headers)
    assert r.status_code == 200
    # Solo artículos activos, también los que tienen 0
    rows = {x["item_code"]: x for x in r.json()["items"]}
    assert set(rows) == {"MP-MAIZ", "P-CERDO"}
    assert rows["MP-MAIZ"]["quantity_kg"] == 800 and rows["MP-MAIZ"]["below_min"] is True
    assert rows["P-CERDO"]["quantity_kg"] == 0 and rows["P-CERDO"]["below_min"] is False

    r = client.get(f"{API}/stock/summary", headers=headers, params={"below_min": "true"})
    assert r.json()["total"] == 1 and r.json()["items"][0]["item_code"] == "MP-MAIZ"
    r = client.get(f"{API}/stock/summary", headers=headers, params={"kind": "product"})
    assert [x["item_code"] for x in r.json()["items"]] == ["P-CERDO"]


def test_movimientos_cuando_filtro_por_tipo_entonces_solo_ese_tipo(client, setup):
    _, headers, m = setup
    receipt(client, headers, m)
    adjust(client, headers, m, -10)
    r = client.get(f"{API}/stock/movements", headers=headers, params={"kind": "adjustment"})
    assert r.json()["total"] == 1
    # Más reciente primero
    all_movs = client.get(f"{API}/stock/movements", headers=headers).json()["items"]
    assert [x["kind"] for x in all_movs] == ["adjustment", "raw_material_in"]


# ─── Avisos ────────────────────────────────────────


def _stock_alerts(tenant_id: UUID) -> list[Notification]:
    with new_session(tenant_id=tenant_id) as db:
        return list(db.exec(select(Notification).where(Notification.type == "stock_bajo")).all())


def test_aviso_stock_bajo_cuando_cruza_el_minimo_entonces_notifica_una_vez(client, tenant_admin):
    tenant, headers = tenant_admin
    m = make_masters(tenant.id, min_stock=500)
    receipt(client, headers, m)  # 0 → 800: no cruza hacia abajo
    assert _stock_alerts(tenant.id) == []
    adjust(client, headers, m, -200)  # 600, sigue por encima
    assert _stock_alerts(tenant.id) == []
    adjust(client, headers, m, -200)  # 400 < 500: cruza
    alerts = _stock_alerts(tenant.id)
    assert len(alerts) == 1 and "MP-MAIZ" in alerts[0].title
    adjust(client, headers, m, -100)  # sigue por debajo: no repite
    assert len(_stock_alerts(tenant.id)) == 1
    adjust(client, headers, m, 300)  # 600, vuelve por encima
    adjust(client, headers, m, -150)  # 450: cruza otra vez
    assert len(_stock_alerts(tenant.id)) == 2


# ─── Aislamiento, permisos e inmutabilidad ─────────


def test_aislamiento_cuando_otra_empresa_entonces_no_ve_ni_usa_sus_datos(
    client, setup, make_tenant
):
    _, headers_a, m_a = setup
    receipt(client, headers_a, m_a)
    tenant_b, email_b = make_tenant("Piensos Sur")
    headers_b = auth(client, email_b)
    m_b = make_masters(tenant_b.id)

    assert client.get(f"{API}/stock/movements", headers=headers_b).json()["total"] == 0
    assert client.get(f"{API}/stock/levels", headers=headers_b).json()["total"] == 0
    assert client.get(f"{API}/stock/receipts", headers=headers_b).json()["total"] == 0
    # Con su artículo pero el silo de A: para B ese silo no existe
    r = client.post(
        f"{API}/stock/adjustments",
        headers=headers_b,
        json={"item_id": m_b["mp"], "silo_id": m_a["s1"], "quantity_kg": 10, "reason": "x"},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "INVALID_REFERENCE"
    assert r.json()["error"]["field"] == "silo_id"


def test_permisos_cuando_comercial_entonces_ve_stock_pero_no_ajusta_ni_fabrica(client, setup):
    _, headers, m = setup
    comercial = invite_user(client, headers, "comercial@piensosnorte.es", ["Comercial"])
    assert client.get(f"{API}/stock/levels", headers=comercial).status_code == 200
    assert adjust(client, comercial, m, 10).status_code == 403
    assert receipt(client, comercial, m).status_code == 403
    assert client.get(f"{API}/production/orders", headers=comercial).status_code == 403


def test_bd_cuando_update_o_delete_de_movimiento_entonces_permiso_denegado(client, setup):
    tenant, headers, m = setup
    receipt(client, headers, m)
    for sql in ("UPDATE stock_movement SET notes = 'x'", "DELETE FROM stock_movement"):
        with new_session(tenant_id=tenant.id) as db, pytest.raises(DBAPIError) as exc:
            db.execute(text(sql))
        assert "permission denied" in str(exc.value).lower()
    assert level(client, headers, m) == 800


# ─── Fabricación ───────────────────────────────────


def create_order(client, headers, m, planned_date="2026-11-03", item="pienso"):
    return client.post(
        f"{API}/production/orders",
        headers=headers,
        json={
            "item_id": m[item],
            "silo_id": m["s2"],
            "planned_kg": 5000,
            "planned_date": planned_date,
            "notes": "Turno mañana",
        },
    )


def test_orden_cuando_ciclo_completo_entonces_crea_movimiento_de_produccion(client, setup):
    _, headers, m = setup
    r = create_order(client, headers, m)
    assert r.status_code == 201, r.text
    order = r.json()
    assert order["number"] == "OF-2026-0001"
    assert order["status"] == "planned" and order["produced_kg"] is None
    assert order["item_code"] == "P-CERDO" and order["created_by_name"]

    r = client.post(f"{API}/production/orders/{order['id']}/start", headers=headers)
    assert r.status_code == 200 and r.json()["status"] == "in_progress"
    assert r.json()["started_at"]

    r = client.post(
        f"{API}/production/orders/{order['id']}/finish",
        headers=headers,
        json={"produced_kg": 4980},
    )
    assert r.status_code == 200, r.text
    done = r.json()
    assert done["status"] == "done" and done["produced_kg"] == 4980 and done["finished_at"]
    assert level(client, headers, m, item="pienso", silo="s2") == 4980

    movs = client.get(
        f"{API}/stock/movements", headers=headers, params={"kind": "production"}
    ).json()["items"]
    assert len(movs) == 1
    assert movs[0]["source_type"] == "production_order" and movs[0]["source_id"] == order["id"]

    # Ya terminada: ni cancelar, ni editar, ni terminar otra vez
    r = client.post(f"{API}/production/orders/{order['id']}/cancel", headers=headers)
    assert r.status_code == 409 and r.json()["error"]["code"] == "INVALID_STATUS"
    r = client.post(
        f"{API}/production/orders/{order['id']}/finish", headers=headers, json={"produced_kg": 1}
    )
    assert r.status_code == 409
    assert level(client, headers, m, item="pienso", silo="s2") == 4980


def test_orden_cuando_termina_desde_planned_con_otro_silo_entonces_rellena_inicio(client, setup):
    _, headers, m = setup
    order = create_order(client, headers, m).json()
    r = client.post(
        f"{API}/production/orders/{order['id']}/finish",
        headers=headers,
        json={"produced_kg": 1000, "silo_id": m["s1"]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["started_at"] and r.json()["silo_name"] == "Silo 1"
    assert level(client, headers, m, item="pienso", silo="s1") == 1000


def test_orden_cuando_no_esta_planned_entonces_no_se_edita(client, setup):
    _, headers, m = setup
    order = create_order(client, headers, m).json()
    body = {
        "item_id": m["pienso"],
        "silo_id": m["s1"],
        "planned_kg": 6000,
        "planned_date": "2026-11-04",
        "notes": "",
    }
    r = client.put(f"{API}/production/orders/{order['id']}", headers=headers, json=body)
    assert r.status_code == 200 and r.json()["planned_kg"] == 6000
    client.post(f"{API}/production/orders/{order['id']}/start", headers=headers)
    r = client.put(f"{API}/production/orders/{order['id']}", headers=headers, json=body)
    assert r.status_code == 409 and r.json()["error"]["code"] == "INVALID_STATUS"
    # Una en curso sí se puede cancelar
    r = client.post(f"{API}/production/orders/{order['id']}/cancel", headers=headers)
    assert r.status_code == 200 and r.json()["status"] == "cancelled"


def test_orden_cuando_varias_entonces_numeracion_correlativa_y_listado(client, setup):
    _, headers, m = setup
    first = create_order(client, headers, m, "2026-11-03").json()
    second = create_order(client, headers, m, "2026-11-05").json()
    other_year = create_order(client, headers, m, "2027-01-02").json()
    assert first["number"] == "OF-2026-0001"
    assert second["number"] == "OF-2026-0002"
    assert other_year["number"] == "OF-2027-0001"

    r = client.get(
        f"{API}/production/orders",
        headers=headers,
        params={"date_from": "2026-11-01", "date_to": "2026-11-30"},
    )
    assert [x["number"] for x in r.json()["items"]] == ["OF-2026-0002", "OF-2026-0001"]
    r = client.get(f"{API}/production/orders/{first['id']}", headers=headers)
    assert r.status_code == 200 and r.json()["number"] == "OF-2026-0001"


def test_orden_cuando_articulo_es_materia_prima_entonces_400(client, setup):
    _, headers, m = setup
    r = create_order(client, headers, m, item="mp")
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "INVALID_ITEM_KIND"
    # El número no se ha consumido
    assert create_order(client, headers, m).json()["number"] == "OF-2026-0001"


def test_orden_cuando_otra_empresa_entonces_404(client, setup, make_tenant):
    _, headers, m = setup
    order = create_order(client, headers, m).json()
    _, email_b = make_tenant("Piensos Sur")
    headers_b = auth(client, email_b)
    assert (
        client.get(f"{API}/production/orders/{order['id']}", headers=headers_b).status_code == 404
    )
    r = client.post(f"{API}/production/orders/{order['id']}/start", headers=headers_b)
    assert r.status_code == 404
