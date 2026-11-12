"""鉴权相关请求/响应模型（T03）。"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class SetupRequest(BaseModel):
    """首账号初始化请求。"""

    name: str = Field(min_length=1, max_length=64, description="姓名")
    account: str = Field(min_length=3, max_length=64, description="登录账号")
    password: str = Field(min_length=1, max_length=128)
    confirm_password: str = Field(min_length=1, max_length=128)


class LoginRequest(BaseModel):
    account: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)
    remember: bool = Field(default=False, description="勾选后使用持久 Cookie，否则为会话 Cookie")


class PasswordChangeRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=1, max_length=128)
    confirm_password: str = Field(min_length=1, max_length=128)


class AccountOut(BaseModel):
    """账号对外视图；**不含**任何密码或哈希字段。"""

    model_config = ConfigDict(from_attributes=True)

    id: str
    account: str
    name: str
    role: str
    is_primary: bool
    is_active: bool
    last_login_at: str | None = None
    created_at: str | None = None


class SessionOut(BaseModel):
    id: str
    created_at: str
    last_seen_at: str
    expires_at: str
    user_agent: str
    ip_address: str
    current: bool = False


class BootstrapStatus(BaseModel):
    """前端用于判断跳登录页还是初始化页。"""

    needs_setup: bool
    account_count: int
    role_model: str = "single-experience-member"


class AuthOut(BaseModel):
    account: AccountOut
    expires_at: str


class MessageOut(BaseModel):
    message: str


class SettingOut(BaseModel):
    key: str
    value: str
    value_type: str
    description: str
    updated_by: str | None = None
    updated_at: str | None = None


class SettingUpdateRequest(BaseModel):
    value: str = Field(max_length=4000)
