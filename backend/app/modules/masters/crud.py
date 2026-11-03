"""Rutas CRUD comunes a todos los maestros.

Cada maestro se describe con un `MasterSpec` (modelo, esquemas, búsqueda, claves
ajenas...) y `register_master` le crea: listado paginado con búsqueda y filtros,
ficha, alta y edición. No hay borrado: los maestros se desactivan para que los
pedidos, cargas y facturas que ya los usan sigan siendo válidos.
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, SQLModel, col, or_, select
from sqlmodel.sql.expression import SelectOfScalar

from app.core.deps import CurrentUser, TenantDbDep, require_permission
from app.core.errors import bad_request, conflict, not_found
from app.core.pagination import Page, PageDep, paginate
from app.modules.platform.audit import audit

ScopeFilter = Callable[[SelectOfScalar, CurrentUser], SelectOfScalar]
OutBuilder = Callable[[Session, list[Any]], list[BaseModel]]
AfterSave = Callable[[Session, Any, BaseModel], None]


@dataclass
class MasterSpec:
    path: str
    model: type[SQLModel]
    schema_in: type[BaseModel]
    schema_out: type[BaseModel]
    entity: str  # nombre técnico para la auditoría: "customer"
    label: str  # para los mensajes: "cliente"
    tag: str
    search: list[str]
    order_by: str
    # Campo con restricción de unicidad, para el mensaje del 409
    unique_field: str | None = None
    # Claves ajenas que se comprueban (con RLS, una de otra empresa «no existe»)
    refs: dict[str, type[SQLModel]] = field(default_factory=dict)
    # Filtros exactos admitidos en el listado (?kind=product, ?customer_id=...)
    filters: list[str] = field(default_factory=list)
    # Campos del esquema de entrada que no son columnas (líneas, precios...)
    extra_fields: set[str] = field(default_factory=set)
    scope: ScopeFilter | None = None
    build_out: OutBuilder | None = None
    after_save: AfterSave | None = None


def _filter_value(name: str, raw: str) -> Any:
    if name.endswith("_id"):
        try:
            return UUID(raw)
        except ValueError as exc:
            raise bad_request("VALIDATION_ERROR", "Identificador no válido.", name) from exc
    return raw


def check_refs(db: Session, refs: dict[str, type[SQLModel]], data: BaseModel) -> None:
    for name, model in refs.items():
        value = getattr(data, name, None)
        if value is not None and db.get(model, value) is None:
            raise bad_request("INVALID_REFERENCE", "La referencia indicada no existe.", name)


def register_master(router: APIRouter, spec: MasterSpec) -> None:
    model = spec.model
    view = Depends(require_permission("maestros.ver"))
    manage = Depends(require_permission("maestros.gestionar"))

    def to_out(db: Session, rows: list[Any]) -> list[BaseModel]:
        if spec.build_out:
            return spec.build_out(db, rows)
        return [spec.schema_out.model_validate(r) for r in rows]

    def scoped(query: SelectOfScalar, user: CurrentUser) -> SelectOfScalar:
        return spec.scope(query, user) if spec.scope else query

    def get_row(db: Session, user: CurrentUser, row_id: UUID) -> Any:
        query = scoped(select(model).where(model.id == row_id), user)  # type: ignore[attr-defined]
        row = db.exec(query).first()
        if row is None:
            raise not_found(f"No se encuentra el {spec.label}.")
        return row

    def save(db: Session, row: Any, data: BaseModel, user: CurrentUser, action: str) -> Any:
        check_refs(db, spec.refs, data)
        for key, value in data.model_dump(exclude=spec.extra_fields).items():
            setattr(row, key, value)
        db.add(row)
        try:
            db.flush()
        except IntegrityError as exc:
            db.rollback()
            what = spec.unique_field or "name"
            raise conflict(f"Ese {_LABELS.get(what, what)} ya está en uso.", what) from exc
        if spec.after_save:
            spec.after_save(db, row, data)
        audit(db, f"{spec.entity}.{action}", user=user, entity=spec.entity, entity_id=row.id)
        db.commit()
        return row

    @router.get(
        spec.path,
        summary=f"Listado de {spec.label}s",
        response_model=Page[spec.schema_out],  # type: ignore[name-defined]
        tags=[spec.tag],
    )
    def list_rows(
        request: Request,
        db: TenantDbDep,
        page: PageDep,
        search: str | None = None,
        active: Annotated[bool | None, Query(description="Solo activos (true) o inactivos")] = None,
        user: CurrentUser = view,
    ):
        query = scoped(select(model), user)
        for name in spec.filters:
            raw = request.query_params.get(name)
            if raw:
                query = query.where(getattr(model, name) == _filter_value(name, raw))
        if active is not None:
            query = query.where(model.is_active == active)  # type: ignore[attr-defined]
        if search and search.strip():
            pattern = f"%{search.strip()}%"
            query = query.where(or_(*[col(getattr(model, f)).ilike(pattern) for f in spec.search]))
        query = query.order_by(getattr(model, spec.order_by))
        rows, total = paginate(db, query, page)
        return Page(items=to_out(db, rows), total=total, offset=page.offset, limit=page.limit)

    @router.get(
        f"{spec.path}/{{row_id}}",
        summary=f"Ficha de {spec.label}",
        response_model=spec.schema_out,
        tags=[spec.tag],
    )
    def get_one(row_id: UUID, db: TenantDbDep, user: CurrentUser = view):
        return to_out(db, [get_row(db, user, row_id)])[0]

    @router.post(
        spec.path,
        summary=f"Crear {spec.label}",
        response_model=spec.schema_out,
        status_code=201,
        tags=[spec.tag],
    )
    def create(data: spec.schema_in, db: TenantDbDep, user: CurrentUser = manage):  # type: ignore[name-defined]
        row = save(db, model(tenant_id=user.tenant_id), data, user, "crear")
        return to_out(db, [row])[0]

    @router.put(
        f"{spec.path}/{{row_id}}",
        summary=f"Editar {spec.label}",
        description="Se envía la ficha completa. Para dar de baja, `is_active: false`.",
        response_model=spec.schema_out,
        tags=[spec.tag],
    )
    def update(row_id: UUID, data: spec.schema_in, db: TenantDbDep, user: CurrentUser = manage):  # type: ignore[name-defined]
        row = save(db, get_row(db, user, row_id), data, user, "editar")
        return to_out(db, [row])[0]


_LABELS = {"code": "código", "name": "nombre", "plate": "matrícula"}
