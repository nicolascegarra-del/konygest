from tests.conftest import get_user, invite_user

API = "/api/v1/masters"


def _create(client, headers, resource: str, body: dict) -> dict:
    r = client.post(f"{API}/{resource}", headers=headers, json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _product(client, headers, code="P1", **extra) -> dict:
    body = {"code": code, "name": f"Pienso {code}", "kind": "product", **extra}
    return _create(client, headers, "items", body)


def test_articulo_cuando_se_crea_y_edita_entonces_devuelve_numeros_y_cambios(client, tenant_admin):
    _, headers = tenant_admin
    vat = _create(client, headers, "vat-rates", {"name": "Reducido", "rate": 10})
    item = _product(client, headers, base_price=0.3125, min_stock_kg=5000, vat_rate_id=vat["id"])
    assert item["base_price"] == 0.3125
    assert item["min_stock_kg"] == 5000

    body = {**item, "name": "Cebo cerdos", "is_active": False}
    r = client.put(f"{API}/items/{item['id']}", headers=headers, json=body)
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Cebo cerdos"

    active = client.get(f"{API}/items", headers=headers, params={"active": "true"}).json()
    assert active["total"] == 0
    inactive = client.get(f"{API}/items", headers=headers, params={"search": "cebo"}).json()
    assert [i["code"] for i in inactive["items"]] == ["P1"]


def test_codigo_cuando_esta_repetido_entonces_409_con_campo(client, tenant_admin):
    _, headers = tenant_admin
    _product(client, headers)
    r = client.post(
        f"{API}/items", headers=headers, json={"code": "P1", "name": "Otro", "kind": "product"}
    )
    assert r.status_code == 409
    assert r.json()["error"]["field"] == "code"


def test_filtro_cuando_kind_entonces_solo_ese_tipo(client, tenant_admin):
    _, headers = tenant_admin
    _product(client, headers)
    _create(client, headers, "items", {"code": "MP1", "name": "Maíz", "kind": "raw_material"})
    r = client.get(f"{API}/items", headers=headers, params={"kind": "raw_material"})
    assert [i["code"] for i in r.json()["items"]] == ["MP1"]


def test_camion_cuando_tiene_compartimentos_entonces_suma_capacidad(client, tenant_admin):
    _, headers = tenant_admin
    carrier = _create(client, headers, "carriers", {"name": "Transportes Pepe"})
    truck = _create(
        client,
        headers,
        "trucks",
        {"plate": "1234 abc", "carrier_id": carrier["id"], "compartments": [8000, 8000, 6000]},
    )
    assert truck["plate"] == "1234 ABC"
    assert truck["capacity_kg"] == 22000
    assert truck["carrier_name"] == "Transportes Pepe"

    r = client.post(f"{API}/trucks", headers=headers, json={"plate": "X", "compartments": []})
    assert r.status_code == 422


def test_referencia_cuando_es_de_otra_empresa_entonces_400(client, make_tenant):
    from tests.conftest import auth

    _, email_a = make_tenant("Piensos Norte")
    _, email_b = make_tenant("Piensos Sur")
    headers_a, headers_b = auth(client, email_a), auth(client, email_b)
    carrier_b = _create(client, headers_b, "carriers", {"name": "Ajeno"})

    r = client.post(
        f"{API}/trucks",
        headers=headers_a,
        json={"plate": "1111AAA", "carrier_id": carrier_b["id"], "compartments": [10000]},
    )
    assert r.status_code == 400
    assert r.json()["error"] == {
        "code": "INVALID_REFERENCE",
        "message": "La referencia indicada no existe.",
        "field": "carrier_id",
        "request_id": r.json()["error"]["request_id"],
    }
    assert client.get(f"{API}/carriers/{carrier_b['id']}", headers=headers_a).status_code == 404
    assert client.get(f"{API}/carriers", headers=headers_a).json()["total"] == 0


def test_cliente_cuando_tiene_explotaciones_y_precios_entonces_los_devuelve(client, tenant_admin):
    _, headers = tenant_admin
    product = _product(client, headers)
    customer = _create(
        client,
        headers,
        "customers",
        {
            "code": "C1",
            "name": "Granja López",
            "prices": [{"item_id": product["id"], "price": 0.29}],
        },
    )
    assert customer["prices"] == [
        {"item_id": product["id"], "price": 0.29, "item_code": "P1", "item_name": "Pienso P1"}
    ]
    farm = _create(
        client,
        headers,
        "farms",
        {
            "customer_id": customer["id"],
            "name": "Nave 1",
            "rega_code": "ES300300000001",
            "silos": [{"name": "Silo A", "capacity_kg": 12000}, {"name": "Silo B"}],
        },
    )
    assert farm["customer_name"] == "Granja López"
    assert farm["silos"][0] == {"name": "Silo A", "capacity_kg": 12000}

    detail = client.get(f"{API}/customers/{customer['id']}", headers=headers).json()
    assert detail["farm_count"] == 1

    # Editar sin `prices` no borra los precios negociados
    body = {k: v for k, v in detail.items() if k != "prices"}
    r = client.put(f"{API}/customers/{customer['id']}", headers=headers, json=body)
    assert len(r.json()["prices"]) == 1


def test_precio_cuando_hay_negociado_tarifa_o_general_entonces_aplica_prioridad(
    client, tenant_admin
):
    _, headers = tenant_admin
    p1 = _product(client, headers, "P1", base_price=0.30)
    p2 = _product(client, headers, "P2", base_price=0.40)
    p3 = _product(client, headers, "P3")
    tariff = _create(
        client,
        headers,
        "price-lists",
        {
            "name": "Mayoristas",
            "lines": [{"item_id": p1["id"], "price": 0.28}, {"item_id": p2["id"], "price": 0.38}],
        },
    )
    customer = _create(
        client,
        headers,
        "customers",
        {
            "code": "C1",
            "name": "Granja",
            "price_list_id": tariff["id"],
            "prices": [{"item_id": p1["id"], "price": 0.25}],
        },
    )

    def quote(item):
        return client.get(
            f"{API}/customers/{customer['id']}/price",
            headers=headers,
            params={"item_id": item["id"]},
        ).json()

    assert quote(p1) == {"price": 0.25, "source": "customer"}
    assert quote(p2) == {"price": 0.38, "source": "price_list"}
    assert quote(p3) == {"price": None, "source": "none"}

    client.put(
        f"{API}/price-lists/{tariff['id']}", headers=headers, json={**tariff, "is_active": False}
    )
    assert quote(p2) == {"price": 0.40, "source": "base"}


def test_precio_cuando_es_de_materia_prima_entonces_400(client, tenant_admin):
    _, headers = tenant_admin
    mp = _create(client, headers, "items", {"code": "MP1", "name": "Maíz", "kind": "raw_material"})
    r = client.post(
        f"{API}/price-lists",
        headers=headers,
        json={"name": "T", "lines": [{"item_id": mp["id"], "price": 0.2}]},
    )
    assert r.status_code == 400
    assert r.json()["error"]["field"] == "lines"


def test_comercial_cuando_alcance_propios_entonces_solo_ve_sus_clientes(client, tenant_admin):
    _, headers = tenant_admin
    comercial = invite_user(client, headers, "juan@norte.es", ["Comercial"])
    juan = get_user("juan@norte.es")
    mine = _create(
        client,
        headers,
        "customers",
        {"code": "C1", "name": "De Juan", "sales_rep_id": str(juan.id)},
    )
    other = _create(client, headers, "customers", {"code": "C2", "name": "De otro"})
    _create(client, headers, "farms", {"customer_id": mine["id"], "name": "Granja de Juan"})
    _create(client, headers, "farms", {"customer_id": other["id"], "name": "Granja ajena"})

    names = [c["name"] for c in client.get(f"{API}/customers", headers=comercial).json()["items"]]
    assert names == ["De Juan"]
    farms = [f["name"] for f in client.get(f"{API}/farms", headers=comercial).json()["items"]]
    assert farms == ["Granja de Juan"]
    assert client.get(f"{API}/customers/{other['id']}", headers=comercial).status_code == 404

    # El comercial puede consultar pero no crear maestros
    r = client.post(f"{API}/carriers", headers=comercial, json={"name": "X"})
    assert r.status_code == 403

    lookups = client.get(f"{API}/lookups", headers=headers).json()
    assert [r["name"] for r in lookups["sales_reps"]] == [
        n for n in sorted([r["name"] for r in lookups["sales_reps"]])
    ]
    assert "juan" in [r["name"] for r in lookups["sales_reps"]]


def test_lookups_cuando_hay_inactivos_entonces_no_aparecen(client, tenant_admin):
    _, headers = tenant_admin
    silo = _create(client, headers, "silos", {"code": "S1", "name": "Silo 1", "capacity_kg": 30000})
    _create(client, headers, "silos", {"code": "S2", "name": "Viejo", "is_active": False})
    data = client.get(f"{API}/lookups", headers=headers).json()
    assert data["silos"] == [{"id": silo["id"], "name": "Silo 1", "code": "S1", "kind": "silo"}]
