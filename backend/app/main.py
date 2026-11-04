import logging
import uuid

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

import app.models  # noqa: F401  (registra los modelos)
from app.core.config import get_settings
from app.core.errors import register_error_handlers
from app.modules.auth.router import router as auth_router
from app.modules.documents.router import router as documents_router
from app.modules.logistics.router import router as logistics_router
from app.modules.masters.router import router as masters_router
from app.modules.notifications.router import router as notifications_router
from app.modules.orders.router import router as orders_router
from app.modules.platform.router import router as admin_router
from app.modules.production.router import router as production_router
from app.modules.stock.router import router as stock_router
from app.modules.tenants.router import router as tenants_router
from app.modules.users.router import router as users_router

settings = get_settings()
logging.basicConfig(level=logging.DEBUG if settings.debug else logging.INFO)

app = FastAPI(
    title="Konygest API",
    description="Gestión de fábricas de piensos a granel.",
    version="0.1.0",
    docs_url=None if settings.is_production else "/docs",
    redoc_url=None if settings.is_production else "/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.middleware("http")
async def request_context(request: Request, call_next):
    request.state.request_id = request.headers.get("X-Request-ID") or f"req_{uuid.uuid4().hex[:12]}"
    response = await call_next(request)
    response.headers["X-Request-ID"] = request.state.request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    if settings.is_production:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


register_error_handlers(app)

API_PREFIX = "/api/v1"
for router in (
    auth_router,
    users_router,
    tenants_router,
    notifications_router,
    admin_router,
    masters_router,
    stock_router,
    production_router,
    orders_router,
    logistics_router,
    documents_router,
):
    app.include_router(router, prefix=API_PREFIX)


@app.get("/health", include_in_schema=False)
def health() -> dict[str, str]:
    return {"status": "ok"}
