from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env", "../.env"), extra="ignore")

    app_name: str = "konygest"
    app_env: str = "development"
    debug: bool = False
    app_url: str = "http://localhost:3000"
    cors_origins: str = "http://localhost:3000"

    database_url: str
    database_app_url: str
    database_pool_size: int = 10

    redis_url: str | None = None

    jwt_secret_key: str
    jwt_access_expire_minutes: int = 15
    jwt_refresh_expire_days: int = 7
    encryption_key: str

    email_backend: str = "smtp"
    smtp_host: str = "localhost"
    smtp_port: int = 1025
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_use_tls: bool = False
    email_from: str = "no-reply@konygest.local"
    email_from_name: str = "Konygest"

    vapid_public_key: str = ""
    vapid_private_key: str = ""
    vapid_subject: str = "mailto:soporte@klyp.es"

    bootstrap_superadmin_email: str = ""
    bootstrap_superadmin_password: str = ""

    # Almacenamiento de ficheros (albaranes, documentos): "local" (carpeta) o "s3" (MinIO/S3)
    storage_backend: Literal["local", "s3"] = "local"
    # Carpeta para el backend local; relativa al directorio de trabajo (en Docker, /app/storage)
    storage_local_path: str = "./storage"
    minio_endpoint: str = "localhost:9000"  # host:puerto, sin esquema
    minio_access_key: str = ""
    minio_secret_key: str = ""
    minio_bucket_name: str = "konygest"
    minio_secure: bool = False  # true si el endpoint va por HTTPS
    minio_region: str = "us-east-1"

    # Destinos de documentos de cada empresa (OAuth de la plataforma). Sin credenciales, el
    # proveedor no se ofrece. URI de redirección: {APP_URL}/api/v1/tenant/storage/oauth/<p>/callback
    google_oauth_client_id: str = ""
    google_oauth_client_secret: str = ""
    microsoft_oauth_client_id: str = ""
    microsoft_oauth_client_secret: str = ""
    microsoft_oauth_tenant: str = "common"

    # Entorno de la URL del QR tributario de Verifactu: "test" (portal de pruebas de la AEAT)
    # o "production". Por defecto pruebas, para no generar QR «reales» desde desarrollo.
    verifactu_environment: Literal["test", "production"] = "test"

    # Intentos fallidos de login antes de bloquear la cuenta y minutos de bloqueo
    max_failed_logins: int = 5
    lockout_minutes: int = 15

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
