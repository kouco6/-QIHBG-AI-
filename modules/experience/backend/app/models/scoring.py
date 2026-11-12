"""UEI 评分模型：方案、矩阵单元、L1 项目快照与快照明细（T08 / v1.1）。

v1.1：L1 快照从「单产品」改为「单产品项目」（product 层已取消）。

快照表**只允许创建与读取** —— 不提供更新/删除接口（DESIGN §7-1）。
快照保存**原始输入、方案版本、问题集合、逐问题命中的矩阵单元、逐问题扣分、
分类汇总、总扣分、原始数学 UEI 与显示 UEI**，使其不依赖当前可变数据即可解释。
"""

from __future__ import annotations

import datetime as _dt

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models import AuditMixin, Base, TimestampMixin

SNAPSHOT_SCOPE_PROJECT = "project"          # L1
SNAPSHOT_SCOPE_SYSTEM = "system"            # L2


class ScoringScheme(Base, TimestampMixin, AuditMixin):
    """评分方案版本（20 套默认方案 + 可版本化的新方案）。"""

    __tablename__ = "scoring_scheme"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    code: Mapped[str] = mapped_column(String(32), nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    business_ratio: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    problem_ratio: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    scheme_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)
    is_builtin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    note: Mapped[str] = mapped_column(Text, nullable=False, default="")

    cells: Mapped[list[ScoringSchemeCell]] = relationship(
        back_populates="scheme", cascade="all, delete-orphan", lazy="selectin",
        order_by="ScoringSchemeCell.cell_order",
    )


class ScoringSchemeCell(Base, TimestampMixin):
    """矩阵单元（每个方案 8 个）。"""

    __tablename__ = "scoring_scheme_cell"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scheme_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("scoring_scheme.id", ondelete="CASCADE"), nullable=False, index=True
    )
    cell_key: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    business_level: Mapped[str] = mapped_column(String(20), nullable=False)
    severity: Mapped[str] = mapped_column(String(20), nullable=False)
    cell_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    deduction: Mapped[str] = mapped_column(String(16), nullable=False)  # 十进制字符串

    scheme: Mapped[ScoringScheme] = relationship(back_populates="cells")


Index("ix_scoring_cell_unique", ScoringSchemeCell.scheme_id, ScoringSchemeCell.cell_key, unique=True)


class ProjectScoreSnapshot(Base, TimestampMixin):
    """不可变评分快照（L1 单个产品项目）。"""

    __tablename__ = "project_score_snapshot"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scope: Mapped[str] = mapped_column(String(20), nullable=False, default=SNAPSHOT_SCOPE_PROJECT, index=True)
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    project_name: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    version_code: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    division_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)

    scheme_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    scheme_code: Mapped[str] = mapped_column(String(32), nullable=False, default="")
    scheme_business_ratio: Mapped[str] = mapped_column(String(16), nullable=False, default="")
    scheme_problem_ratio: Mapped[str] = mapped_column(String(32), nullable=False, default="")

    issue_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    core_issue_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    non_core_issue_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    severity_counts_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")

    core_deduction: Mapped[str] = mapped_column(String(24), nullable=False, default="0")
    non_core_deduction: Mapped[str] = mapped_column(String(24), nullable=False, default="0")
    total_deduction: Mapped[str] = mapped_column(String(24), nullable=False, default="0")
    raw_uei: Mapped[str] = mapped_column(String(24), nullable=False, default="100")
    display_uei: Mapped[str] = mapped_column(String(24), nullable=False, default="100")
    clamp_zero: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_effective: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)

    input_manifest_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    calc_trace_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")

    created_by: Mapped[str] = mapped_column(String(36), nullable=False, default="")
    created_by_name: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    snapshot_at: Mapped[_dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)

    issues: Mapped[list[SnapshotIssue]] = relationship(
        back_populates="snapshot", cascade="all, delete-orphan", lazy="selectin",
        order_by="SnapshotIssue.issue_code",
    )


class SnapshotIssue(Base, TimestampMixin):
    """快照明细：逐问题命中的矩阵单元与扣分（可解释链）。"""

    __tablename__ = "snapshot_issue"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    snapshot_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("project_score_snapshot.id", ondelete="CASCADE"), nullable=False, index=True
    )
    issue_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    issue_code: Mapped[str] = mapped_column(String(32), nullable=False, default="")
    business_level: Mapped[str] = mapped_column(String(20), nullable=False)
    severity: Mapped[str] = mapped_column(String(20), nullable=False)
    cell_key: Mapped[str] = mapped_column(String(32), nullable=False)
    deduction: Mapped[str] = mapped_column(String(16), nullable=False)
    module: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    metric_l1: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    metric_l2: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    description_digest: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    source_snapshot_id: Mapped[str | None] = mapped_column(String(36), nullable=True)

    snapshot: Mapped[ProjectScoreSnapshot] = relationship(back_populates="issues")


Index("ix_snapshot_issue_unique", SnapshotIssue.snapshot_id, SnapshotIssue.issue_id, unique=True)
