"""系统设置与审计查询（T03）。

权限口径（ACCEPTANCE 启动与账号 / T03）：
- ``GET /settings``、``GET /audit-logs``：**全部登录账号**均可读 —— 体现「普通体验人员
  与首账号拥有相同业务可见范围」。未登录一律 401。
- ``PATCH /settings/{key}``：**仅首账号**可写；普通账号 403；key 不存在 404；写操作留审计。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import RequestContext, get_current_account, get_request_context, require_setting_write
from app.core.db import get_db
from app.core.errors import NotFoundError
from app.core.timeutil import iso_z, utcnow
from app.models.account import (
    AUDIT_CATEGORY_SETTING,
    Account,
    AuditLog,
)
from app.models.system import SystemSetting
from app.schemas.auth import SettingOut, SettingUpdateRequest

router = APIRouter(tags=["settings"])


@router.get("/settings", response_model=list[SettingOut], summary="系统设置列表（所有账号可读）")
async def list_settings(
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> list[SettingOut]:
    rows = db.execute(select(SystemSetting).order_by(SystemSetting.key)).scalars().all()
    return [
        SettingOut(
            key=row.key,
            value=row.value,
            value_type=row.value_type,
            description=row.description,
            updated_by=row.updated_by,
            updated_at=iso_z(row.updated_at),
        )
        for row in rows
    ]


@router.patch(
    "/settings/{key}",
    response_model=SettingOut,
    summary="写入系统设置（仅首账号；普通账号 403）",
)
async def update_setting(
    key: str,
    payload: SettingUpdateRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(require_setting_write),
    db: Session = Depends(get_db),
) -> SettingOut:
    from app.core.audit import write_audit

    row = db.get(SystemSetting, key)
    if row is None:
        raise NotFoundError(f"配置项不存在：{key}")

    previous = row.value
    row.value = payload.value
    row.updated_by = account.account
    row.updated_at = utcnow()
    db.commit()
    db.refresh(row)

    write_audit(
        db,
        category=AUDIT_CATEGORY_SETTING,
        action="setting_updated",
        actor_account_id=account.id,
        actor_name=account.name,
        actor_role=account.role,
        target_type="system_setting",
        target_id=key,
        summary=f"修改系统设置 {key}",
        detail={"key": key, "before": previous, "after": payload.value},
        request_id=ctx.request_id,
        ip_address=ctx.ip_address,
    )
    return SettingOut(
        key=row.key,
        value=row.value,
        value_type=row.value_type,
        description=row.description,
        updated_by=row.updated_by,
        updated_at=iso_z(row.updated_at),
    )


@router.get("/audit-logs", summary="审计日志（所有账号可读，支持分页与分类过滤）")
async def list_audit_logs(
    request: Request,
    category: str | None = Query(default=None, description="auth / business / setting"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    stmt = select(AuditLog)
    count_stmt = select(AuditLog)
    if category:
        stmt = stmt.where(AuditLog.category == category)
        count_stmt = count_stmt.where(AuditLog.category == category)

    total = len(db.execute(count_stmt).scalars().all())
    rows = (
        db.execute(
            stmt.order_by(AuditLog.created_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        .scalars()
        .all()
    )
    return {
        "page": page,
        "page_size": page_size,
        "total": total,
        "items": [
            {
                "id": row.id,
                "category": row.category,
                "action": row.action,
                "actor_name": row.actor_name,
                "actor_role": row.actor_role,
                "target_type": row.target_type,
                "target_id": row.target_id,
                "summary": row.summary,
                "detail": row.detail,
                "request_id": row.request_id,
                "created_at": iso_z(row.created_at),
            }
            for row in rows
        ],
    }
