"""Datos de demostración para desarrollo local: una fábrica con un usuario por perfil.

Uso: `uv run python -m app.seed_demo <contraseña>` (mínimo 6 caracteres; solo
para tu base de datos local). Es idempotente: si la empresa ya existe, no hace nada.
Usuarios creados: <perfil>@demo.konygest.es (admin, direccion, oficina, fabrica, comercial).
También carga maestros (clientes, explotaciones, piensos, materias primas, silos,
camiones...) y un stock inicial, si la empresa aún no tiene artículos, y actividad
de los últimos días (entradas de báscula, órdenes de fabricación en todos los
estados, ajustes, precios negociados y más clientes) si aún no tiene fabricación,
y pedidos de los comerciales en todos los estados si aún no tiene pedidos.
"""

import sys
from datetime import date, timedelta
from decimal import Decimal
from uuid import UUID

from sqlmodel import Session, select

import app.models  # noqa: F401
from app.core.config import get_settings
from app.core.db import new_session
from app.core.security import hash_password, utcnow
from app.core.sequence import next_number
from app.modules.masters.models import (
    Carrier,
    Customer,
    CustomerPrice,
    Driver,
    Farm,
    Item,
    ItemKind,
    PaymentMethod,
    PriceList,
    PriceListLine,
    Silo,
    SiloKind,
    Truck,
    VatRate,
)
from app.modules.masters.service import quote_price
from app.modules.orders.models import Order, OrderLine, OrderStatus, PriceSource
from app.modules.orders.service import today_madrid
from app.modules.production.models import ProductionOrder, ProductionStatus
from app.modules.stock.models import MovementKind, RawMaterialReceipt, StockMovement
from app.modules.tenants.models import Tenant, TenantStatus
from app.modules.tenants.service import seed_roles
from app.modules.users.models import User, UserRole

DEMO_TENANT = "Piensos Demo"
DEMO_USERS = {
    "admin": ("Ana Administradora", "Administrador"),
    "direccion": ("Diego Director", "Dirección"),
    "oficina": ("Olga Oficina", "Oficina"),
    "fabrica": ("Fernando Fábrica", "Fábrica"),
    "comercial": ("Carlos Comercial", "Comercial"),
}


def main(password: str) -> None:
    if get_settings().is_production:
        raise SystemExit("No se cargan datos de demostración en producción.")
    with new_session(bypass_rls=True) as db:
        tenant = db.exec(select(Tenant).where(Tenant.name == DEMO_TENANT)).first()
        if tenant:
            print("La empresa de demostración ya existe.")
        else:
            tenant = Tenant(name=DEMO_TENANT, tax_id="B00000000", status=TenantStatus.ACTIVE)
            db.add(tenant)
            db.flush()
            roles = seed_roles(db, tenant.id)
            password_hash = hash_password(password)
            for key, (name, role) in DEMO_USERS.items():
                user = User(
                    tenant_id=tenant.id,
                    email=f"{key}@demo.konygest.es",
                    full_name=name,
                    password_hash=password_hash,
                )
                db.add(user)
                db.flush()
                db.add(UserRole(tenant_id=tenant.id, user_id=user.id, role_id=roles[role].id))
            print(f"Creada «{DEMO_TENANT}» con usuarios: {', '.join(DEMO_USERS)}@demo.konygest.es")
        if db.exec(select(Item.id).where(Item.tenant_id == tenant.id)).first():
            print("Los maestros de demostración ya existen.")
        else:
            seed_masters(db, tenant.id)
            print("Cargados maestros y stock inicial de demostración.")
        has_orders = db.exec(
            select(ProductionOrder.id).where(ProductionOrder.tenant_id == tenant.id)
        ).first()
        if has_orders:
            print("La actividad de demostración ya existe.")
        else:
            seed_activity(db, tenant.id)
            print("Cargada actividad de demostración (entradas, fabricación, ajustes...).")
        if db.exec(select(Order.id).where(Order.tenant_id == tenant.id)).first():
            print("Los pedidos de demostración ya existen.")
        else:
            count = seed_orders(db, tenant.id)
            print(f"Cargados {count} pedidos de demostración.")
        db.commit()


PRODUCTS = [
    ("P-CEB", "Cebo cerdos", "0.3150", 20000),
    ("P-LEC", "Lechones iniciación", "0.4500", 5000),
    ("P-VAC", "Vacuno leche", "0.3400", 15000),
    ("P-COR", "Corderos engorde", "0.3600", 0),
]
RAW_MATERIALS = [
    ("MP-MAI", "Maíz", 60000),
    ("MP-CEB", "Cebada", 40000),
    ("MP-SOJ", "Harina de soja 44", 25000),
    ("MP-COR", "Corrector vitamínico", 1000),
]
CUSTOMERS = [
    ("C001", "Granja Los Pinos S.L.", "B12345678", "Lorca", "Murcia", "ES300240000101"),
    ("C002", "Porcinos del Segura", "B23456789", "Cieza", "Murcia", "ES300190000202"),
    ("C003", "Lácteos Vega Alta", "B34567890", "Caravaca", "Murcia", "ES300150000303"),
]


def seed_masters(db: Session, tenant_id: UUID) -> None:
    def add(row):
        db.add(row)
        db.flush()
        return row

    vat = add(VatRate(tenant_id=tenant_id, name="IVA 10 %", rate=Decimal(10), is_default=True))
    add(VatRate(tenant_id=tenant_id, name="IVA 21 %", rate=Decimal(21)))
    payment = add(
        PaymentMethod(
            tenant_id=tenant_id, name="Transferencia 30 días", due_days=[30], is_default=True
        )
    )
    add(PaymentMethod(tenant_id=tenant_id, name="Recibo 30-60", due_days=[30, 60]))

    products = [
        add(
            Item(
                tenant_id=tenant_id,
                code=code,
                name=name,
                kind=ItemKind.PRODUCT,
                vat_rate_id=vat.id,
                base_price=Decimal(price),
                min_stock_kg=Decimal(minimum),
            )
        )
        for code, name, price, minimum in PRODUCTS
    ]
    raws = [
        add(
            Item(
                tenant_id=tenant_id,
                code=code,
                name=name,
                kind=ItemKind.RAW_MATERIAL,
                min_stock_kg=Decimal(minimum),
            )
        )
        for code, name, minimum in RAW_MATERIALS
    ]
    silos = [
        add(Silo(tenant_id=tenant_id, code=f"S{n}", name=f"Silo {n}", capacity_kg=Decimal(60000)))
        for n in range(1, 7)
    ]
    warehouse = add(
        Silo(tenant_id=tenant_id, code="NAVE", name="Nave de sacos", kind=SiloKind.WAREHOUSE)
    )

    tariff = add(PriceList(tenant_id=tenant_id, name="Tarifa mayoristas"))
    for product in products[:2]:
        db.add(
            PriceListLine(
                tenant_id=tenant_id,
                price_list_id=tariff.id,
                item_id=product.id,
                price=Decimal(product.base_price or 0) - Decimal("0.0150"),
            )
        )

    comercial = db.exec(select(User).where(User.email == "comercial@demo.konygest.es")).first()
    for index, (code, name, tax_id, city, province, rega) in enumerate(CUSTOMERS):
        customer = add(
            Customer(
                tenant_id=tenant_id,
                code=code,
                name=name,
                tax_id=tax_id,
                city=city,
                province=province,
                sales_rep_id=comercial.id if comercial and index < 2 else None,
                price_list_id=tariff.id if index == 1 else None,
                payment_method_id=payment.id,
            )
        )
        add(
            Farm(
                tenant_id=tenant_id,
                customer_id=customer.id,
                name=f"Explotación {city}",
                rega_code=rega,
                city=city,
                province=province,
                silos=[
                    {"name": "Silo 1", "capacity_kg": 14000},
                    {"name": "Silo 2", "capacity_kg": 10000},
                ],
            )
        )

    own = add(Carrier(tenant_id=tenant_id, name="Flota propia", is_own_fleet=True))
    external = add(Carrier(tenant_id=tenant_id, name="Transportes Hermanos Ruiz"))
    add(Truck(tenant_id=tenant_id, plate="1234KLM", carrier_id=own.id, compartments=[8000] * 3))
    add(
        Truck(tenant_id=tenant_id, plate="5678NPR", carrier_id=external.id, compartments=[7000] * 4)
    )
    add(Driver(tenant_id=tenant_id, full_name="Paco Martínez", carrier_id=own.id))
    add(Driver(tenant_id=tenant_id, full_name="Luis Ruiz", carrier_id=external.id))

    # Stock inicial como movimientos de inventario (el libro es la única fuente del stock)
    initial = [
        (raws[0], silos[0], 80000),
        (raws[1], silos[1], 35000),
        (raws[2], silos[2], 30000),
        (raws[3], warehouse, 800),
        (products[0], silos[3], 26000),
        (products[1], silos[4], 4000),
        (products[2], silos[5], 18000),
    ]
    for item, silo, kg in initial:
        db.add(
            StockMovement(
                tenant_id=tenant_id,
                item_id=item.id,
                silo_id=silo.id,
                kind=MovementKind.INVENTORY,
                quantity_kg=Decimal(kg),
                notes="Stock inicial de demostración",
            )
        )


MORE_CUSTOMERS = [
    ("C004", "Cooperativa Ganadera del Noroeste", "F45678901", "Moratalla", "Murcia", True),
    ("C005", "Hermanos Sánchez Avicultura", "B56789012", "Totana", "Murcia", True),
    ("C006", "Ovinos La Paca", "B67890123", "La Paca", "Murcia", False),
]
# (código MP, proveedor, albarán, matrícula, bruto, tara, hace N días)
RECEIPTS = [
    ("MP-MAI", "Cereales Levante S.A.", "AL-20431", "4521HJK", 38420, 14260, 9),
    ("MP-SOJ", "Bunge Ibérica", "BI-778812", "7788LMN", 27150, 13040, 7),
    ("MP-CEB", "Cooperativa Campo de Cartagena", "CC-1190", "2233BCD", 31780, 13900, 4),
    ("MP-MAI", "Cereales Levante S.A.", "AL-20502", "4521HJK", 37960, 14260, 2),
    ("MP-COR", "Nutrimix Correctores", "NX-5521", "", 1250, 0, 1),
]
RAW_SILO = {"MP-MAI": "S1", "MP-CEB": "S2", "MP-SOJ": "S3", "MP-COR": "NAVE"}
# (código pienso, silo, kg previstos, kg producidos, estado, días desde hoy)
ORDERS = [
    ("P-CEB", "S4", 24000, 23850, ProductionStatus.DONE, -6),
    ("P-VAC", "S6", 18000, 18120, ProductionStatus.DONE, -5),
    ("P-LEC", "S5", 6000, None, ProductionStatus.CANCELLED, -3),
    ("P-CEB", "S4", 20000, 19940, ProductionStatus.DONE, -1),
    ("P-LEC", "S5", 6000, None, ProductionStatus.IN_PROGRESS, 0),
    ("P-VAC", "S6", 16000, None, ProductionStatus.PLANNED, 0),
    ("P-COR", "NAVE", 4000, None, ProductionStatus.PLANNED, 1),
    ("P-CEB", "S4", 24000, None, ProductionStatus.PLANNED, 2),
]
# (código, silo, kg con signo, hace N días, motivo)
ADJUSTMENTS = [
    ("MP-COR", "NAVE", -150, 2, "Rotura de saco al descargar"),
    ("MP-MAI", "S1", -320, 1, "Merma por humedad"),
]


def seed_activity(db: Session, tenant_id: UUID) -> None:
    """Actividad de las últimas semanas, coherente con el libro de stock."""
    items = {i.code: i for i in db.exec(select(Item).where(Item.tenant_id == tenant_id)).all()}
    silos = {s.code: s for s in db.exec(select(Silo).where(Silo.tenant_id == tenant_id)).all()}
    fabrica = db.exec(select(User).where(User.email == "fabrica@demo.konygest.es")).first()
    comercial = db.exec(select(User).where(User.email == "comercial@demo.konygest.es")).first()
    user_id = fabrica.id if fabrica else None
    now = utcnow()
    today = date.today()

    def movement(code, silo_code, kind, kg, when, source=(None, None), notes=""):
        db.add(
            StockMovement(
                tenant_id=tenant_id,
                item_id=items[code].id,
                silo_id=silos[silo_code].id,
                kind=kind,
                quantity_kg=Decimal(kg),
                occurred_at=when,
                source_type=source[0],
                source_id=source[1],
                notes=notes,
                user_id=user_id,
            )
        )

    # Más clientes (uno de baja), con su explotación
    payment = db.exec(select(PaymentMethod).where(PaymentMethod.tenant_id == tenant_id)).first()
    for code, name, tax_id, city, province, active in MORE_CUSTOMERS:
        customer = Customer(
            tenant_id=tenant_id,
            code=code,
            name=name,
            tax_id=tax_id,
            city=city,
            province=province,
            sales_rep_id=comercial.id if comercial and code == "C004" else None,
            payment_method_id=payment.id if payment else None,
            credit_limit=Decimal(30000),
            is_active=active,
        )
        db.add(customer)
        db.flush()
        db.add(
            Farm(
                tenant_id=tenant_id,
                customer_id=customer.id,
                name=f"Granja {city}",
                city=city,
                province=province,
                silos=[{"name": "Silo único", "capacity_kg": 18000}],
            )
        )

    # Precios negociados del primer cliente
    first = db.exec(
        select(Customer).where(Customer.tenant_id == tenant_id, Customer.code == "C001")
    ).first()
    if first:
        for code, price in (("P-CEB", "0.2990"), ("P-LEC", "0.4300")):
            db.add(
                CustomerPrice(
                    tenant_id=tenant_id,
                    customer_id=first.id,
                    item_id=items[code].id,
                    price=Decimal(price),
                )
            )

    # Entradas de materia prima con su pesada de báscula
    for code, supplier, note, plate, gross, tare, days_ago in RECEIPTS:
        when = now - timedelta(days=days_ago, hours=3)
        receipt = RawMaterialReceipt(
            tenant_id=tenant_id,
            number=next_number(db, tenant_id, "EMP", when.year),
            item_id=items[code].id,
            silo_id=silos[RAW_SILO[code]].id,
            supplier=supplier,
            delivery_note=note,
            plate=plate,
            gross_kg=Decimal(gross),
            tare_kg=Decimal(tare),
            net_kg=Decimal(gross - tare),
            received_at=when,
            user_id=user_id,
        )
        db.add(receipt)
        db.flush()
        movement(
            code,
            RAW_SILO[code],
            MovementKind.RAW_MATERIAL_IN,
            gross - tare,
            when,
            ("raw_material_receipt", receipt.id),
        )

    # Órdenes de fabricación en todos los estados
    for code, silo_code, planned, produced, status, offset in ORDERS:
        planned_date = today + timedelta(days=offset)
        started = None
        if status in (ProductionStatus.IN_PROGRESS, ProductionStatus.DONE):
            started = now + timedelta(days=offset, hours=-6)
        finished = started + timedelta(hours=4) if produced and started else None
        order = ProductionOrder(
            tenant_id=tenant_id,
            number=next_number(db, tenant_id, "OF", planned_date.year),
            item_id=items[code].id,
            silo_id=silos[silo_code].id,
            planned_kg=Decimal(planned),
            produced_kg=Decimal(produced) if produced else None,
            status=status,
            planned_date=planned_date,
            started_at=started,
            finished_at=finished,
            notes="Avería en la granuladora" if status == ProductionStatus.CANCELLED else "",
            created_by=user_id,
        )
        db.add(order)
        db.flush()
        if produced and finished:
            movement(
                code,
                silo_code,
                MovementKind.PRODUCTION,
                produced,
                finished,
                ("production_order", order.id),
            )

    for code, silo_code, kg, days_ago, reason in ADJUSTMENTS:
        movement(
            code,
            silo_code,
            MovementKind.ADJUSTMENT,
            kg,
            now - timedelta(days=days_ago),
            notes=reason,
        )


# (cliente, quién lo crea, estado, días hasta la entrega, notas, motivo,
#  líneas [(pienso, kg, silo de la explotación, precio manual o None)])
# C004 tiene 30.000 € de riesgo: con sus tres confirmados, su pendiente lo supera.
# fmt: off
SALES_ORDERS = [
    ("C001", "comercial", OrderStatus.DRAFT, 3, "", "",
     [("P-CEB", 12000, "Silo 1", None), ("P-LEC", 2000, "Silo 2", None)]),
    ("C002", "comercial", OrderStatus.DRAFT, 4, "Llamar antes de descargar", "",
     [("P-CEB", 14000, "Silo 1", None)]),
    ("C001", "comercial", OrderStatus.PENDING, 2, "Precio acordado por volumen", "",
     [("P-CEB", 10000, "Silo 1", "0.2850")]),
    ("C004", "comercial", OrderStatus.PENDING, 2, "", "",
     [("P-VAC", 18000, "Silo único", None), ("P-COR", 12000, "Silo único", None)]),
    ("C003", "prueba-comercial", OrderStatus.PENDING, 1, "", "",
     [("P-VAC", 14000, "Silo 1", None), ("P-VAC", 8000, "Silo 2", None)]),
    ("C002", "comercial", OrderStatus.REJECTED, 5, "", "Precio por debajo de tarifa sin "
     "autorización de dirección: revísalo con el cliente.",
     [("P-LEC", 3000, "Silo 2", "0.4000")]),
    ("C004", "comercial", OrderStatus.CONFIRMED, 1, "", "",
     [("P-CEB", 24000, "Silo único", None)]),
    ("C004", "comercial", OrderStatus.CONFIRMED, 2, "", "",
     [("P-VAC", 24000, "Silo único", None)]),
    ("C004", "oficina", OrderStatus.CONFIRMED, 3, "Pedido telefónico", "",
     [("P-CEB", 18000, "Silo único", None)]),
    ("C005", "prueba-comercial", OrderStatus.CONFIRMED, 1, "", "",
     [("P-LEC", 6000, "Silo único", None)]),
    ("C001", "oficina", OrderStatus.CONFIRMED, 0, "", "",
     [("P-CEB", 14000, "Silo 1", None)]),
    ("C003", "prueba-comercial", OrderStatus.CANCELLED, -2, "", "El cliente ha retrasado "
     "la entrada de animales; lo pedirá de nuevo.",
     [("P-VAC", 10000, "Silo 1", None)]),
]
# fmt: on


def seed_orders(db: Session, tenant_id: UUID) -> int:
    """Pedidos en todos los estados con los precios que corresponden a cada cliente.

    Los de `prueba-comercial@` (si existe) los crea él; si no, oficina, para que el
    seed funcione en una base de datos sin ese usuario.
    """
    items = {i.code: i for i in db.exec(select(Item).where(Item.tenant_id == tenant_id)).all()}
    customers = {
        c.code: c for c in db.exec(select(Customer).where(Customer.tenant_id == tenant_id)).all()
    }
    farms = {
        f.customer_id: f for f in db.exec(select(Farm).where(Farm.tenant_id == tenant_id)).all()
    }
    users = {
        u.email.split("@")[0]: u
        for u in db.exec(select(User).where(User.tenant_id == tenant_id)).all()
    }
    office = users.get("oficina")
    now = utcnow()
    today = today_madrid()
    cent = Decimal("0.01")
    count = 0
    for index, (code, author, status, offset, notes, reason, lines) in enumerate(SALES_ORDERS):
        customer = customers.get(code)
        creator = users.get(author) or office
        if customer is None or customer.id not in farms:
            continue
        created = now - timedelta(days=4, hours=len(SALES_ORDERS) - index)
        order = Order(
            tenant_id=tenant_id,
            number=next_number(db, tenant_id, "PED", created.year),
            customer_id=customer.id,
            farm_id=farms[customer.id].id,
            # Como en la API: el comercial del cliente si el pedido lo hace oficina
            sales_rep_id=creator.id if creator and creator is not office else customer.sales_rep_id,
            status=status,
            requested_date=today + timedelta(days=offset),
            notes=notes,
            status_reason=reason,
            created_by=creator.id if creator else None,
            created_at=created,
            updated_at=created + timedelta(hours=2),
        )
        if status != OrderStatus.DRAFT:
            order.submitted_at = created + timedelta(hours=1)
        if status == OrderStatus.CONFIRMED and office:
            order.validated_by = office.id
            order.validated_at = created + timedelta(hours=2)
        db.add(order)
        db.flush()
        total_kg = total_amount = Decimal(0)
        for position, (item_code, kg, silo, manual) in enumerate(lines, start=1):
            item = items[item_code]
            quote = quote_price(db, customer, item)
            reference = quote.price
            price = Decimal(manual) if manual else reference
            assert price is not None, f"{item_code} sin precio para {code}"
            amount = (Decimal(kg) * price).quantize(cent)
            db.add(
                OrderLine(
                    tenant_id=tenant_id,
                    order_id=order.id,
                    position=position,
                    item_id=item.id,
                    quantity_kg=Decimal(kg),
                    unit_price=price,
                    price_source=PriceSource.MANUAL if manual else PriceSource(quote.source),
                    reference_price=reference,
                    amount=amount,
                    farm_silo=silo,
                )
            )
            total_kg += Decimal(kg)
            total_amount += amount
        order.total_kg = total_kg
        order.total_amount = total_amount
        db.add(order)
        count += 1
    return count


if __name__ == "__main__":
    if len(sys.argv) != 2 or len(sys.argv[1]) < 6:
        raise SystemExit("Uso: python -m app.seed_demo <contraseña de al menos 6 caracteres>")
    main(sys.argv[1])
