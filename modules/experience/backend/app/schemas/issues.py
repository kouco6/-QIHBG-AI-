"""统一问题 / 代录 / 批量请求与响应模型（T07）。

- 请求模型只承载**客户端可决定**的字段；``proxy_by`` / ``proxy_at`` 由服务端
  会话与服务器时间生成，**不接受客户端传值**（T07 代录硬性规则）。
- 状态迁移统一使用 ``{action, reason?, expected_version?, extra?}`` 形状。
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

# --- 来源引用 ---


class IssueSourceRefIn(BaseModel):
    ref_type: str = Field(min_length=1, description="artifact / review / usability / prototype / ui")
    ref_id: str = Field(min_length=1)
    label: str = Field(default="", max_length=200)


class IssueRefRequest(BaseModel):
    ref_type: str = Field(min_length=1)
    ref_id: str = Field(min_length=1)
    label: str = Field(default="", max_length=200)


# --- 创建 / 更新 ---


class IssueCreateRequest(BaseModel):
    project_id: str = Field(min_length=1)
    description: str = Field(min_length=1, max_length=4000)
    business_level: str = Field(min_length=1)
    severity: str = Field(min_length=1)
    module: str = Field(min_length=1, max_length=120)

    division_id: str | None = None

    metric_l1: str = Field(default="", max_length=120)
    metric_l2: str = Field(default="", max_length=120)
    metric_l3: str = Field(default="", max_length=120)
    check_item_no: int | None = None
    issue_type: str = Field(default="", max_length=32)
    owner_text: str = Field(default="", max_length=64)
    note: str = Field(default="", max_length=4000)

    source_refs: list[IssueSourceRefIn] = Field(default_factory=list)


class IssueUpdateRequest(BaseModel):
    """PATCH：描述 / 等级 / 模块 / 责任人 / 指标 / 备注，以及最终分类确认。"""

    expected_version: int | None = None

    description: str | None = Field(default=None, max_length=4000)
    business_level: str | None = None
    severity: str | None = None
    module: str | None = Field(default=None, max_length=120)
    owner_text: str | None = Field(default=None, max_length=64)
    metric_l1: str | None = Field(default=None, max_length=120)
    metric_l2: str | None = Field(default=None, max_length=120)
    metric_l3: str | None = Field(default=None, max_length=120)
    issue_type: str | None = Field(default=None, max_length=32)
    check_item_no: int | None = None
    note: str | None = Field(default=None, max_length=4000)

    division_id: str | None = None

    # 评审后最终分类（人工确认，服务端写 final_classified_at）
    final_business_level: str | None = None
    final_severity: str | None = None
    confirm_final: bool = False


class IssueTransitionRequest(BaseModel):
    action: str = Field(min_length=1)
    reason: str | None = None
    expected_version: int | None = None
    extra: dict[str, Any] = Field(default_factory=dict)


# --- 过滤 / 批量 ---


class IssueFilter(BaseModel):
    project_id: str | None = None
    status: str | None = None
    business_level: str | None = None
    severity: str | None = None
    division_id: str | None = None
    module: str | None = None
    keyword: str | None = None
    metric_l1: str | None = None
    updated_from: str | None = None


class IssueBatchRequest(BaseModel):
    issue_ids: list[str] | None = None
    all_filtered: IssueFilter | None = None
    except_ids: list[str] = Field(default_factory=list)
    action: str = Field(min_length=1)
    payload: dict[str, Any] = Field(default_factory=dict)
    dry_run: bool = False


# --- 响应 ---


class IssueOut(BaseModel):
    """列表列（问题中心）。"""

    model_config = ConfigDict(extra="allow")

    id: str
    code: str
    description: str
    project_name: str = ""
    system_name: str = ""
    division_name: str = ""
    business_level: str
    severity: str
    metric_l1: str = ""
    status: str
    owner_text: str = ""
    source_labels: list[str] = Field(default_factory=list)
    updated_at: str | None = None
    updated_by_name: str = ""


class IssuePageOut(BaseModel):
    page: int
    page_size: int
    total: int
    items: list[dict[str, Any]]


class IssueTransitionActionOut(BaseModel):
    action: str
    label: str
    target: str
    requires_reason: bool
