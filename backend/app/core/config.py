from functools import lru_cache

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
