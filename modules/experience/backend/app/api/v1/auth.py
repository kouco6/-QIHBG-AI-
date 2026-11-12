"""鉴权路由 ``/api/v1/auth/*``（T03）。

- ``GET  /auth/bootstrap``  初始化状态（无需登录）
- ``POST /auth/setup``      创建首账号（仅数据库无账号时；创建后自动登录）
- ``POST /auth/login``      登录
- ``POST /auth/logout``     退出（撤销当前会话）
- ``GET  /auth/me``         当前账号
- ``POST /auth/password``   修改本人密码（撤销其他会话）
- ``GET  /auth/sessions``   本人有效会话列表
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy.orm import Session

from app.api.deps import (
    RequestContext,
    extract_session_token,
    get_current_account,
    get_request_context,
)
from app.core.config import settings
from app.core.db import get_db
from app.core.errors import UnauthorizedError, ValidationError
from app.core.security import verify_password
from app.core.timeutil import iso_z
from app.models.account import AUDIT_CATEGORY_AUTH, Account
from app.schemas.auth import (
    AccountOut,
    AuthOut,
    BootstrapStatus,
    LoginRequest,
    MessageOut,
    PasswordChangeRequest,
    SessionOut,
    SetupRequest,
)
from app.services import accounts as accounts_service

router = APIRouter(prefix="/auth", tags=["auth"])

_COOKIE_PATH = "/"


def _account_out(account: Account) -> AccountOut:
    return AccountOut(
        id=account.id,
        account=account.account,
        name=account.name,
        role=account.role,
        is_primary=account.is_primary,
        is_active=account.is_active,
        last_login_at=iso_z(account.last_login_at),
        created_at=iso_z(account.created_at),
    )


def _set_session_cookie(response: Response, token: str, *, remember: bool) -> None:
    response.set_cookie(
        key=settings.session_cookie_name,
        value=token,
        max_age=settings.session_max_age_seconds if remember else None,
        httponly=True,
        samesite="lax",
        secure=settings.session_https_only,
        path=_COOKIE_PATH,
    )


def _clear_session_cookie(response: Response) -> None:
    response.delete_cookie(key=settings.session_cookie_name, path=_COOKIE_PATH)


@router.get("/bootstrap", response_model=BootstrapStatus, summary="初始化状态（无需登录）")
async def bootstrap(db: Session = Depends(get_db)) -> BootstrapStatus:
    count = accounts_service.count_accounts(db)
    return BootstrapStatus(needs_setup=count == 0, account_count=count)


@router.post(
    "/setup",
    response_model=AuthOut,
    status_code=status.HTTP_201_CREATED,
    summary="创建首账号（仅数据库无账号时可用）",
)
async def setup(
    payload: SetupRequest,
    request: Request,
    response: Response,
    ctx: RequestContext = Depends(get_request_context),
    db: Session = Depends(get_db),
) -> AuthOut:
    if payload.password != payload.confirm_password:
        raise ValidationError(
            "两次输入的密码不一致",
            field_errors=[{"field": "confirm_password", "message": "两次输入不一致", "type": "value_error"}],
        )

    account = accounts_service.create_primary_account(
        db, name=payload.name, account=payload.account, password=payload.password
    )

    from app.core.audit import write_audit

    write_audit(
        db,
        category=AUDIT_CATEGORY_AUTH,
        action="primary_account_created",
        actor_account_id=account.id,
        actor_name=account.name,
        actor_role=account.role,
        target_type="account",
        target_id=account.id,
        summary=f"创建首账号 {account.account}",
        detail={"account": account.account, "is_primary": True},
        request_id=ctx.request_id,
        ip_address=ctx.ip_address,
    )

    token = accounts_service.create_session(
        db, account, user_agent=ctx.user_agent, ip_address=ctx.ip_address
    )
    _set_session_cookie(response, token, remember=True)
    session = accounts_service.list_sessions(db, account.id)[0]
    return AuthOut(account=_account_out(account), expires_at=iso_z(session.expires_at) or "")


@router.post("/login", response_model=AuthOut, summary="登录")
async def login(
    payload: LoginRequest,
    response: Response,
    ctx: RequestContext = Depends(get_request_context),
    db: Session = Depends(get_db),
) -> AuthOut:
    from app.core.audit import write_audit

    try:
        account, token = accounts_service.authenticate(
            db,
            account=payload.account,
            password=payload.password,
            user_agent=ctx.user_agent,
            ip_address=ctx.ip_address,
        )
    except UnauthorizedError as exc:
        # 失败也留痕：只记录账号标识，绝不记录密码
        write_audit(
            db,
            category=AUDIT_CATEGORY_AUTH,
            action="login_failed",
            actor_name=payload.account[:64],
            target_type="account",
            target_id=payload.account[:64],
            summary=f"登录失败（{exc.message}）",
            detail={"account": payload.account, "reason": exc.code},
            request_id=ctx.request_id,
            ip_address=ctx.ip_address,
        )
        raise

    write_audit(
        db,
        category=AUDIT_CATEGORY_AUTH,
        action="login_succeeded",
        actor_account_id=account.id,
        actor_name=account.name,
        actor_role=account.role,
        target_type="account",
        target_id=account.id,
        summary=f"登录成功（{account.account}）",
        detail={"account": account.account},
        request_id=ctx.request_id,
        ip_address=ctx.ip_address,
    )

    _set_session_cookie(response, token, remember=payload.remember)
    session = accounts_service.list_sessions(db, account.id)[0]
    return AuthOut(account=_account_out(account), expires_at=iso_z(session.expires_at) or "")


@router.post("/logout", response_model=MessageOut, summary="退出登录")
async def logout(
    request: Request,
    response: Response,
    ctx: RequestContext = Depends(get_request_context),
    db: Session = Depends(get_db),
) -> MessageOut:
    from app.core.audit import write_audit

    token = extract_session_token(request)
    account = accounts_service.resolve_session(db, token)
    revoked = accounts_service.revoke_session(db, token)
    _clear_session_cookie(response)

    if account is not None:
        write_audit(
            db,
            category=AUDIT_CATEGORY_AUTH,
            action="logout",
            actor_account_id=account.id,
            actor_name=account.name,
            actor_role=account.role,
            target_type="account",
            target_id=account.id,
            summary="退出登录",
            detail={"revoked": revoked},
            request_id=ctx.request_id,
            ip_address=ctx.ip_address,
        )
    return MessageOut(message="已退出登录")


@router.get("/me", response_model=AccountOut, summary="当前账号")
async def me(account: Account = Depends(get_current_account)) -> AccountOut:
    return _account_out(account)


@router.get("/sessions", response_model=list[SessionOut], summary="本人有效会话")
async def sessions(
    request: Request,
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> list[SessionOut]:
    current_token = extract_session_token(request)
    from app.core.security import token_digest

    current_hash = token_digest(current_token) if current_token else None
    rows = accounts_service.list_sessions(db, account.id)
    return [
        SessionOut(
            id=row.id,
            created_at=iso_z(row.created_at) or "",
            last_seen_at=iso_z(row.last_seen_at) or "",
            expires_at=iso_z(row.expires_at) or "",
            user_agent=row.user_agent,
            ip_address=row.ip_address,
            current=bool(current_hash and row.token_hash == current_hash),
        )
        for row in rows
    ]


@router.post("/password", response_model=MessageOut, summary="修改本人密码")
async def change_password(
    payload: PasswordChangeRequest,
    request: Request,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> MessageOut:
    from app.core.audit import write_audit

    if not verify_password(payload.current_password, account.password_hash):
        raise ValidationError(
            "当前密码不正确",
            field_errors=[{"field": "current_password", "message": "当前密码不正确", "type": "value_error"}],
        )
    if payload.new_password != payload.confirm_password:
        raise ValidationError(
            "两次输入的新密码不一致",
            field_errors=[{"field": "confirm_password", "message": "两次输入不一致", "type": "value_error"}],
        )

    accounts_service.set_password(db, account, payload.new_password)
    revoked = accounts_service.revoke_all_sessions(
        db, account.id, keep_token=extract_session_token(request)
    )
    write_audit(
        db,
        category=AUDIT_CATEGORY_AUTH,
        action="password_changed",
        actor_account_id=account.id,
        actor_name=account.name,
        actor_role=account.role,
        target_type="account",
        target_id=account.id,
        summary="修改本人密码",
        detail={"revoked_other_sessions": revoked},
        request_id=ctx.request_id,
        ip_address=ctx.ip_address,
    )
    return MessageOut(message="密码已更新，其他设备上的会话已失效")
