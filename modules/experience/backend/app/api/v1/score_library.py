"""三层分值库查询（T12）。

**硬性约束**：

- ``GET /score-library`` **必须提供 ``level``（L1/L2/L3）**，缺失或非法返回 422；
- 只支持**同层内**排序（``sort`` 白名单为 snapshot_at / score），**不存在跨层排名、
  混排或比较大小**的入口或参数；
- 三个固定 Tab 由前端按 level 分别请求，后端不提供合并视图。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_account
from app.core.db import get_db
from app.core.errors import NotFoundError, ValidationError
from app.core.timeutil import iso_z
from app.models.account import Account
from app.models.score_library import LEVEL_LABELS, LEVELS, ScoreLibraryEntry

router = APIRouter(tags=["score-library"])

# 仅允许「同层内」排序字段；不含任何跨层比较能力
_SORT_FIELDS = {"snapshot_at": ScoreLibraryEntry.snapshot_at, "score": ScoreLibraryEntry.score}


def _caliber(level: str) -> str:
    from app.services.score_library import CALIBERS

    return CALIBERS[level]


def _serialize(row: ScoreLibraryEntry) -> dict[str, object]:
    return {
        "id": row.id,
        "level": row.level,
        "level_label": row.level_label,
        "caliber": row.caliber,
        "object_type": row.object_type,
        "object_id": row.object_id,
        "object_name": row.object_name,
        "project_id": row.project_id,
        "system_id": row.system_id,
        "division_id": row.division_id,
        "period": row.period,
        "version_code": row.version_code,
        "score": row.score,
        "display_score": row.display_score,
        "grade": row.grade,
        "has_score": row.has_score,
        "sample_sufficient": row.sample_sufficient,
        "status_note": row.status_note,
        "scheme_ref": row.scheme_ref,
        "threshold_ref": row.threshold_ref,
        "source_type": row.source_type,
        "source_snapshot_id": row.source_snapshot_id,
        "issue_count": row.issue_count,
        "snapshot_at": iso_z(row.snapshot_at),
        "created_by_name": row.created_by_name,
    }


@router.get("/score-library/levels", summary="分值库层级元数据（三个固定 Tab）")
async def levels(_account: Account = Depends(get_current_account)) -> dict[str, object]:
    return {
        "levels": [
            {"level": lv, "label": LEVEL_LABELS[lv], "caliber": _caliber(lv)} for lv in LEVELS
        ],
        "cross_level_comparison": False,
        "note": "三层并列展示；禁止跨层级直接排名或比较大小（DESIGN §5 / T12）。",
    }


@router.get("/score-library", summary="分值库查询（必须指定 level，禁止跨层）")
async def list_entries(
    level: str = Query(..., description="层级，必须为 L1 / L2 / L3"),
    object_type: str | None = Query(default=None),
    object_id: str | None = Query(default=None),
    division_id: str | None = Query(default=None),
    system_id: str | None = Query(default=None),
    project_id: str | None = Query(default=None),
    period: str | None = Query(default=None),
    sort: str = Query(default="snapshot_at", description="同层排序字段：snapshot_at / score"),
    order: str = Query(default="desc", pattern="^(asc|desc)$"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    normalized = (level or "").strip().upper()
    if normalized not in LEVELS:
        raise ValidationError(
            "必须指定分值库层级",
            field_errors=[
                {
                    "field": "level",
                    "message": "请选择层级：L1（单产品 UEI）/ L2（产品线 UEI）/ L3（事业部 BEI）",
                    "type": "value_error",
                }
            ],
        )
    if sort not in _SORT_FIELDS:
        raise ValidationError(
            "不支持的排序字段",
            field_errors=[
                {
                    "field": "sort",
                    "message": "分值库仅支持同层内按 snapshot_at 或 score 排序，不提供跨层比较",
                    "type": "value_error",
                }
            ],
        )

    stmt = select(ScoreLibraryEntry).where(ScoreLibraryEntry.level == normalized)
    if object_type:
        stmt = stmt.where(ScoreLibraryEntry.object_type == object_type)
    if object_id:
        stmt = stmt.where(ScoreLibraryEntry.object_id == object_id)
    if division_id:
        stmt = stmt.where(ScoreLibraryEntry.division_id == division_id)
    if system_id:
        stmt = stmt.where(ScoreLibraryEntry.system_id == system_id)
    if project_id:
        stmt = stmt.where(ScoreLibraryEntry.project_id == project_id)
    if period:
        stmt = stmt.where(ScoreLibraryEntry.period == period)

    column = _SORT_FIELDS[sort]
    stmt = stmt.order_by(column.desc() if order == "desc" else column.asc())

    rows = db.execute(stmt).scalars().all()
    total = len(rows)
    page_rows = rows[(page - 1) * page_size : (page - 1) * page_size + page_size]
    return {
        "level": normalized,
        "level_label": LEVEL_LABELS[normalized],
        "caliber": _caliber(normalized),
        "cross_level_comparison": False,
        "page": page,
        "page_size": page_size,
        "total": total,
        "items": [_serialize(row) for row in page_rows],
    }


@router.get("/score-library/{entry_id}", summary="分值库记录详情（可回溯到快照）")
async def get_entry(
    entry_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    row = db.get(ScoreLibraryEntry, entry_id)
    if row is None:
        raise NotFoundError("分值库记录不存在")
    payload = _serialize(row)
    payload["extra"] = row.extra_json
    return payload
