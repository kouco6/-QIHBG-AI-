"""账号目录与启停（T03）。

- ``GET /accounts``：所有登录账号可读（人员目录属于业务可见范围）。
- ``POST /accounts``、``PATCH /accounts/{id}/status``：仅首账号；普通账号 403。
- 不存在账号统一 404；不得停用自己（避免锁死唯一首账号）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import RequestContext, get_current_account, get_request_context, require_setting_write
from app.core.db import get_db
from app.core.errors import ConflictError, NotFoundError
from app.core.timeutil import iso_z
from app.models.account import AUDIT_CATEGORY_SETTING, Account
from app.schemas.auth import AccountOut
from app.services import accounts as accounts_service

router = APIRouter(prefix="/accounts", tags=["accounts"])


class AccountCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    account: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class AccountStatusRequest(BaseModel):
    is_active: bool


def _out(account: Account) -> AccountOut:
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


@router.get("", response_model=list[AccountOut], summary="账号目录（所有登录账号可读）")
async def list_accounts(
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> list[AccountOut]:
    rows = db.execute(select(Account).order_by(Account.created_at)).scalars().all()
    return [_out(row) for row in rows]


@router.post(
    "",
    response_model=AccountOut,
    status_code=status.HTTP_201_CREATED,
    summary="新增体验人员账号（仅首账号）",
)
async def create_account(
    payload: AccountCreateRequest,
    ctx: RequestContext = Depends(get_request_context),
    actor: Account = Depends(require_setting_write),
    db: Session = Depends(get_db),
) -> AccountOut:
    from app.core.audit import write_audit

    created = accounts_service.create_account(
        db, name=payload.name, account=payload.account, password=payload.password
    )
    write_audit(
        db,
        category=AUDIT_CATEGORY_SETTING,
        action="account_created",
        actor_account_id=actor.id,
        actor_name=actor.name,
        actor_role=actor.role,
        target_type="account",
        target_id=created.id,
        summary=f"新增体验人员账号 {created.account}",
        detail={"account": created.account, "name": created.name, "role": created.role},
        request_id=ctx.request_id,
        ip_address=ctx.ip_address,
    )
    return _out(created)


@router.patch("/{account_id}/status", response_model=AccountOut, summary="启停账号（仅首账号）")
async def update_status(
    account_id: str,
    payload: AccountStatusRequest,
    ctx: RequestContext = Depends(get_request_context),
    actor: Account = Depends(require_setting_write),
    db: Session = Depends(get_db),
) -> AccountOut:
    from app.core.audit import write_audit

    target = db.get(Account, account_id)
    if target is None:
        raise NotFoundError("账号不存在")
    if target.id == actor.id and not payload.is_active:
        raise ConflictError("不能停用当前登录账号", code="self_disable_forbidden")

    accounts_service.set_active(db, target, is_active=payload.is_active)
    write_audit(
        db,
        category=AUDIT_CATEGORY_SETTING,
        action="account_status_changed",
        actor_account_id=actor.id,
        actor_name=actor.name,
        actor_role=actor.role,
        target_type="account",
        target_id=target.id,
        summary=f"{'启用' if payload.is_active else '停用'}账号 {target.account}",
        detail={"account": target.account, "is_active": payload.is_active},
        request_id=ctx.request_id,
        ip_address=ctx.ip_address,
    )
    return _out(target)
