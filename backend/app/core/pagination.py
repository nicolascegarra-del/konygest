from typing import Annotated

from fastapi import Depends, Query
from pydantic import BaseModel
from sqlalchemy import func
from sqlmodel import Session, select
from sqlmodel.sql.expression import SelectOfScalar


class PageParams(BaseModel):
    offset: int
    limit: int


def page_params(
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> PageParams:
    return PageParams(offset=offset, limit=limit)


PageDep = Annotated[PageParams, Depends(page_params)]


class Page[T](BaseModel):
    items: list[T]
    total: int
    offset: int
    limit: int


def paginate(session: Session, query: SelectOfScalar, page: PageParams) -> tuple[list, int]:
    total = session.exec(select(func.count()).select_from(query.order_by(None).subquery())).one()
    items = session.exec(query.offset(page.offset).limit(page.limit)).all()
    return list(items), int(total)
