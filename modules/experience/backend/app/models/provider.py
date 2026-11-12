"""Provider 作业与回执模型（T13）。

- ``ProviderConfig``：**只保存是否配置、模式与非敏感端点标识**，密钥不入库。
- ``ProviderJob``：统一作业生命周期 ``queued → running → succeeded/failed/cancelled``，
  幂等键唯一，``retry_of`` 关联原作业。
- ``ProviderReceipt``：回执（Mock 回执 ID 使用 ``mock_`` 前缀，不得伪装成真实同步成功）。
"""

from __future__ import annotations

import datetime as _dt

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.domain import states as st
from app.models import Base, TimestampMixin

PROVIDER_FEISHU = "feishu"
PROVIDER_AI = "ai"
PROVIDER_WORKBUDDY = "workbuddy"
PROVIDER_KINDS: tuple[str, ...] = (PROVIDER_FEISHU, PROVIDER_AI, PROVIDER_WORKBUDDY)
PROVIDER_LABELS: dict[str, str] = {
    PROVIDER_FEISHU: "飞书项目管理",
    PROVIDER_AI: "AI 大模型",
    PROVIDER_WORKBUDDY: "WorkBuddy",
}

MODE_MOCK = "mock"
MODE_REAL = "real"

JOB_TYPE_ISSUE_SYNC = "issue_sync"
JOB_TYPE_AI_ANALYSIS = "ai_analysis"
JOB_TYPE_WORKBUDDY_SUBMIT = "workbuddy_submit"
JOB_TYPES: tuple[str, ...] = (JOB_TYPE_ISSUE_SYNC, JOB_TYPE_AI_ANALYSIS, JOB_TYPE_WORKBUDDY_SUBMIT)
JOB_TYPE_LABELS: dict[str, str] = {
    JOB_TYPE_ISSUE_SYNC: "问题同步飞书",
    JOB_TYPE_AI_ANALYSIS: "AI 汇总分析",
    JOB_TYPE_WORKBUDDY_SUBMIT: "WorkBuddy 提交",
}

MOCK_RECEIPT_PREFIX = "mock_"


class ProviderConfig(Base, TimestampMixin):
    """Provider 非敏感配置状态（密钥只从环境变量读取，不回显）。"""

    __tablename__ = "provider_config"

    kind: Mapped[str] = mapped_column(String(16), primary_key=True)
    configured: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    configured_mode: Mapped[str] = mapped_column(String(8), nullable=False, default=MODE_MOCK)
    effective_mode: Mapped[str] = mapped_column(String(8), nullable=False, default=MODE_MOCK)
    endpoint_label: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    last_tested_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_test_result: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    capability_note: Mapped[str] = mapped_column(Text, nullable=False, default="")


class ProviderJob(Base, TimestampMixin):
    """统一作业。"""

    __tablename__ = "provider_job"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    provider_kind: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    job_type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    mode: Mapped[str] = mapped_column(String(8), nullable=False, default=MODE_MOCK, index=True)
    idempotency_key: Mapped[str] = mapped_column(String(160), nullable=False, unique=True, index=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=st.JOB_QUEUED, index=True)

    target_type: Mapped[str] = mapped_column(String(32), nullable=False, default="")
    target_id: Mapped[str] = mapped_column(String(36), nullable=False, default="", index=True)
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    payload_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")

    progress: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_retries: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    retry_of: Mapped[str | None] = mapped_column(String(36), nullable=True)
    failure_reason: Mapped[str] = mapped_column(Text, nullable=False, default="")

    started_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[str] = mapped_column(String(36), nullable=False, default="")
    created_by_name: Mapped[str] = mapped_column(String(64), nullable=False, default="")

    receipt: Mapped[ProviderReceipt | None] = relationship(
        back_populates="job", cascade="all, delete-orphan", lazy="selectin", uselist=False,
    )


class ProviderReceipt(Base, TimestampMixin):
    """回执（Mock 标识必须可见）。"""

    __tablename__ = "provider_receipt"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    job_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("provider_job.id", ondelete="CASCADE"), nullable=False, index=True
    )
    external_id: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    is_mock: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    code: Mapped[str] = mapped_column(String(32), nullable=False, default="ok")
    message: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    body_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    received_at: Mapped[_dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    job: Mapped[ProviderJob] = relationship(back_populates="receipt")


Index("ix_provider_receipt_job", ProviderReceipt.job_id, ProviderReceipt.received_at)
