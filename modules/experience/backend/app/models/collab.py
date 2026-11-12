"""协作空间与 AI 会话模型（T13 / PRD §13）。

- ``CollaborationThread`` / ``CollaborationMessage``：项目内协作空间，可关联产物 / 问题；
  **所有体验人员均可见全部协作空间**（单一角色，不做项目级隔离）。
- ``AiConversation`` / ``AiMessage``：AI 会话**按项目持久化**，页面刷新与服务重启后
  上下文不丢失；消息保存引用实体、Provider 模式与作业关联。
"""

from __future__ import annotations

import datetime as _dt

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models import Base, TimestampMixin

THREAD_OPEN = "open"
THREAD_CLOSED = "closed"

ROLE_USER = "user"
ROLE_ASSISTANT = "assistant"
ROLE_SYSTEM = "system"

AI_SCOPE_PROJECT = "project"
AI_SCOPE_ISSUES = "issues"
AI_SCOPE_SNAPSHOT = "snapshot"
AI_SCOPES: tuple[str, ...] = (AI_SCOPE_PROJECT, AI_SCOPE_ISSUES, AI_SCOPE_SNAPSHOT)
AI_SCOPE_LABELS: dict[str, str] = {
    AI_SCOPE_PROJECT: "整个项目",
    AI_SCOPE_ISSUES: "筛选问题集",
    AI_SCOPE_SNAPSHOT: "指定快照",
}


class CollaborationThread(Base, TimestampMixin):
    """讨论串。"""

    __tablename__ = "collaboration_thread"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("project.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=THREAD_OPEN, index=True)
    node_code: Mapped[str] = mapped_column(String(8), nullable=False, default="")
    ref_type: Mapped[str] = mapped_column(String(24), nullable=False, default="")
    ref_id: Mapped[str] = mapped_column(String(36), nullable=False, default="")
    started_by: Mapped[str] = mapped_column(String(36), nullable=False, default="")
    started_by_name: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    reply_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_reply_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    members_text: Mapped[str] = mapped_column(String(255), nullable=False, default="")

    messages: Mapped[list[CollaborationMessage]] = relationship(
        back_populates="thread", cascade="all, delete-orphan", lazy="selectin",
        order_by="CollaborationMessage.created_at",
    )


class CollaborationMessage(Base, TimestampMixin):
    """讨论消息（仅本地账号可发言；外部意见必须走代录）。"""

    __tablename__ = "collaboration_message"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    thread_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("collaboration_thread.id", ondelete="CASCADE"), nullable=False, index=True
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    ref_type: Mapped[str] = mapped_column(String(24), nullable=False, default="")
    ref_id: Mapped[str] = mapped_column(String(36), nullable=False, default="")
    ref_label: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    is_proxy: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    actual_provider: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    author_id: Mapped[str] = mapped_column(String(36), nullable=False, default="")
    author_name: Mapped[str] = mapped_column(String(64), nullable=False, default="")

    thread: Mapped[CollaborationThread] = relationship(back_populates="messages")


Index("ix_collab_message_thread", CollaborationMessage.thread_id, CollaborationMessage.created_at)


class AiConversation(Base, TimestampMixin):
    """AI 会话（按项目持久化）。"""

    __tablename__ = "ai_conversation"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("project.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    scope_type: Mapped[str] = mapped_column(String(16), nullable=False, default=AI_SCOPE_PROJECT)
    scope_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    template_key: Mapped[str] = mapped_column(String(32), nullable=False, default="summary")
    provider_kind: Mapped[str] = mapped_column(String(16), nullable=False, default="ai")
    mode: Mapped[str] = mapped_column(String(8), nullable=False, default="mock")
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    message_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_message_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    messages: Mapped[list[AiMessage]] = relationship(
        back_populates="conversation", cascade="all, delete-orphan", lazy="selectin",
        order_by="AiMessage.created_at",
    )


class AiMessage(Base, TimestampMixin):
    """AI 会话消息（含引用实体与作业关联）。"""

    __tablename__ = "ai_message"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("ai_conversation.id", ondelete="CASCADE"), nullable=False, index=True
    )
    role: Mapped[str] = mapped_column(String(16), nullable=False, default=ROLE_USER)
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    refs_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    job_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    is_mock: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    author_name: Mapped[str] = mapped_column(String(64), nullable=False, default="")

    conversation: Mapped[AiConversation] = relationship(back_populates="messages")
