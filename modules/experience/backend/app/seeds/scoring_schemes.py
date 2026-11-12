"""评分方案与矩阵单元种子（T08 单一数据源）。

20 套方案 × 8 单元 = **160 个矩阵单元**，逐字来自 ``app.domain.scoring.MATRIX``
（PRD V1.2 §8.3）。默认方案 ``8:2 / 7:5:3:1``。

幂等：按 ``code`` 存在性判断；已存在的方案不覆盖（方案被引用后只读）。
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import new_id
from app.core.timeutil import utcnow
from app.domain import scoring as sc
from app.models.scoring import ScoringScheme, ScoringSchemeCell


def seed_scoring_schemes(db: Session) -> int:
    """写入 20 套内置方案，返回新增方案数。"""
    existing = set(db.execute(select(ScoringScheme.code)).scalars().all())
    added = 0
    now = utcnow()
    default_code = sc.DEFAULT_SCHEME_CODE

    for index, spec in enumerate(sc.MATRIX):
        code = sc.scheme_code(spec.business_ratio, spec.problem_ratio)
        if code in existing:
            continue
        scheme_id = new_id()
        db.add(
            ScoringScheme(
                id=scheme_id,
                code=code,
                name=sc.scheme_name(spec.business_ratio, spec.problem_ratio),
                business_ratio=spec.business_ratio,
                problem_ratio=spec.problem_ratio,
                scheme_version=1,
                is_default=(code == default_code),
                is_active=True,
                is_builtin=True,
                note="内置方案，逐字取自 PRD V1.2 §8.3 评分矩阵"
                + ("；**默认方案**" if code == default_code else ""),
                created_by="seed",
                created_by_name="系统种子",
                updated_by="seed",
                updated_by_name="系统种子",
                row_version=1,
                created_at=now,
                updated_at=now,
            )
        )
        for order, (key, value) in enumerate(zip(sc.CELL_KEYS, spec.values, strict=True)):
            business_level, severity = sc.CELL_ORDER[order]
            db.add(
                ScoringSchemeCell(
                    id=new_id(),
                    scheme_id=scheme_id,
                    cell_key=key,
                    business_level=business_level,
                    severity=severity,
                    cell_order=order,
                    deduction=value,
                    created_at=now,
                    updated_at=now,
                )
            )
        added += 1
    if added:
        db.commit()
    return added


def scheme_cell_map(db: Session, scheme_id: str) -> dict[str, str]:
    """读取某方案的 ``{cell_key: 扣分值字符串}``。"""
    rows = (
        db.execute(select(ScoringSchemeCell).where(ScoringSchemeCell.scheme_id == scheme_id))
        .scalars()
        .all()
    )
    return {row.cell_key: row.deduction for row in rows}


def default_scheme(db: Session) -> ScoringScheme | None:
    return (
        db.execute(select(ScoringScheme).where(ScoringScheme.is_default.is_(True), ScoringScheme.is_active.is_(True)))
        .scalars()
        .first()
    )
