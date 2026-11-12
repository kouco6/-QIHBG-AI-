"""发布体验评审（N13 三段式）请求与响应模型（T07）。"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

REVIEW_KINDS: tuple[str, ...] = ("release", "internal_scenario", "external_scenario")
REVIEW_KIND_LABELS: dict[str, str] = {
    "release": "发布体验评审",
    "internal_scenario": "内部业务场景评审",
    "external_scenario": "外部业务场景评审",
}

NODE_CODE_DEFAULT = "N13"


class ReviewCreateRequest(BaseModel):
    project_id: str = Field(min_length=1)
    review_kind: str = Field(min_length=1)
    title: str = Field(min_length=1, max_length=200)
    node_code: str | None = None


class ReviewTransitionRequest(BaseModel):
    action: str = Field(min_length=1)
    reason: str | None = None
    # 归档必须精确等于评审标题
    confirm_text: str | None = None
    # summary_ready：范围锁定
    scope: dict[str, Any] | None = None
    # l1_snapshot_ready：必须指向已存在的不可变 L1 快照
    snapshot_id: str | None = None


class ReviewDecisionCreateRequest(BaseModel):
    dispute: str = Field(min_length=1, max_length=4000)
    issue_id: str | None = None
    discussion: str = Field(default="", max_length=4000)
    decision: str = Field(default="", max_length=4000)
    solution: str = Field(default="", max_length=4000)
    committed_version: str = Field(default="", max_length=64)
    owner_text: str = Field(default="", max_length=64)
    business_level_after: str = Field(default="")
    severity_after: str = Field(default="")
    status: str = Field(default="open")


class ReviewDecisionUpdateRequest(BaseModel):
    discussion: str | None = Field(default=None, max_length=4000)
    decision: str | None = Field(default=None, max_length=4000)
    solution: str | None = Field(default=None, max_length=4000)
    committed_version: str | None = Field(default=None, max_length=64)
    owner_text: str | None = Field(default=None, max_length=64)
    business_level_after: str | None = None
    severity_after: str | None = None
    status: str | None = None


class ReviewSignatureRequest(BaseModel):
    """部门签署（代录）：``actual_provider`` 必填，proxy_by/proxy_at 由服务端生成。"""

    department: str = Field(min_length=1, max_length=64)
    principal: str = Field(default="", max_length=64)
    members: str = Field(default="", max_length=255)
    opinion: str = Field(default="", max_length=4000)
    is_approved: bool = False
    actual_provider: str = Field(default="", max_length=64)


class ReviewPageOut(BaseModel):
    page: int
    page_size: int
    total: int
    items: list[dict[str, Any]]
