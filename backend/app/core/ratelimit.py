"""Límite de peticiones por ventana fija, con Redis o en memoria si no hay Redis."""

import time
from collections import defaultdict
from collections.abc import Callable

from fastapi import Request

from app.core.config import get_settings
from app.core.errors import AppError


class _MemoryCounter:
    def __init__(self) -> None:
        self._hits: dict[str, tuple[int, float]] = defaultdict(lambda: (0, 0.0))

    def hit(self, key: str, window: int) -> int:
        count, reset_at = self._hits[key]
        now = time.monotonic()
        if now >= reset_at:
            count, reset_at = 0, now + window
        self._hits[key] = (count + 1, reset_at)
        return count + 1

    def clear(self) -> None:
        self._hits.clear()


class _RedisCounter:
    def __init__(self, url: str) -> None:
        import redis

        self._redis = redis.Redis.from_url(url)

    def hit(self, key: str, window: int) -> int:
        pipe = self._redis.pipeline()
        pipe.incr(key)
        pipe.expire(key, window, nx=True)
        count, _ = pipe.execute()
        return int(count)


_settings = get_settings()
counter: _MemoryCounter | _RedisCounter = (
    _RedisCounter(_settings.redis_url) if _settings.redis_url else _MemoryCounter()
)


def rate_limit(name: str, limit: int, window_seconds: int) -> Callable[[Request], None]:
    """Dependencia que limita a `limit` peticiones por IP cada `window_seconds`."""

    def dependency(request: Request) -> None:
        ip = request.client.host if request.client else "unknown"
        if counter.hit(f"rl:{name}:{ip}", window_seconds) > limit:
            raise AppError(
                429, "RATE_LIMITED", "Demasiados intentos. Espera unos minutos y vuelve a probar."
            )

    return dependency
