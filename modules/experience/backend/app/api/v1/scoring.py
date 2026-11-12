"""UEI 评分方案、L1 预览与快照接口（T08）。

覆盖 DESIGN §5 的 ``/scoring-schemes/*``、``/scores/preview``、
``/project-score-snapshots/*`` 三个接口族。

统一约定：

- 所有端点依赖 :func:`app.api.deps.get_current_account`，未登录 401；
- 方案写操作（新建 / 修改 / 默认 / 停用）**仅首账号**，普通账号 403；
- 被快照或产品线引用的方案版本**只读**（409）；
- 快照**不可变**：``PATCH`` / ``PUT`` / ``DELETE`` 一律 405；
- 多产品线方案冲突时禁止创建新的有效快照（409，``code=scheme_conflict``）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.deps import (
    RequestContext,
    get_current_account,
    get_request_context,
    require_primary_account,
)
from app.core.db import get_db
from app.models.account import Account
from app.models.scoring import ScoringScheme
from app.schemas.scoring import (
    SchemeCreate,
    SchemeListOut,
    SchemeOut,
    SchemeUpdate,
    ScorePreviewOut,
    SnapshotCreateRequest,
    SnapshotListOut,
    SnapshotOut,
    SnapshotSummaryOut,
)
from app.services import scoring as scoring_service
from app.services.common import get_or_404

router = APIRouter(tags=["scoring"])

schemes_router = APIRouter(prefix="/scoring-schemes", tags=["scoring-schemes"])
scores_router = APIRouter(prefix="/scores", tags=["scores"])
snapshots_router = APIRouter(prefix="/project-score-snapshots", tags=["project-score-snapshots"])

IMMUTABLE_MESSAGE = "评分快照不可修改，请创建新快照"


# =========================================================================== 方案


@schemes_router.get("", response_model=SchemeListOut, summary="评分方案列表（所有账号可读）")
async def list_schemes(
    keyword: str | None = Query(default=None),
    include_inactive: bool = Query(default=True),
    with_cells: bool = Query(default=False),
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> SchemeListOut:
    items = scoring_service.list_schemes(
        db, keyword=keyword, include_inactive=include_inactive, with_cells=with_cells
    )
    from app.domain import scoring as sc

    return SchemeListOut(
        total=len(items),
        include_inactive=include_inactive,
        default_code=sc.DEFAULT_SCHEME_CODE,
        items=[SchemeOut(**item) for item in items],
    )


@schemes_router.post(
    "",
    response_model=SchemeOut,
    status_code=status.HTTP_201_CREATED,
    summary="创建评分方案 / 新方案版本（仅首账号）",
)
async def create_scheme(
    payload: SchemeCreate,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(require_primary_account),
    db: Session = Depends(get_db),
) -> SchemeOut:
    data = scoring_service.create_scheme(db, payload=payload, account=account, ctx=ctx)
    return SchemeOut(**data)


@schemes_router.get("/{scheme_id}", response_model=SchemeOut, summary="评分方案详情（含 8 个矩阵单元）")
async def get_scheme(
    scheme_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> SchemeOut:
    scheme = get_or_404(db, ScoringScheme, scheme_id, "评分方案")
    return SchemeOut(**scoring_service.scheme_payload(db, scheme, with_cells=True))


@schemes_router.patch(
    "/{scheme_id}",
    response_model=SchemeOut,
    summary="修改评分方案（仅首账号；被引用的方案只读 → 409）",
)
async def update_scheme(
    scheme_id: str,
    payload: SchemeUpdate,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(require_primary_account),
    db: Session = Depends(get_db),
) -> SchemeOut:
    data = scoring_service.update_scheme(db, scheme_id=scheme_id, payload=payload, account=account, ctx=ctx)
    return SchemeOut(**data)


@schemes_router.post(
    "/{scheme_id}/set-default",
    response_model=SchemeOut,
    summary="设为默认方案（仅首账号）",
)
async def set_default_scheme(
    scheme_id: str,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(require_primary_account),
    db: Session = Depends(get_db),
) -> SchemeOut:
    data = scoring_service.set_default_scheme(db, scheme_id=scheme_id, account=account, ctx=ctx)
    return SchemeOut(**data)


@schemes_router.post(
    "/{scheme_id}/archive",
    response_model=SchemeOut,
    summary="停用方案（仅首账号；不物理删除）",
)
async def archive_scheme(
    scheme_id: str,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(require_primary_account),
    db: Session = Depends(get_db),
) -> SchemeOut:
    data = scoring_service.archive_scheme(db, scheme_id=scheme_id, account=account, ctx=ctx)
    return SchemeOut(**data)


# =========================================================================== 预览


@scores_router.get("/preview", response_model=ScorePreviewOut, summary="L1 UEI 实时预览（逐问题可展开）")
async def preview_score(
    project_id: str = Query(..., description="项目 ID"),
    scheme_id: str | None = Query(default=None, description="显式方案；缺省按产品线归属解析"),
    version_id: str | None = Query(default=None, description="可选：仅统计指定产品版本的问题"),
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> ScorePreviewOut:
    data = scoring_service.preview_score(
        db, project_id=project_id, scheme_id=scheme_id, version_id=version_id
    )
    return ScorePreviewOut(**data)


# =========================================================================== L1 快照


@snapshots_router.post(
    "",
    response_model=SnapshotOut,
    status_code=status.HTTP_201_CREATED,
    summary="创建 L1 评分快照（追加写、不可变）",
)
async def create_snapshot(
    payload: SnapshotCreateRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> SnapshotOut:
    data = scoring_service.create_l1_snapshot(
        db,
        project_id=payload.project_id,
        scheme_id=payload.scheme_id,
        version_id=payload.version_id,
        account=account,
        ctx=ctx,
    )
    return SnapshotOut(**data)


@snapshots_router.get("", response_model=SnapshotListOut, summary="L1 快照列表（过滤 + 分页）")
async def list_snapshots(
    system_id: str | None = Query(default=None),
    project_id: str | None = Query(default=None),
    scheme_id: str | None = Query(default=None),
    is_effective: bool | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> SnapshotListOut:
    rows, total = scoring_service.list_snapshots(
        db,
        system_id=system_id,
        project_id=project_id,
        scheme_id=scheme_id,
        is_effective=is_effective,
        page=page,
        page_size=page_size,
    )
    return SnapshotListOut(
        page=page,
        page_size=page_size,
        total=total,
        items=[SnapshotSummaryOut(**scoring_service.snapshot_summary(row)) for row in rows],
    )


@snapshots_router.get("/{snapshot_id}", response_model=SnapshotOut, summary="L1 快照详情（含逐问题明细与计算轨迹）")
async def get_snapshot(
    snapshot_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> SnapshotOut:
    snapshot = scoring_service.get_snapshot(db, snapshot_id)
    return SnapshotOut(**scoring_service.snapshot_payload(db, snapshot, with_issues=True, with_trace=True))


def _immutable() -> None:
    raise HTTPException(status_code=status.HTTP_405_METHOD_NOT_ALLOWED, detail=IMMUTABLE_MESSAGE)


@snapshots_router.patch("/{snapshot_id}", status_code=405, summary="快照不可修改（405）")
async def patch_snapshot_immutable(snapshot_id: str, _account: Account = Depends(get_current_account)) -> None:
    _immutable()


@snapshots_router.put("/{snapshot_id}", status_code=405, summary="快照不可修改（405）")
async def put_snapshot_immutable(snapshot_id: str, _account: Account = Depends(get_current_account)) -> None:
    _immutable()


@snapshots_router.delete("/{snapshot_id}", status_code=405, summary="快照不可删除（405）")
async def delete_snapshot_immutable(snapshot_id: str, _account: Account = Depends(get_current_account)) -> None:
    _immutable()


router.include_router(schemes_router)
router.include_router(scores_router)
router.include_router(snapshots_router)

__all__ = ["router"]
