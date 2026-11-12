"""统一问题实体、代录记录、流转与验收（T07）。

硬性规则（REQUIREMENTS §3.5 / PRD §7.2）：

1. **一次录入，多视图呈现**：原型报告、UI 报告、问题中心、评审工作区、测评表
   与回复终版都只保存 ``issue.id`` 引用，不复制实体；
2. **代录强制留痕**：事业部回复、承诺修改版本、部门签署意见必须挂载
   ``ProxyRecord``，缺少实际提供人时由服务端拒绝（不可关闭）；
3. **评审前分类与评审后最终分类分别保存**并可比较；
4. 已被引用的问题**禁止物理删除**，只能关闭 / 驳回 / 停用。
"""

from __future__ import annotations

import datetime as _dt

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.domain import states as st
from app.models import AuditMixin, Base, TimestampMixin
from app.models.flow import Project

# 代录目标类型
PROXY_TARGET_ISSUE_REPLY = "issue_reply"            # 事业部回复
PROXY_TARGET_ISSUE_COMMITMENT = "issue_commitment"  # 承诺修改版本
PROXY_TARGET_ISSUE_SOLUTION = "issue_solution"      # 解决方案（事业部提供）
PROXY_TARGET_REVIEW_SIGNATURE = "review_signature"  # 部门签署
PROXY_TARGET_REVIEW_OPINION = "review_opinion"      # 部门评审意见
PROXY_TARGET_ARTIFACT_SECTION = "artifact_section"  # 产物中的外部意见段落

PROXY_TARGET_TYPES: tuple[str, ...] = (
    PROXY_TARGET_ISSUE_REPLY,
    PROXY_TARGET_ISSUE_COMMITMENT,
    PROXY_TARGET_ISSUE_SOLUTION,
    PROXY_TARGET_REVIEW_SIGNATURE,
    PROXY_TARGET_REVIEW_OPINION,
    PROXY_TARGET_ARTIFACT_SECTION,
)
PROXY_TARGET_LABELS: dict[str, str] = {
    PROXY_TARGET_ISSUE_REPLY: "事业部回复",
    PROXY_TARGET_ISSUE_COMMITMENT: "承诺修改版本",
    PROXY_TARGET_ISSUE_SOLUTION: "解决方案",
    PROXY_TARGET_REVIEW_SIGNATURE: "部门签署",
    PROXY_TARGET_REVIEW_OPINION: "部门评审意见",
    PROXY_TARGET_ARTIFACT_SECTION: "外部意见段落",
}

# 问题来源
ISSUE_SOURCE_MANUAL = "manual"
ISSUE_SOURCE_ARTIFACT = "artifact"
ISSUE_SOURCE_REVIEW = "review"
ISSUE_SOURCE_SEED = "seed"


class Issue(Base, TimestampMixin, AuditMixin):
    """统一问题实体（全系统唯一一份）。"""

    __tablename__ = "issue"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    # 稳定问题编号（人可读、跨模块引用）
    code: Mapped[str] = mapped_column(String(32), nullable=False, unique=True, index=True)

    project_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("project.id", ondelete="CASCADE"), nullable=False, index=True
    )
    system_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    division_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    module: Mapped[str] = mapped_column(String(120), nullable=False, default="", index=True)

    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    business_level: Mapped[str] = mapped_column(String(20), nullable=False, default="core", index=True)
    severity: Mapped[str] = mapped_column(String(20), nullable=False, default="normal", index=True)
    metric_l1: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    metric_l2: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    metric_l3: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    check_item_no: Mapped[int | None] = mapped_column(Integer, nullable=True)
    issue_type: Mapped[str] = mapped_column(String(32), nullable=False, default="", index=True)

    owner_text: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    status: Mapped[str] = mapped_column(String(24), nullable=False, default=st.ISSUE_DRAFT, index=True)

    # 评审前分类（初分）与评审后最终分类分别保存（PRD §7.2 硬性规则 3）
    pre_business_level: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    pre_severity: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    final_business_level: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    final_severity: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    final_classified_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    final_classified_by: Mapped[str] = mapped_column(String(64), nullable=False, default="")

    # 事业部处理（代录内容，必须挂 ProxyRecord）
    division_reply: Mapped[str] = mapped_column(Text, nullable=False, default="")
    solution: Mapped[str] = mapped_column(Text, nullable=False, default="")
    committed_version: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    actual_version: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    first_replied_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # 来源引用（JSON 数组，允许同一问题被多份产物引用）
    source_refs_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    note: Mapped[str] = mapped_column(Text, nullable=False, default="")

    # 被引用计数（禁止物理删除的依据；由服务层维护）
    reference_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_proxy: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    project: Mapped[Project] = relationship(lazy="joined")
    transitions: Mapped[list[IssueTransition]] = relationship(
        back_populates="issue", cascade="all, delete-orphan", lazy="selectin",
        order_by="IssueTransition.created_at",
    )
    proxies: Mapped[list[ProxyRecord]] = relationship(
        back_populates="issue", cascade="all, delete-orphan", lazy="selectin",
        order_by="ProxyRecord.created_at",
    )
    acceptances: Mapped[list[IssueAcceptance]] = relationship(
        back_populates="issue", cascade="all, delete-orphan", lazy="selectin",
        order_by="IssueAcceptance.created_at",
    )


Index("ix_issue_project_status", Issue.project_id, Issue.status)


class IssueTransition(Base, TimestampMixin):
    """问题状态迁移历史。"""

    __tablename__ = "issue_transition"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    issue_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("issue.id", ondelete="CASCADE"), nullable=False, index=True
    )
    action: Mapped[str] = mapped_column(String(32), nullable=False)
    from_status: Mapped[str] = mapped_column(String(24), nullable=False, default="")
    to_status: Mapped[str] = mapped_column(String(24), nullable=False, default="")
    reason: Mapped[str] = mapped_column(Text, nullable=False, default="")
    detail_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    actor_account_id: Mapped[str] = mapped_column(String(36), nullable=False, default="")
    actor_name: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    request_id: Mapped[str] = mapped_column(String(64), nullable=False, default="")

    issue: Mapped[Issue] = relationship(back_populates="transitions")


class ProxyRecord(Base, TimestampMixin):
    """代录记录（跨实体通用）。

    ``actual_provider``（实际提供人）为 **必填**；``proxy_by``（代录人）与
    ``proxy_at``（代录时间）由服务端从会话与服务器时间生成，客户端不可覆盖。
    """

    __tablename__ = "proxy_record"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    target_type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    target_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    field_key: Mapped[str] = mapped_column(String(64), nullable=False, default="")

    issue_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("issue.id", ondelete="CASCADE"), nullable=True, index=True
    )

    actual_provider: Mapped[str] = mapped_column(String(64), nullable=False)
    provider_department: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    proxy_by: Mapped[str] = mapped_column(String(36), nullable=False)
    proxy_by_name: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    proxy_at: Mapped[_dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    source_note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    content_digest: Mapped[str] = mapped_column(Text, nullable=False, default="")

    issue: Mapped[Issue | None] = relationship(back_populates="proxies")


Index("ix_proxy_record_target", ProxyRecord.target_type, ProxyRecord.target_id)


class IssueAcceptance(Base, TimestampMixin):
    """问题复测验收记录。"""

    __tablename__ = "issue_acceptance"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    issue_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("issue.id", ondelete="CASCADE"), nullable=False, index=True
    )
    result: Mapped[str] = mapped_column(String(20), nullable=False)  # accepted / rejected
    evidence: Mapped[str] = mapped_column(Text, nullable=False, default="")
    reason: Mapped[str] = mapped_column(Text, nullable=False, default="")
    tested_version: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    actor_account_id: Mapped[str] = mapped_column(String(36), nullable=False, default="")
    actor_name: Mapped[str] = mapped_column(String(64), nullable=False, default="")

    issue: Mapped[Issue] = relationship(back_populates="acceptances")


class IssueEvidence(Base, TimestampMixin):
    """问题证据（附件元数据 / 说明）。"""

    __tablename__ = "issue_evidence"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    issue_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("issue.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(String(32), nullable=False, default="note")
    file_name: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    mime_type: Mapped[str] = mapped_column(String(128), nullable=False, default="")
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    uri: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_by_name: Mapped[str] = mapped_column(String(64), nullable=False, default="")
