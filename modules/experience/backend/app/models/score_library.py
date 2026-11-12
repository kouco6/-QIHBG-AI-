"""三层分值库（T12）。

**硬性约束**：L1 / L2 / L3 三层**并列**入库，每条记录显式标注层级与口径；
查询 API **必须提供 level**，不允许跨层级排序或比较大小（DESIGN §5 / T12）。

本表是「快照的只读投影」：写入由各快照生成流程负责，快照本体仍是权威来源，
分值库记录仅保存可回溯的引用与展示字段。
"""

from __future__ import annotations

import datetime as _dt

from sqlalchemy import Boolean, DateTime, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base, TimestampMixin

LEVEL_L1 = "L1"
LEVEL_L2 = "L2"
LEVEL_L3 = "L3"
LEVELS: tuple[str, ...] = (LEVEL_L1, LEVEL_L2, LEVEL_L3)
LEVEL_LABELS: dict[str, str] = {
    LEVEL_L1: "L1 单产品 UEI",
    LEVEL_L2: "L2 产品线 UEI",
    LEVEL_L3: "L3 事业部 BEI",
}

SOURCE_TYPE_PROJECT_SNAPSHOT = "project_score_snapshot"
SOURCE_TYPE_SYSTEM_SNAPSHOT = "system_snapshot"
SOURCE_TYPE_DIVISION_EVALUATION = "division_evaluation"

CALIBER_L1 = "单产品 UEI：100 − Σ问题单项扣分值（矩阵值已含业务权重）"
CALIBER_L2 = "产品线 UEI：线内产品问题集合并集按问题 ID 去重后，用线绑定方案并集重算"
CALIBER_L3 = "事业部 BEI：五维加权指数（不重算 UEI），经验阈值归一化"


class ScoreLibraryEntry(Base, TimestampMixin):
    """分值库记录（三层并列，禁止跨层比较）。"""

    __tablename__ = "score_library"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    level: Mapped[str] = mapped_column(String(4), nullable=False, index=True)
    level_label: Mapped[str] = mapped_column(String(32), nullable=False, default="")
    caliber: Mapped[str] = mapped_column(Text, nullable=False, default="")

    object_type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    object_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    object_name: Mapped[str] = mapped_column(String(160), nullable=False, default="", index=True)
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    system_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    division_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)

    period: Mapped[str] = mapped_column(String(32), nullable=False, default="", index=True)
    version_code: Mapped[str] = mapped_column(String(64), nullable=False, default="")

    score: Mapped[str | None] = mapped_column(String(24), nullable=True)
    display_score: Mapped[str | None] = mapped_column(String(24), nullable=True)
    grade: Mapped[str | None] = mapped_column(String(16), nullable=True)
    has_score: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sample_sufficient: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    status_note: Mapped[str] = mapped_column(String(120), nullable=False, default="")

    scheme_ref: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    threshold_ref: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    source_type: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    source_snapshot_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    issue_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    extra_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")

    snapshot_at: Mapped[_dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    created_by_name: Mapped[str] = mapped_column(String(64), nullable=False, default="")


Index("ix_score_library_level_object", ScoreLibraryEntry.level, ScoreLibraryEntry.object_id)
Index("ix_score_library_source", ScoreLibraryEntry.source_type, ScoreLibraryEntry.source_snapshot_id)
