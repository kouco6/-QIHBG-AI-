"""三层分值库写入服务（T12 固定接口，供 T08 / T10 / T11 复用）。

**硬性约束**（DESIGN §5 / T12 验收）：

- L1 / L2 / L3 三层**并列**入库；每条记录显式标注层级与口径；
- 查询 API **必须提供 level**，且**不存在跨层排序/比较**入口；
- 记录只是快照的**只读投影**，可回溯到 ``source_snapshot_id``。

本模块由主线（共享层）维护，各任务的快照流程统一调用 :func:`record_entry`。
"""

from __future__ import annotations

import datetime as _dt
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import new_id
from app.core.timeutil import utcnow
from app.domain import scoring as sc
from app.models.score_library import (
    CALIBER_L1,
    CALIBER_L2,
    CALIBER_L3,
    LEVEL_L1,
    LEVEL_L2,
    LEVEL_L3,
    LEVEL_LABELS,
    SOURCE_TYPE_DIVISION_EVALUATION,
    SOURCE_TYPE_SYSTEM_SNAPSHOT,
    SOURCE_TYPE_PROJECT_SNAPSHOT,
    ScoreLibraryEntry,
)

CALIBERS: dict[str, str] = {LEVEL_L1: CALIBER_L1, LEVEL_L2: CALIBER_L2, LEVEL_L3: CALIBER_L3}

# 层级 → 允许的来源类型（防止把 L2 快照写成 L1 记录）
ALLOWED_SOURCES: dict[str, tuple[str, ...]] = {
    LEVEL_L1: (SOURCE_TYPE_PROJECT_SNAPSHOT,),
    LEVEL_L2: (SOURCE_TYPE_SYSTEM_SNAPSHOT,),
    LEVEL_L3: (SOURCE_TYPE_DIVISION_EVALUATION,),
}


def record_entry(
    db: Session,
    *,
    level: str,
    object_type: str,
    object_id: str,
    object_name: str,
    source_type: str,
    source_snapshot_id: str,
    score: Any = None,
    display_score: Any = None,
    grade: str | None = None,
    period: str = "",
    version_code: str = "",
    project_id: str | None = None,
    system_id: str | None = None,
    division_id: str | None = None,
    scheme_ref: str = "",
    threshold_ref: str = "",
    issue_count: int = 0,
    has_score: bool = True,
    sample_sufficient: bool = True,
    status_note: str = "",
    extra: dict[str, Any] | None = None,
    snapshot_at: _dt.datetime | None = None,
    created_by_name: str = "",
    commit: bool = True,
) -> ScoreLibraryEntry:
    """写入一条分值库记录（幂等：同 level + source_snapshot_id 只保留一条）。"""
    if level not in CALIBERS:
        raise ValueError(f"非法层级：{level}")
    if source_type not in ALLOWED_SOURCES[level]:
        raise ValueError(f"层级 {level} 不接受来源类型 {source_type}")

    existing = (
        db.execute(
            select(ScoreLibraryEntry).where(
                ScoreLibraryEntry.level == level,
                ScoreLibraryEntry.source_snapshot_id == source_snapshot_id,
            )
        )
        .scalars()
        .first()
    )

    def _fmt(value: Any) -> str | None:
        if value is None or value == "":
            return None
        if isinstance(value, str):
            return value
        return sc.format_score(value)

    now = utcnow()
    entity = existing or ScoreLibraryEntry(id=new_id(), created_at=now, updated_at=now)
    entity.level = level
    entity.level_label = LEVEL_LABELS[level]
    entity.caliber = CALIBERS[level]
    entity.object_type = object_type
    entity.object_id = object_id
    entity.object_name = object_name
    entity.project_id = project_id
    entity.system_id = system_id
    entity.division_id = division_id
    entity.period = period
    entity.version_code = version_code
    entity.score = _fmt(score)
    entity.display_score = _fmt(display_score) if display_score is not None else _fmt(score)
    entity.grade = grade
    entity.has_score = has_score
    entity.sample_sufficient = sample_sufficient
    entity.status_note = status_note
    entity.scheme_ref = scheme_ref
    entity.threshold_ref = threshold_ref
    entity.source_type = source_type
    entity.source_snapshot_id = source_snapshot_id
    entity.issue_count = issue_count
    import json

    entity.extra_json = json.dumps(extra or {}, ensure_ascii=False)
    entity.snapshot_at = snapshot_at or now
    entity.created_by_name = created_by_name
    entity.updated_at = now

    if existing is None:
        db.add(entity)
    if commit:
        db.commit()
        db.refresh(entity)
    else:
        db.flush()
    return entity
