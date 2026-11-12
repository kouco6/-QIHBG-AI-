"""BEI 事业部体验评价模型（T11）。

- ``BeiThresholdVersion`` / ``BeiThresholdItem``：**阈值版本化** —— 首版来自 PRD
  V1.2 §8.8.6（见 ``docs/BEI_THRESHOLD_SOURCE.md``），后续调整必须新建版本，
  不得原地覆盖；界面统一标注「经验阈值 · 待校准」。
- ``DivisionEvaluation``：季度评价主体（明细实时、榜单季度定榜不可变）。
- ``BeiMetricValue``：二级指标原始值、归一化分与下钻依据。
- ``BeiManualScore``：人工印象分（≤ 20%，必须有事由、依据与录入人）。
"""

from __future__ import annotations

import datetime as _dt

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models import AuditMixin, Base, TimestampMixin

# 评价状态
EVAL_ESTIMATE = "estimate"                  # 未定榜预估
EVAL_DRAFT = "draft"                        # 定榜草稿
EVAL_FINALIZED = "finalized"                # 已定榜（不可变）
EVAL_INSUFFICIENT = "insufficient_sample"   # 样本不足
EVAL_NO_DATA = "no_participating_data"      # 本期无参评数据

EVAL_STATUSES: tuple[str, ...] = (EVAL_ESTIMATE, EVAL_DRAFT, EVAL_FINALIZED, EVAL_INSUFFICIENT, EVAL_NO_DATA)
EVAL_STATUS_LABELS: dict[str, str] = {
    EVAL_ESTIMATE: "未定榜（预估）",
    EVAL_DRAFT: "定榜草稿",
    EVAL_FINALIZED: "已定榜",
    EVAL_INSUFFICIENT: "样本不足",
    EVAL_NO_DATA: "本期无参评数据",
}

THRESHOLD_DRAFT = "draft"
THRESHOLD_ACTIVE = "active"
THRESHOLD_RETIRED = "retired"


class BeiThresholdVersion(Base, TimestampMixin):
    """阈值版本（不可变；调整产生新版本）。"""

    __tablename__ = "bei_threshold_version"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    version_label: Mapped[str] = mapped_column(String(32), nullable=False, unique=True, index=True)
    source_ref: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    source_note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    status_label: Mapped[str] = mapped_column(String(32), nullable=False, default="经验阈值 · 待校准")
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=THRESHOLD_ACTIVE, index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)
    weights_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    created_by_name: Mapped[str] = mapped_column(String(64), nullable=False, default="")

    items: Mapped[list[BeiThresholdItem]] = relationship(
        back_populates="version", cascade="all, delete-orphan", lazy="selectin",
        order_by="BeiThresholdItem.item_order",
    )


class BeiThresholdItem(Base, TimestampMixin):
    """单个二级指标的经验阈值断点。"""

    __tablename__ = "bei_threshold_item"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    version_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("bei_threshold_version.id", ondelete="CASCADE"), nullable=False, index=True
    )
    metric_key: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    item_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    dimension: Mapped[str] = mapped_column(String(8), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    unit: Mapped[str] = mapped_column(String(24), nullable=False, default="")
    direction: Mapped[str] = mapped_column(String(20), nullable=False)
    full_line: Mapped[str | None] = mapped_column(String(24), nullable=True)
    pass_line: Mapped[str | None] = mapped_column(String(24), nullable=True)
    zero_line: Mapped[str | None] = mapped_column(String(24), nullable=True)
    is_scoring: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    source_field: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    drill_down: Mapped[str] = mapped_column(String(255), nullable=False, default="")

    version: Mapped[BeiThresholdVersion] = relationship(back_populates="items")


Index("ix_bei_threshold_item_unique", BeiThresholdItem.version_id, BeiThresholdItem.metric_key, unique=True)


class DivisionEvaluation(Base, TimestampMixin, AuditMixin):
    """事业部评价（季度）。"""

    __tablename__ = "division_evaluation"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    division_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    division_name: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    period: Mapped[str] = mapped_column(String(16), nullable=False, index=True)  # 2026Q4

    threshold_version_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    threshold_version_label: Mapped[str] = mapped_column(String(32), nullable=False, default="")

    status: Mapped[str] = mapped_column(String(24), nullable=False, default=EVAL_ESTIMATE, index=True)
    issue_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    sample_sufficient: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    participating_project_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # 自动分（五维）
    d1_score: Mapped[str | None] = mapped_column(String(24), nullable=True)
    d2_score: Mapped[str | None] = mapped_column(String(24), nullable=True)
    d3_score: Mapped[str | None] = mapped_column(String(24), nullable=True)
    d4_score: Mapped[str | None] = mapped_column(String(24), nullable=True)
    d5_score: Mapped[str | None] = mapped_column(String(24), nullable=True)
    active_dimensions_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    rescaled_weights_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    auto_score: Mapped[str | None] = mapped_column(String(24), nullable=True)
    auto_weight: Mapped[str] = mapped_column(String(16), nullable=False, default="0.80")
    manual_weight: Mapped[str] = mapped_column(String(16), nullable=False, default="0.20")
    combined_score: Mapped[str | None] = mapped_column(String(24), nullable=True)
    grade: Mapped[str | None] = mapped_column(String(16), nullable=True, index=True)

    finalized_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finalized_by_name: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    calc_trace_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    disclaimer: Mapped[str] = mapped_column(Text, nullable=False, default="")

    metrics: Mapped[list[BeiMetricValue]] = relationship(
        back_populates="evaluation", cascade="all, delete-orphan", lazy="selectin",
    )
    manual: Mapped[list[BeiManualScore]] = relationship(
        back_populates="evaluation", cascade="all, delete-orphan", lazy="selectin",
    )


Index("ix_division_eval_unique", DivisionEvaluation.division_id, DivisionEvaluation.period,
      DivisionEvaluation.threshold_version_id, unique=True)


class BeiMetricValue(Base, TimestampMixin):
    """二级指标原始值、归一化分与下钻依据。"""

    __tablename__ = "bei_metric_value"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    evaluation_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("division_evaluation.id", ondelete="CASCADE"), nullable=False, index=True
    )
    metric_key: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    dimension: Mapped[str] = mapped_column(String(8), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    unit: Mapped[str] = mapped_column(String(24), nullable=False, default="")
    direction: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    is_scoring: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    raw_value: Mapped[str | None] = mapped_column(String(24), nullable=True)
    normalized: Mapped[str | None] = mapped_column(String(24), nullable=True)
    has_data: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    blocks_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    drill_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")

    evaluation: Mapped[DivisionEvaluation] = relationship(back_populates="metrics")


Index("ix_bei_metric_unique", BeiMetricValue.evaluation_id, BeiMetricValue.metric_key, unique=True)


class BeiManualScore(Base, TimestampMixin):
    """人工印象分（不得改写自动指标；占比 ≤ 20%）。"""

    __tablename__ = "bei_manual_score"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    evaluation_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("division_evaluation.id", ondelete="CASCADE"), nullable=False, index=True
    )
    score: Mapped[str] = mapped_column(String(24), nullable=False)
    weight: Mapped[str] = mapped_column(String(16), nullable=False, default="0.20")
    reason: Mapped[str] = mapped_column(Text, nullable=False)          # 事由（必填）
    basis: Mapped[str] = mapped_column(Text, nullable=False)           # 依据（必填）
    entered_by: Mapped[str] = mapped_column(String(64), nullable=False)
    entered_at: Mapped[_dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    evaluation: Mapped[DivisionEvaluation] = relationship(back_populates="manual")
