"""Almacenamiento de ficheros por clave ("<tenant_id>/albaranes/ALB-2026-0001.pdf").

Dos backends, elegidos con `STORAGE_BACKEND`:

- `local` (por defecto): carpeta en disco (`STORAGE_LOCAL_PATH`). En producción va en un
  volumen de Docker para que sobreviva a los despliegues.
- `s3`: MinIO o cualquier S3 compatible (`MINIO_*`). El bucket se crea al primer uso.

El objeto `storage` resuelve el backend de forma perezosa con la configuración vigente,
así importar el módulo no abre conexiones ni crea carpetas.
"""

from __future__ import annotations

import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Any, Protocol

from app.core.config import get_settings

# Segmentos permitidos: letras, números, guion, guion bajo y punto (sin "." ni "..")
_SEGMENT = re.compile(r"^[A-Za-z0-9_\-][A-Za-z0-9_.\-]*$")


class InvalidStorageKeyError(ValueError):
    """La clave no es válida (vacía, absoluta, con `..` o caracteres no permitidos)."""


def validate_key(key: str) -> str:
    """Comprueba que la clave es relativa y no puede salir de la raíz del almacenamiento.

    Se valida igual en los dos backends para que una clave que funciona en local
    funcione también en S3 y viceversa.
    """
    if not key or key.startswith(("/", "\\")) or "\\" in key or len(key) > 512:
        raise InvalidStorageKeyError(f"Clave de almacenamiento no válida: {key!r}")
    for segment in key.split("/"):
        if segment in ("", ".", "..") or not _SEGMENT.match(segment):
            raise InvalidStorageKeyError(f"Clave de almacenamiento no válida: {key!r}")
    return key


class Storage(Protocol):
    def save(self, key: str, data: bytes, content_type: str) -> None: ...
    def load(self, key: str) -> bytes: ...
    def exists(self, key: str) -> bool: ...
    def delete(self, key: str) -> None: ...


class LocalStorage:
    """Ficheros en una carpeta. El tipo de contenido no se guarda (se deduce de la extensión)."""

    def __init__(self, root: str | os.PathLike[str]) -> None:
        self.root = Path(root).resolve()

    def _path(self, key: str) -> Path:
        path = (self.root / validate_key(key)).resolve()
        # Defensa adicional ante enlaces simbólicos u otras sorpresas
        if not path.is_relative_to(self.root):
            raise InvalidStorageKeyError(f"Clave de almacenamiento no válida: {key!r}")
        return path

    def save(self, key: str, data: bytes, content_type: str) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        # Escritura atómica: fichero temporal en la misma carpeta y renombrado
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
            os.replace(tmp, path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def load(self, key: str) -> bytes:
        path = self._path(key)
        if not path.is_file():
            raise FileNotFoundError(key)
        return path.read_bytes()

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    def delete(self, key: str) -> None:
        """Borra el fichero; no falla si ya no existe."""
        self._path(key).unlink(missing_ok=True)


class S3Storage:
    """MinIO / S3 con boto3. Acepta un cliente ya construido (útil en tests)."""

    def __init__(self, bucket: str, client: Any | None = None, **client_kwargs: Any) -> None:
        self.bucket = bucket
        self._client = client
        self._client_kwargs = client_kwargs
        self._bucket_ready = False
        self._lock = threading.Lock()

    @property
    def client(self) -> Any:
        if self._client is None:
            import boto3
            from botocore.config import Config

            self._client = boto3.client(
                "s3",
                config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
                **self._client_kwargs,
            )
        return self._client

    def _ensure_bucket(self) -> None:
        if self._bucket_ready:
            return
        from botocore.exceptions import ClientError

        with self._lock:
            if self._bucket_ready:
                return
            try:
                self.client.head_bucket(Bucket=self.bucket)
            except ClientError as exc:
                code = str(exc.response.get("Error", {}).get("Code", ""))
                if code not in ("404", "NoSuchBucket", "NotFound"):
                    raise
                try:
                    self.client.create_bucket(Bucket=self.bucket)
                except ClientError as create_exc:
                    # Otro proceso lo creó a la vez
                    create_code = create_exc.response.get("Error", {}).get("Code", "")
                    if create_code not in ("BucketAlreadyOwnedByYou", "BucketAlreadyExists"):
                        raise
            self._bucket_ready = True

    def save(self, key: str, data: bytes, content_type: str) -> None:
        validate_key(key)
        self._ensure_bucket()
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)

    def load(self, key: str) -> bytes:
        from botocore.exceptions import ClientError

        validate_key(key)
        self._ensure_bucket()
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=key)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in ("NoSuchKey", "404", "NotFound"):
                raise FileNotFoundError(key) from exc
            raise
        return response["Body"].read()

    def exists(self, key: str) -> bool:
        from botocore.exceptions import ClientError

        validate_key(key)
        self._ensure_bucket()
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in ("NoSuchKey", "404", "NotFound"):
                return False
            raise
        return True

    def delete(self, key: str) -> None:
        validate_key(key)
        self._ensure_bucket()
        # S3 no da error si la clave no existe
        self.client.delete_object(Bucket=self.bucket, Key=key)


def build_storage() -> Storage:
    """Construye el backend que indica la configuración."""
    settings = get_settings()
    if settings.storage_backend == "s3":
        scheme = "https" if settings.minio_secure else "http"
        return S3Storage(
            settings.minio_bucket_name,
            endpoint_url=f"{scheme}://{settings.minio_endpoint}",
            aws_access_key_id=settings.minio_access_key,
            aws_secret_access_key=settings.minio_secret_key,
            region_name=settings.minio_region,
        )
    return LocalStorage(settings.storage_local_path)


class _LazyStorage:
    """Fachada pública: crea el backend real la primera vez que se usa."""

    def __init__(self) -> None:
        self._backend: Storage | None = None
        self._lock = threading.Lock()

    @property
    def backend(self) -> Storage:
        if self._backend is None:
            with self._lock:
                if self._backend is None:
                    self._backend = build_storage()
        return self._backend

    def reset(self, backend: Storage | None = None) -> None:
        """Vuelve a leer la configuración en el próximo uso (o fija un backend, en tests)."""
        self._backend = backend

    def save(self, key: str, data: bytes, content_type: str) -> None:
        self.backend.save(key, data, content_type)

    def load(self, key: str) -> bytes:
        return self.backend.load(key)

    def exists(self, key: str) -> bool:
        return self.backend.exists(key)

    def delete(self, key: str) -> None:
        self.backend.delete(key)


storage = _LazyStorage()
