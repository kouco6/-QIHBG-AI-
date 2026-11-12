"""Provider / 协作空间 / AI 会话请求模型（T13 / PRD §12、§13）。"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class IssueSyncRequest(BaseModel):
    """问题一键同步（Mock）请求。"""

    issue_ids: list[str] = Field(min_length=1, max_length=200)


class ThreadCreateRequest(BaseModel):
    """发起讨论。"""

    project_id: str = Field(min_length=1)
    title: str = Field(min_length=1, max_length=200)
    node_code: str | None = Field(default=None, max_length=8)
    ref_type: str | None = Field(default="", max_length=24)
    ref_id: str | None = Field(default="", max_length=36)
    members_text: str | None = Field(default="", max_length=255)


class MessageCreateRequest(BaseModel):
    """讨论回复（``body`` 的业务校验在服务层：空白 / 超长 / 代录）。"""

    body: str = Field(default="")
    ref_type: str | None = Field(default="", max_length=24)
    ref_id: str | None = Field(default="", max_length=36)
    ref_label: str | None = Field(default="", max_length=200)
    is_proxy: bool = False
    actual_provider: str | None = Field(default="", max_length=64)


class ConversationCreateRequest(BaseModel):
    """新建 AI 会话（``scope`` 中的实体 ID 必须属于该项目）。"""

    project_id: str = Field(min_length=1)
    title: str = Field(default="", max_length=200)
    scope_type: str = Field(default="project")
    scope: dict[str, Any] = Field(default_factory=dict)
    template_key: str | None = Field(default=None, max_length=32)


class AiMessageCreateRequest(BaseModel):
    """AI 会话消息。"""

    content: str = Field(default="")
