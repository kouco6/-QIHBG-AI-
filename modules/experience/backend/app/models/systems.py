"""系统（原产品线）与系统合并 UEI 快照模型（v1.1 层级合并）。

层级：事业部 → **系统** → 产品项目（project 直接挂系统，产品/产品版本层已取消）。
注意：``models/system.py`` 是系统级配置（SystemSetting），与本文件无关。

- ``System``：系统，**绑定一个评分方案版本**（系统方案权威）。
- ``SystemSnapshot``：不可变系统级快照，保存**筛选条件、来源 L1 快照集合、
  去重集合与结果**（权威并集重算 / 权重加权平均 / 木桶分三个口径并列）。
  其中「权重加权平均」= Σ(项目 UEI × 项目权重) / Σ权重，权重在 project.weight 上可配。
- ``SystemSnapshotSource``：来源 L1 快照清单（含「口径外」标记）。
"""

from __future__ import annotations

import datetime as _dt

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models import AuditMixin, Base, TimestampMixin

SYSTEM_ACTIVE = "active"
SYSTEM_ARCHIVED = "archived"

# 来源纳入口径
SELECTION_LATEST = "latest"      # 每个项目最新有效快照（默认）
SELECTION_WINDOW = "window"      # 时间窗口
SELECTION_VERSION = "version"    # 版本区间

SELECTION_MODES: tuple[str, ...] = (SELECTION_LATEST, SELECTION_WINDOW, SELECTION_VERSION)
SELECTION_LABELS: dict[str, str] = {
    SELECTION_LATEST: "最新有效快照",
    SELECTION_WINDOW: "时间窗口",
    SELECTION_VERSION: "版本区间",
}


class System(Base, TimestampMixin, AuditMixin):
    """系统（产品项目的分组单位，可绑定评分方案）。"""

    __tablename__ = "system"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    code: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False, index=True)
    owner_text: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    division_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    scheme_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    scheme_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=SYSTEM_ACTIVE, index=True)
    note: Mapped[str] = mapped_column(Text, nullable=False, default="")


class SystemSnapshot(Base, TimestampMixin):
    """不可变系统级快照（并集重算 + 权重加权）。"""

    __tablename__ = "system_snapshot"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    system_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    system_code: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    system_name: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    division_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)

    scheme_id: Mapped[str] = mapped_column(String(36), nullable=False)
    scheme_code: Mapped[str] = mapped_column(String(32), nullable=False, default="")

    selection_mode: Mapped[str] = mapped_column(String(16), nullable=False, default=SELECTION_LATEST)
    filters_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")

    source_snapshot_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    effective_project_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    outlier_project_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    raw_issue_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    deduped_issue_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    core_deduction: Mapped[str] = mapped_column(String(24), nullable=False, default="0")
    non_core_deduction: Mapped[str] = mapped_column(String(24), nullable=False, default="0")
    total_deduction: Mapped[str] = mapped_column(String(24), nullable=False, default="0")
    authoritative_uei: Mapped[str] = mapped_column(String(24), nullable=False, default="100")
    weighted_average_uei: Mapped[str] = mapped_column(String(24), nullable=False, default="")
    bucket_uei: Mapped[str] = mapped_column(String(24), nullable=False, default="")
    sample_sufficient: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    severity_counts_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    project_scores_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    calc_trace_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")

    created_by: Mapped[str] = mapped_column(String(36), nullable=False, default="")
    created_by_name: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    snapshot_at: Mapped[_dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)

    sources: Mapped[list[SystemSnapshotSource]] = relationship(
        back_populates="snapshot", cascade="all, delete-orphan", lazy="selectin",
    )


class SystemSnapshotSource(Base, TimestampMixin):
    """系统快照来源：纳入的项目 L1 快照与是否「口径外」。"""

    __tablename__ = "system_snapshot_source"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    snapshot_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("system_snapshot.id", ondelete="CASCADE"), nullable=False, index=True
    )
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    project_name: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    version_code: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    weight: Mapped[str] = mapped_column(String(16), nullable=False, default="1")
    l1_snapshot_id: Mapped[str] = mapped_column(String(36), nullable=False)
    l1_scheme_code: Mapped[str] = mapped_column(String(32), nullable=False, default="")
    l1_uei: Mapped[str] = mapped_column(String(24), nullable=False, default="")
    is_out_of_scope: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    issue_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    snapshot: Mapped[SystemSnapshot] = relationship(back_populates="sources")
