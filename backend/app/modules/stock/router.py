"""Rutas de stock: saldos, movimientos, entradas de materia prima, ajustes e inventarios."""

from datetime import date
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends

from app.core.deps import CurrentUser, TenantDbDep, require_module, require_permission
from app.core.errors import bad_request
from app.core.pagination import Page, PageDep
from app.core.security import utcnow
from app.core.sequence import next_number
from app.modules.masters.models import ItemKind
from app.modules.platform.audit import audit
from app.modules.stock import service
from app.modules.stock.models import MovementKind, RawMaterialReceipt
from app.modules.stock.schemas import (
    AdjustmentIn,
    InventoryIn,
    InventoryOut,
    LevelOut,
    MovementOut,
    ReceiptIn,
    ReceiptOut,
    SummaryOut,
)

router = APIRouter(
    prefix="/stock", tags=["Stock"], dependencies=[Depends(require_module("fabrica"))]
)

View = Depends(require_permission("stock.ver"))
Adjust = Depends(require_permission("stock.ajustar"))


@router.get(
    "/levels",
    summary="Stock por artículo y silo",
    description="Solo las combinaciones con movimientos y cantidad distinta de 0.",
    response_model=Page[LevelOut],
)
def levels(
    db: TenantDbDep,
    page: PageDep,
    item_id: UUID | None = None,
    silo_id: UUID | None = None,
    kind: ItemKind | None = None,
    _: CurrentUser = View,
) -> Page[LevelOut]:
    items, total = service.list_levels(db, page, item_id, silo_id, kind)
    return Page(items=items, total=total, offset=page.offset, limit=page.limit)


@router.get(
    "/summary",
    summary="Stock total por artículo",
    description="Todos los artículos activos, también los que no tienen stock.",
    response_model=Page[SummaryOut],
)
def summary(
    db: TenantDbDep,
    page: PageDep,
    search: str | None = None,
    kind: ItemKind | None = None,
    below_min: bool | None = None,
    _: CurrentUser = View,
) -> Page[SummaryOut]:
    items, total = service.list_summary(db, page, search, kind, below_min)
    return Page(items=items, total=total, offset=page.offset, limit=page.limit)


@router.get(
    "/movements",
    summary="Movimientos de stock",
    description="Más reciente primero. Las fechas filtran por el día (UTC) del movimiento.",
    response_model=Page[MovementOut],
)
def movements(
    db: TenantDbDep,
    page: PageDep,
    item_id: UUID | None = None,
    silo_id: UUID | None = None,
    kind: MovementKind | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    _: CurrentUser = View,
) -> Page[MovementOut]:
    items, total = service.list_movements(db, page, item_id, silo_id, kind, date_from, date_to)
    return Page(items=items, total=total, offset=page.offset, limit=page.limit)


@router.get("/receipts", summary="Entradas de materia prima", response_model=Page[ReceiptOut])
def receipts(db: TenantDbDep, page: PageDep, _: CurrentUser = View) -> Page[ReceiptOut]:
    items, total = service.list_receipts(db, page)
    return Page(items=items, total=total, offset=page.offset, limit=page.limit)


@router.post(
    "/receipts",
    summary="Registrar una entrada de materia prima",
    description="Neto = bruto − tara (debe ser mayor que 0). Solo artículos de materia prima.",
    response_model=ReceiptOut,
    status_code=201,
)
def create_receipt(data: ReceiptIn, db: TenantDbDep, user: CurrentUser = Adjust) -> ReceiptOut:
    item = service.get_item(db, data.item_id, kind=ItemKind.RAW_MATERIAL)
    silo = service.get_silo(db, data.silo_id)
    net = data.gross_kg - data.tare_kg
    if net <= 0:
        raise bad_request(
            "VALIDATION_ERROR", "La tara debe ser menor que el peso bruto.", "tare_kg"
        )
    received_at = service.as_utc(data.received_at) if data.received_at else utcnow()
    receipt = RawMaterialReceipt(
        tenant_id=user.tenant_id,  # type: ignore[arg-type]
        number=next_number(db, user.tenant_id, "EMP", received_at.year),  # type: ignore[arg-type]
        item_id=item.id,
        silo_id=silo.id,
        supplier=data.supplier,
        delivery_note=data.delivery_note,
        plate=data.plate,
        gross_kg=data.gross_kg,
        tare_kg=data.tare_kg,
        net_kg=net,
        received_at=received_at,
        notes=data.notes,
        user_id=user.id,
    )
    db.add(receipt)
    db.flush()
    service.record_movement(
        db,
        user,
        item,
        silo,
        MovementKind.RAW_MATERIAL_IN,
        net,
        source_type="raw_material_receipt",
        source_id=receipt.id,
        notes=f"Entrada {receipt.number}",
        occurred_at=received_at,
    )
    audit(
        db,
        "stock.entrada",
        user=user,
        entity="raw_material_receipt",
        entity_id=receipt.id,
        data={"numero": receipt.number, "articulo": item.code, "neto_kg": float(net)},
    )
    db.commit()
    return service.receipt_out(db, receipt.id)


@router.post(
    "/adjustments",
    summary="Ajuste manual de stock",
    description="Cantidad con signo (positiva suma, negativa resta). El motivo es obligatorio.",
    response_model=MovementOut,
    status_code=201,
)
def create_adjustment(
    data: AdjustmentIn, db: TenantDbDep, user: CurrentUser = Adjust
) -> MovementOut:
    item = service.get_item(db, data.item_id)
    silo = service.get_silo(db, data.silo_id)
    movement = service.record_movement(
        db, user, item, silo, MovementKind.ADJUSTMENT, data.quantity_kg, notes=data.reason
    )
    audit(
        db,
        "stock.ajuste",
        user=user,
        entity="stock_movement",
        entity_id=movement.id,
        data={
            "articulo": item.code,
            "silo": silo.code,
            "cantidad_kg": float(data.quantity_kg),
            "motivo": data.reason,
        },
    )
    db.commit()
    return service.movements_out(db, [movement])[0]


@router.post(
    "/inventory",
    summary="Registrar un inventario",
    description=(
        "Para cada línea se compara lo contado con el stock actual y, si difiere, se crea "
        "un movimiento de inventario con la diferencia."
    ),
    response_model=InventoryOut,
    status_code=201,
)
def create_inventory(
    data: InventoryIn, db: TenantDbDep, user: CurrentUser = Adjust
) -> InventoryOut:
    seen: set[tuple[UUID, UUID]] = set()
    for index, line in enumerate(data.lines):
        key = (line.item_id, line.silo_id)
        if key in seen:
            raise bad_request(
                "VALIDATION_ERROR",
                "Hay dos líneas con el mismo artículo y silo.",
                f"lines.{index}",
            )
        seen.add(key)
    resolved = [
        (
            service.get_item(db, line.item_id, f"lines.{i}.item_id"),
            service.get_silo(db, line.silo_id, f"lines.{i}.silo_id"),
            line.counted_kg,
        )
        for i, line in enumerate(data.lines)
    ]
    # Bloqueos en orden fijo para que dos inventarios simultáneos no se interbloqueen
    for item_id in sorted({item.id for item, _, _ in resolved}, key=str):
        service.lock_item(db, user.tenant_id, item_id)  # type: ignore[arg-type]

    created = []
    for item, silo, counted in resolved:
        _, current = service.balances(db, item.id, silo.id)
        diff: Decimal = counted - current
        if diff == 0:
            continue
        created.append(
            service.record_movement(
                db,
                user,
                item,
                silo,
                MovementKind.INVENTORY,
                diff,
                notes=data.notes or "Inventario",
            )
        )
    audit(
        db,
        "stock.inventario",
        user=user,
        entity="stock_movement",
        data={"lineas": len(data.lines), "movimientos": len(created)},
    )
    db.commit()
    return InventoryOut(movements=service.movements_out(db, created))
