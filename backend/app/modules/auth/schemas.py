from uuid import UUID

from pydantic import BaseModel, EmailStr, Field

from app.core.deps import CurrentUser


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=200)
    totp_code: str | None = Field(default=None, max_length=10)


class TenantRef(BaseModel):
    id: UUID
    name: str


class MeOut(BaseModel):
    id: UUID
    email: str
    full_name: str
    tenant: TenantRef | None
    platform_role: str | None
    permissions: dict[str, str]
    modules: list[str]
    support_mode: bool
    read_only: bool
    totp_enabled: bool
    must_setup_2fa: bool

    @classmethod
    def from_current(cls, user: CurrentUser) -> "MeOut":
        return cls(
            id=user.id,
            email=user.email,
            full_name=user.full_name,
            tenant=TenantRef(id=user.tenant_id, name=user.tenant_name or "")
            if user.tenant_id
            else None,
            platform_role=user.platform_role.value if user.platform_role else None,
            permissions={k: v.value for k, v in user.permissions.items()},
            modules=sorted(user.modules),
            support_mode=user.support_mode,
            read_only=user.read_only,
            totp_enabled=user.totp_enabled,
            must_setup_2fa=user.must_setup_2fa,
        )


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"  # noqa: S105


class EmailIn(BaseModel):
    email: EmailStr


class TokenPasswordIn(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    password: str = Field(min_length=1, max_length=200)


class InvitationOut(BaseModel):
    email: str
    full_name: str
    tenant_name: str | None


class TotpSetupOut(BaseModel):
    secret: str
    otpauth_uri: str


class TotpCodeIn(BaseModel):
    code: str = Field(min_length=6, max_length=10)


class TotpDisableIn(BaseModel):
    password: str
    code: str = Field(min_length=6, max_length=10)


class ProfileIn(BaseModel):
    full_name: str = Field(min_length=1, max_length=200)


class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=1, max_length=200)
