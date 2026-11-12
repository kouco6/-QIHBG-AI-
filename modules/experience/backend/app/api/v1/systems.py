"""系统管理与系统合并 UEI 接口（T10 / v1.1 层级合并）。

覆盖 ``/systems/*``、``/system-snapshots/*``、``/system-comparisons``。

统一约定：

- 所有端点依赖 :func:`app.api.deps.get_current_account`，未登录 401；
- 实体不存在 404；校验失败 422；编码重复 / 非法成员操作 409；
- 所有写操作写业务审计；
- 系统快照**不可变**：``PATCH`` / ``PUT`` / ``DELETE`` 一律 405；
- 跨系统对比只允许 **2–5** 个（少于 2 或多于 5 立即 422）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.deps import RequestContext, get_current_account, get_request_context
from app.core.db import get_db
from app.models.account import Account
from app.models.systems import System
from app.schemas.systems import (
    L2PreviewOut,
    L2SnapshotCreate,
    L2SnapshotListOut,
    L2SnapshotOut,
    MemberAttachRequest,
    MemberWeightRequest,
    SchemeChangeRequest,
    SystemComparisonOut,
    SystemComparisonRequest,
    SystemCreate,
    SystemDetailOut,
    SystemListOut,
    SystemMemberOut,
    SystemOut,
    SystemSnapshotSummaryOut,
    SystemUpdate,
)
from app.services import systems as sys_service
from app.services.common import get_or_404

router = APIRouter(tags=["systems"])

systems_router = APIRouter(prefix="/systems", tags=["systems"])
snapshots_router = APIRouter(prefix="/system-snapshots", tags=["system-snapshots"])
comparisons_router = APIRouter(prefix="/system-comparisons", tags=["system-comparisons"])

IMMUTABLE_MESSAGE = "系统快照不可修改，请创建新快照"


def _system(db: Session, system_id: str) -> System:
    return get_or_404(db, System, system_id, "系统")


# =========================================================================== 系统


@systems_router.get("", response_model=SystemListOut, summary="系统列表（关键字 / 状态 + 分页）")
async def list_systems(
    keyword: str | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> SystemListOut:
    rows, total = sys_service.list_systems(
        db, keyword=keyword, status=status_filter, page=page, page_size=page_size
    )
    return SystemListOut(
        page=page,
        page_size=page_size,
        total=total,
        items=[SystemOut(**sys_service.system_payload(db, row)) for row in rows],
    )


@systems_router.post(
    "",
    response_model=SystemDetailOut,
    status_code=status.HTTP_201_CREATED,
    summary="创建系统（编码唯一 409；必须绑定评分方案）",
)
async def create_system(
    payload: SystemCreate,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> SystemDetailOut:
    system = sys_service.create_system(
        db,
        code=payload.code,
        name=payload.name,
        scheme_id=payload.scheme_id,
        owner_text=payload.owner_text,
        division_id=payload.division_id,
        note=payload.note,
        account=account,
        ctx=ctx,
    )
    return SystemDetailOut(**sys_service.system_detail(db, system))


@systems_router.get("/{system_id}", response_model=SystemDetailOut, summary="系统详情（成员项目 / 方案 / 提示 / 快照历史）")
async def get_system(
    system_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> SystemDetailOut:
    return SystemDetailOut(**sys_service.system_detail(db, _system(db, system_id)))


@systems_router.patch("/{system_id}", response_model=SystemOut, summary="更新系统")
async def update_system(
    system_id: str,
    payload: SystemUpdate,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> SystemOut:
    system = sys_service.update_system(db, system=_system(db, system_id), payload=payload, account=account, ctx=ctx)
    return SystemOut(**sys_service.system_payload(db, system))


@systems_router.post("/{system_id}/archive", response_model=SystemOut, summary="停用系统（有进行中项目 409，历史保留）")
async def archive_system(
    system_id: str,
    payload: dict | None = None,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> SystemOut:
    reason = (payload or {}).get("reason")
    system = sys_service.archive_system(
        db, system=_system(db, system_id), reason=reason, account=account, ctx=ctx
    )
    return SystemOut(**sys_service.system_payload(db, system))


# =========================================================================== 成员（项目）


@systems_router.get("/{system_id}/members", response_model=list[SystemMemberOut], summary="成员项目列表")
async def list_members(
    system_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> list[SystemMemberOut]:
    system = _system(db, system_id)
    return [
        SystemMemberOut(**sys_service.member_payload(db, row, with_versions=True))
        for row in sys_service.all_members(db, system.id)
    ]


@systems_router.post(
    "/{system_id}/members",
    response_model=SystemMemberOut,
    status_code=status.HTTP_201_CREATED,
    summary="挂入项目（可携权重；项目已在其他系统时视为转移并留审计）",
)
async def attach_member(
    system_id: str,
    payload: MemberAttachRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> SystemMemberOut:
    project = sys_service.attach_project(
        db, system=_system(db, system_id), project_id=payload.project_id,
        weight=payload.weight, account=account, ctx=ctx,
    )
    return SystemMemberOut(**sys_service.member_payload(db, project, with_versions=True))


@systems_router.post(
    "/{system_id}/members/{project_id}/weight",
    response_model=SystemMemberOut,
    summary="调整成员项目权重（影响权重加权口径）",
)
async def set_member_weight(
    system_id: str,
    project_id: str,
    payload: MemberWeightRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> SystemMemberOut:
    project = sys_service.set_member_weight(
        db, system=_system(db, system_id), project_id=project_id,
        weight=payload.weight, account=account, ctx=ctx,
    )
    return SystemMemberOut(**sys_service.member_payload(db, project, with_versions=True))


# =========================================================================== 方案


@systems_router.post("/{system_id}/scheme", response_model=SystemOut, summary="换绑定方案（自增 scheme_version，历史快照不受影响）")
async def change_scheme(
    system_id: str,
    payload: SchemeChangeRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> SystemOut:
    system = sys_service.change_scheme(
        db,
        system=_system(db, system_id),
        scheme_id=payload.scheme_id,
        reason=payload.reason,
        account=account,
        ctx=ctx,
    )
    return SystemOut(**sys_service.system_payload(db, system))


# =========================================================================== L2 预览 / 统计


def _preview(db: Session, system_id: str, *, selection_mode: str, from_value: str | None, to_value: str | None, version_prefix: str | None, top_n: int = 5) -> dict:
    return sys_service.l2_preview(
        db,
        system=_system(db, system_id),
        selection_mode=selection_mode,
        from_value=from_value,
        to_value=to_value,
        version_prefix=version_prefix,
        top_n=top_n,
    )


@systems_router.get(
    "/{system_id}/analytics/preview",
    response_model=L2PreviewOut,
    summary="系统合并 UEI 预览（去重重算 + 权重加权并列；最新有效 / 时间窗口 / 版本区间）",
)
async def preview_l2(
    system_id: str,
    selection_mode: str = Query(default="latest", description="latest / window / version"),
    from_value: str | None = Query(default=None, alias="from"),
    to_value: str | None = Query(default=None, alias="to"),
    version_prefix: str | None = Query(default=None),
    top_n: int = Query(default=5, ge=1, le=20),
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> L2PreviewOut:
    data = _preview(
        db,
        system_id,
        selection_mode=selection_mode,
        from_value=from_value,
        to_value=to_value,
        version_prefix=version_prefix,
        top_n=top_n,
    )
    return L2PreviewOut(**data)


@systems_router.get(
    "/{system_id}/analytics",
    response_model=L2PreviewOut,
    summary="系统统计（与预览同口径，默认取最新有效快照）",
)
async def system_analytics(
    system_id: str,
    selection_mode: str = Query(default="latest"),
    from_value: str | None = Query(default=None, alias="from"),
    to_value: str | None = Query(default=None, alias="to"),
    version_prefix: str | None = Query(default=None),
    top_n: int = Query(default=5, ge=1, le=20),
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> L2PreviewOut:
    data = _preview(
        db,
        system_id,
        selection_mode=selection_mode,
        from_value=from_value,
        to_value=to_value,
        version_prefix=version_prefix,
        top_n=top_n,
    )
    return L2PreviewOut(**data)


# =========================================================================== L2 快照


@snapshots_router.post(
    "",
    response_model=L2SnapshotOut,
    status_code=status.HTTP_201_CREATED,
    summary="创建系统快照（筛选条件随快照保存，追加写不可变）",
)
async def create_l2_snapshot(
    payload: L2SnapshotCreate,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> L2SnapshotOut:
    data = sys_service.create_l2_snapshot(
        db,
        system=_system(db, payload.system_id),
        selection_mode=payload.selection_mode,
        from_value=payload.from_,
        to_value=payload.to,
        version_prefix=payload.version_prefix,
        note=payload.note,
        account=account,
        ctx=ctx,
    )
    return L2SnapshotOut(**data)


@snapshots_router.get("", response_model=L2SnapshotListOut, summary="系统快照列表（按系统 / 方案过滤 + 分页）")
async def list_l2_snapshots(
    system_id: str | None = Query(default=None),
    scheme_id: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> L2SnapshotListOut:
    rows, total = sys_service.list_l2_snapshots(db, system_id=system_id, scheme_id=scheme_id, page=page, page_size=page_size)
    return L2SnapshotListOut(
        page=page,
        page_size=page_size,
        total=total,
        items=[SystemSnapshotSummaryOut(**sys_service.l2_snapshot_summary(row)) for row in rows],
    )


@snapshots_router.get("/{snapshot_id}", response_model=L2SnapshotOut, summary="系统快照详情（来源 L1、去重前后计数、问题集合、各口径）")
async def get_l2_snapshot(
    snapshot_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> L2SnapshotOut:
    snapshot = sys_service.get_l2_snapshot(db, snapshot_id)
    return L2SnapshotOut(**sys_service.l2_snapshot_payload(snapshot, with_details=True))


def _immutable() -> None:
    raise HTTPException(status_code=status.HTTP_405_METHOD_NOT_ALLOWED, detail=IMMUTABLE_MESSAGE)


@snapshots_router.patch("/{snapshot_id}", status_code=405, summary="系统快照不可修改（405）")
async def patch_l2_snapshot(snapshot_id: str, _account: Account = Depends(get_current_account)) -> None:
    _immutable()


@snapshots_router.put("/{snapshot_id}", status_code=405, summary="系统快照不可修改（405）")
async def put_l2_snapshot(snapshot_id: str, _account: Account = Depends(get_current_account)) -> None:
    _immutable()


@snapshots_router.delete("/{snapshot_id}", status_code=405, summary="系统快照不可删除（405）")
async def delete_l2_snapshot(snapshot_id: str, _account: Account = Depends(get_current_account)) -> None:
    _immutable()


# =========================================================================== 跨系统对比


@comparisons_router.post("", response_model=SystemComparisonOut, summary="跨系统对比（只允许 2–5 个）")
async def compare_systems(
    payload: SystemComparisonRequest,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> SystemComparisonOut:
    data = sys_service.compare_systems(
        db,
        system_ids=payload.system_ids,
        selection_mode=payload.selection_mode,
        from_value=payload.from_,
        to_value=payload.to,
        version_prefix=payload.version_prefix,
        top_n=payload.top_n,
    )
    return SystemComparisonOut(**data)


router.include_router(systems_router)
router.include_router(snapshots_router)
router.include_router(comparisons_router)

__all__ = ["router"]
