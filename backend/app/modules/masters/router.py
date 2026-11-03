from uuid import UUID

from fastapi import APIRouter, Depends
from sqlmodel import select

from app.core.deps import CurrentUser, TenantDbDep, require_permission
from app.core.errors import not_found
from app.modules.masters import service
from app.modules.masters.crud import MasterSpec, register_master
from app.modules.masters.models import (
    Carrier,
    Customer,
    Driver,
    Farm,
    Item,
    ItemKind,
    PaymentMethod,
    PriceList,
    Silo,
    Truck,
    VatRate,
)
from app.modules.masters.schemas import (
    CarrierIn,
    CarrierOut,
    CustomerIn,
    CustomerOut,
    DriverIn,
    DriverOut,
    FarmIn,
    FarmOut,
    ItemIn,
    ItemOut,
    MasterLookups,
    Option,
    PaymentMethodIn,
    PaymentMethodOut,
    PriceListIn,
    PriceListOut,
    PriceQuote,
    SiloIn,
    SiloOut,
    TruckIn,
    TruckOut,
    VatRateIn,
    VatRateOut,
)
from app.modules.users.models import User

router = APIRouter(prefix="/masters")

View = Depends(require_permission("maestros.ver"))


# Rutas fijas antes que las genéricas `/{row_id}`


@router.get(
    "/lookups",
    summary="Opciones para los desplegables",
    description="Maestros activos resumidos (id y nombre) para los formularios.",
    response_model=MasterLookups,
    tags=["Maestros"],
)
def lookups(db: TenantDbDep, _: CurrentUser = View) -> MasterLookups:
    def options(model, *, code: bool = False, kind: bool = False) -> list[Option]:
        order = model.code if code else model.name
        rows = db.exec(select(model).where(model.is_active).order_by(order)).all()
        return [
            Option(
                id=r.id,
                name=r.name,
                code=r.code if code else None,
                kind=str(r.kind) if kind else None,
            )
            for r in rows
        ]

    return MasterLookups(
        vat_rates=options(VatRate),
        payment_methods=options(PaymentMethod),
        price_lists=options(PriceList),
        carriers=options(Carrier),
        sales_reps=[Option(id=i, name=n) for i, n in service.sales_rep_options(db)],
        silos=options(Silo, code=True, kind=True),
        items=options(Item, code=True, kind=True),
    )


@router.get(
    "/customers/{customer_id}/price",
    summary="Precio de un pienso para un cliente",
    description="Precio negociado del cliente, si no el de su tarifa y si no el general.",
    response_model=PriceQuote,
    tags=["Maestros · Clientes"],
)
def customer_price(
    customer_id: UUID, item_id: UUID, db: TenantDbDep, user: CurrentUser = View
) -> PriceQuote:
    query = service.scope_customers(select(Customer).where(Customer.id == customer_id), user)
    customer = db.exec(query).first()
    if customer is None:
        raise not_found("No se encuentra el cliente.")
    item = db.get(Item, item_id)
    if item is None or item.kind != ItemKind.PRODUCT:
        raise not_found("No se encuentra el pienso.")
    return service.quote_price(db, customer, item)


def _farm_after_save(db, row: Farm, data: FarmIn) -> None:
    # Las explotaciones guardan los silos como JSON
    row.silos = [s.model_dump() for s in data.silos]
    db.add(row)


SPECS = [
    MasterSpec(
        path="/vat-rates",
        model=VatRate,
        schema_in=VatRateIn,
        schema_out=VatRateOut,
        entity="iva",
        label="tipo de IVA",
        tag="Maestros · IVA y formas de pago",
        search=["name"],
        order_by="name",
        unique_field="name",
    ),
    MasterSpec(
        path="/payment-methods",
        model=PaymentMethod,
        schema_in=PaymentMethodIn,
        schema_out=PaymentMethodOut,
        entity="forma_pago",
        label="forma de pago",
        tag="Maestros · IVA y formas de pago",
        search=["name"],
        order_by="name",
        unique_field="name",
    ),
    MasterSpec(
        path="/items",
        model=Item,
        schema_in=ItemIn,
        schema_out=ItemOut,
        entity="articulo",
        label="artículo",
        tag="Maestros · Artículos y silos",
        search=["code", "name"],
        order_by="code",
        unique_field="code",
        refs={"vat_rate_id": VatRate},
        filters=["kind"],
    ),
    MasterSpec(
        path="/silos",
        model=Silo,
        schema_in=SiloIn,
        schema_out=SiloOut,
        entity="silo",
        label="silo",
        tag="Maestros · Artículos y silos",
        search=["code", "name"],
        order_by="code",
        unique_field="code",
        filters=["kind"],
    ),
    MasterSpec(
        path="/price-lists",
        model=PriceList,
        schema_in=PriceListIn,
        schema_out=PriceListOut,
        entity="tarifa",
        label="tarifa",
        tag="Maestros · Tarifas",
        search=["name"],
        order_by="name",
        unique_field="name",
        extra_fields={"lines"},
        build_out=service.price_lists_out,
        after_save=service.save_price_list_lines,
    ),
    MasterSpec(
        path="/customers",
        model=Customer,
        schema_in=CustomerIn,
        schema_out=CustomerOut,
        entity="cliente",
        label="cliente",
        tag="Maestros · Clientes",
        search=["code", "name", "tax_id", "city"],
        order_by="name",
        unique_field="code",
        refs={
            "sales_rep_id": User,
            "price_list_id": PriceList,
            "payment_method_id": PaymentMethod,
        },
        filters=["sales_rep_id"],
        extra_fields={"prices"},
        scope=service.scope_customers,
        build_out=service.customers_out,
        after_save=service.save_customer_prices,
    ),
    MasterSpec(
        path="/farms",
        model=Farm,
        schema_in=FarmIn,
        schema_out=FarmOut,
        entity="explotacion",
        label="explotación",
        tag="Maestros · Clientes",
        search=["name", "rega_code", "city"],
        order_by="name",
        refs={"customer_id": Customer},
        filters=["customer_id"],
        extra_fields={"silos"},
        scope=service.scope_farms,
        build_out=service.farms_out,
        after_save=_farm_after_save,
    ),
    MasterSpec(
        path="/carriers",
        model=Carrier,
        schema_in=CarrierIn,
        schema_out=CarrierOut,
        entity="transportista",
        label="transportista",
        tag="Maestros · Transporte",
        search=["name"],
        order_by="name",
        unique_field="name",
    ),
    MasterSpec(
        path="/trucks",
        model=Truck,
        schema_in=TruckIn,
        schema_out=TruckOut,
        entity="camion",
        label="camión",
        tag="Maestros · Transporte",
        search=["plate"],
        order_by="plate",
        unique_field="plate",
        refs={"carrier_id": Carrier},
        filters=["carrier_id"],
        build_out=service.trucks_out,
    ),
    MasterSpec(
        path="/drivers",
        model=Driver,
        schema_in=DriverIn,
        schema_out=DriverOut,
        entity="conductor",
        label="conductor",
        tag="Maestros · Transporte",
        search=["full_name"],
        order_by="full_name",
        refs={"carrier_id": Carrier},
        filters=["carrier_id"],
        build_out=service.drivers_out,
    ),
]

for spec in SPECS:
    register_master(router, spec)
