"""BEI 阈值版本种子（T11 单一数据源）。

首版阈值逐字取自 ``docs/BEI_THRESHOLD_SOURCE.md``（PRD V1.2 §8.8.6）。
阈值**必须版本化**：后续调整只能新增版本，不得原地覆盖。
"""

from __future__ import annotations

import json

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import new_id
from app.core.timeutil import utcnow
from app.domain import bei as bei_domain
from app.models.bei import BeiThresholdItem, BeiThresholdVersion

DEFAULT_THRESHOLD_LABEL = "v1"
SOURCE_REF = "docs/体验工作台产品需求文档PRD-V1.2.md §8.8.6（经验阈值表，Q9 确认）"
SOURCE_NOTE = (
    "首版经验阈值，自 PRD V1.2 §8.8.6 提取并冻结；状态为「经验阈值 · 待校准」，"
    "上线运行 1–2 个周期后可由首账号按真实数据分布调整并留版本记录。"
)


def seed_bei_thresholds(db: Session) -> int:
    """写入 v1 阈值版本及其 15 个二级指标断点。返回新增版本数。"""
    existing = db.execute(
        select(BeiThresholdVersion).where(BeiThresholdVersion.version_label == DEFAULT_THRESHOLD_LABEL)
    ).scalars().first()
    if existing is not None:
        return 0

    now = utcnow()
    version_id = new_id()
    weights = {d.code: d.weight for d in bei_domain.DIMENSIONS}
    db.add(
        BeiThresholdVersion(
            id=version_id,
            version_label=DEFAULT_THRESHOLD_LABEL,
            source_ref=SOURCE_REF,
            source_note=SOURCE_NOTE,
            status_label=bei_domain.THRESHOLD_VERSION_STATUS,
            status="active",
            is_active=True,
            weights_json=json.dumps(weights, ensure_ascii=False),
            created_by_name="系统种子",
            created_at=now,
            updated_at=now,
        )
    )
    for order, metric in enumerate(bei_domain.METRICS):
        db.add(
            BeiThresholdItem(
                id=new_id(),
                version_id=version_id,
                metric_key=metric.key,
                item_order=order,
                dimension=metric.dimension,
                name=metric.name,
                unit=metric.unit,
                direction=metric.direction,
                full_line=metric.full,
                pass_line=metric.passing,
                zero_line=metric.zero,
                is_scoring=metric.scoring,
                source_field=metric.source_field,
                drill_down=metric.drill_down,
                created_at=now,
                updated_at=now,
            )
        )
    db.commit()
    return 1


def active_threshold(db: Session) -> BeiThresholdVersion | None:
    return (
        db.execute(
            select(BeiThresholdVersion)
            .where(BeiThresholdVersion.is_active.is_(True))
            .order_by(BeiThresholdVersion.created_at.desc())
        )
        .scalars()
        .first()
    )
