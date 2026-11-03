"""Formato de error estándar de Klyp: {"error": {code, message, field?, request_id}}."""

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("konygest")


class AppError(Exception):
    def __init__(self, status_code: int, code: str, message: str, field: str | None = None) -> None:
        self.status_code = status_code
        self.code = code
        self.message = message
        self.field = field


def not_found(message: str = "No encontrado.") -> AppError:
    return AppError(404, "NOT_FOUND", message)


def forbidden(message: str = "No tienes permiso para esta acción.") -> AppError:
    return AppError(403, "FORBIDDEN", message)


def conflict(message: str, field: str | None = None) -> AppError:
    return AppError(409, "CONFLICT", message, field)


def bad_request(code: str, message: str, field: str | None = None) -> AppError:
    return AppError(400, code, message, field)


def _body(request: Request, code: str, message: str, field: str | None = None) -> dict:
    error: dict = {"code": code, "message": message}
    if field:
        error["field"] = field
    error["request_id"] = getattr(request.state, "request_id", None)
    return {"error": error}


_HTTP_CODES = {401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            _body(request, exc.code, exc.message, exc.field), status_code=exc.status_code
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _HTTP_CODES.get(exc.status_code, "HTTP_ERROR")
        return JSONResponse(
            _body(request, code, str(exc.detail)),
            status_code=exc.status_code,
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        loc = [str(p) for p in first.get("loc", []) if p not in ("body", "query", "path")]
        return JSONResponse(
            _body(
                request,
                "VALIDATION_ERROR",
                first.get("msg", "Datos no válidos."),
                ".".join(loc) or None,
            ),
            status_code=422,
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        logger.exception(
            "Error no controlado", extra={"request_id": getattr(request.state, "request_id", None)}
        )
        return JSONResponse(
            _body(request, "INTERNAL_ERROR", "Ha ocurrido un error inesperado."),
            status_code=500,
        )
