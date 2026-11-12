"""FastAPI 依赖：当前账号、首账号校验与请求上下文（T03）。

鉴权来源优先级：Cookie（浏览器）→ ``Authorization: Bearer <token>``（脚本/测试）。
未登录统一 401；已登录但非首账号写系统设置统一 403。
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import get_db
from app.core.errors import ForbiddenError, UnauthorizedError
from app.models.account import Account
from app.services import accounts as accounts_service


@dataclass(frozen=True)
class RequestContext:
    """审计所需的最小请求上下文。"""

    request_id: str
    ip_address: str
    user_agent: str


def get_request_context(request: Request) -> RequestContext:
    forwarded = request.headers.get("x-forwarded-for", "")
    ip = forwarded.split(",")[0].strip() if forwarded else ""
    if not ip and request.client is not None:
        ip = request.client.host or ""
    return RequestContext(
        request_id=getattr(request.state, "request_id", "") or "",
        ip_address=ip[:64],
        user_agent=(request.headers.get("user-agent") or "")[:255],
    )


def extract_session_token(request: Request) -> str | None:
    """从 Cookie 或 Authorization 头提取会话令牌。"""
    token = request.cookies.get(settings.session_cookie_name)
    if token:
        return token
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("bearer "):
        candidate = header[7:].strip()
        return candidate or None
    return None


def get_current_account(
    request: Request, db: Session = Depends(get_db)
) -> Account:
    """必须登录；否则 401（ACCT：未登录业务接口返回 401）。"""
    token = extract_session_token(request)
    account = accounts_service.resolve_session(db, token)
    if account is None:
        raise UnauthorizedError("登录已失效，请重新登录")
    request.state.account = account
    return account


def get_optional_account(
    request: Request, db: Session = Depends(get_db)
) -> Account | None:
    """可选登录：用于既支持匿名又展示个人信息的端点。"""
    return accounts_service.resolve_session(db, extract_session_token(request))


def require_primary_account(
    account: Account = Depends(get_current_account),
) -> Account:
    """写系统设置必须为首账号；普通账号返回 403。"""
    if not account.is_primary:
        raise ForbiddenError("仅首账号可修改系统设置；你的账号仅具备业务页面权限。")
    return account


def require_setting_write(
    request: Request,
    account: Account = Depends(get_current_account),
) -> Account:
    """设置写权限守卫：语义与 ``require_primary_account`` 一致，显式标注设置写场景。"""
    if not account.is_primary:
        raise ForbiddenError(
            "仅首账号可执行系统设置写操作",
            extra={"required_role": "primary_account", "current_role": account.role},
        )
    request.state.setting_write = True
    return account
