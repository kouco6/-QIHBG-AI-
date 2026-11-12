"""发布体验评审（N13）三段式模型（T07）。

- ``Review``：评审主体，阶段 ``before → during → after → archived``。
- ``ReviewDecision``：逐项争议的讨论、决策与承诺版本（评审中）。
- ``ReviewSignature``：部门签署记录（**代录**），必须关联实际提供人。
"""

from __future__ import annotations

import datetime as _dt

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.domain import states as st
from app.models import AuditMixin, Base, TimestampMixin

DECISION_STATUS_OPEN = "open"
DECISION_STATUS_DECIDED = "decided"
DECISION_STATUS_DEFERRED = "deferred"
DECISION_STATUSES: tuple[str, ...] = (DECISION_STATUS_OPEN, DECISION_STATUS_DECIDED, DECISION_STATUS_DEFERRED)
DECISION_STATUS_LABELS: dict[str, str] = {
    DECISION_STATUS_OPEN: "未决",
    DECISION_STATUS_DECIDED: "已决策",
    DECISION_STATUS_DEFERRED: "明确待办",
}


class Review(Base, TimestampMixin, AuditMixin):
    """评审主体（N13 发布体验评审 / N04 / N05 场景评审共用）。"""

    __tablename__ = "review"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    code: Mapped[str] = mapped_column(String(32), nullable=False, unique=True, index=True)
    project_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("project.id", ondelete="CASCADE"), nullable=False, index=True
    )
    node_code: Mapped[str] = mapped_column(String(8), nullable=False, default="N13", index=True)
    review_kind: Mapped[str] = mapped_column(String(24), nullable=False, default="release", index=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    stage: Mapped[str] = mapped_column(String(16), nullable=False, default=st.REVIEW_BEFORE, index=True)

    # 评审前：范围锁定与初算
    scope_locked_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    preliminary_snapshot_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    preliminary_uei: Mapped[str] = mapped_column(String(16), nullable=False, default="")

    # 评审后：最终复算与归档
    final_snapshot_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    final_uei: Mapped[str] = mapped_column(String(16), nullable=False, default="")
    archived_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    archive_confirm_text: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    conclusion: Mapped[str] = mapped_column(Text, nullable=False, default="")

    decisions: Mapped[list[ReviewDecision]] = relationship(
        back_populates="review", cascade="all, delete-orphan", lazy="selectin",
        order_by="ReviewDecision.created_at",
    )
    signatures: Mapped[list[ReviewSignature]] = relationship(
        back_populates="review", cascade="all, delete-orphan", lazy="selectin",
        order_by="ReviewSignature.created_at",
    )


class ReviewDecision(Base, TimestampMixin):
    """争议问题的讨论与决策（评审中）。"""

    __tablename__ = "review_decision"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    review_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("review.id", ondelete="CASCADE"), nullable=False, index=True
    )
    issue_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    issue_code: Mapped[str] = mapped_column(String(32), nullable=False, default="")

    status: Mapped[str] = mapped_column(String(16), nullable=False, default=DECISION_STATUS_OPEN, index=True)
    dispute: Mapped[str] = mapped_column(Text, nullable=False, default="")
    discussion: Mapped[str] = mapped_column(Text, nullable=False, default="")
    decision: Mapped[str] = mapped_column(Text, nullable=False, default="")
    solution: Mapped[str] = mapped_column(Text, nullable=False, default="")
    committed_version: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    owner_text: Mapped[str] = mapped_column(String(64), nullable=False, default="")

    business_level_after: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    severity_after: Mapped[str] = mapped_column(String(20), nullable=False, default="")

    created_by_name: Mapped[str] = mapped_column(String(64), nullable=False, default="")

    review: Mapped[Review] = relationship(back_populates="decisions")


Index("ix_review_decision_review_status", ReviewDecision.review_id, ReviewDecision.status)


class ReviewSignature(Base, TimestampMixin):
    """部门签署记录（代录内容）。"""

    __tablename__ = "review_signature"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    review_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("review.id", ondelete="CASCADE"), nullable=False, index=True
    )
    department: Mapped[str] = mapped_column(String(64), nullable=False)
    principal: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    members: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    opinion: Mapped[str] = mapped_column(Text, nullable=False, default="")
    is_approved: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # 代录强制字段
    is_proxy: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    actual_provider: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    proxy_by: Mapped[str] = mapped_column(String(36), nullable=False, default="")
    proxy_by_name: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    proxy_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    review: Mapped[Review] = relationship(back_populates="signatures")


Index("ix_review_signature_unique", ReviewSignature.review_id, ReviewSignature.department, unique=True)
