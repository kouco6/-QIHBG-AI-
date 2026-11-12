"""项目域请求 / 响应模型（T04）。

- 请求模型负责**结构性校验**（必填、长度、枚举）；跨字段与业务规则在
  ``app.services.flow`` 中二次校验，统一抛 :class:`app.core.errors.ValidationError`（422）。
- 响应模型只做字段收敛与类型声明，时间统一由服务层格式化为带 ``Z`` 的字符串。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

EntityStatus = Literal["active", "archived"]
ProjectStatus = Literal["active", "archived", "closed"]


# --------------------------------------------------------------------------- 分页


class PageOut(BaseModel):
    """分页响应外壳。"""

    page: int
    page_size: int
    total: int


# --------------------------------------------------------------------------- 事业部


class DivisionCreate(BaseModel):
    code: str = Field(min_length=1, max_length=64, description="事业部编码（唯一）")
    name: str = Field(min_length=1, max_length=120)
    owner_text: str = Field(default="", max_length=64, description="负责人（文本，非账号）")
    note: str = Field(default="", max_length=2000)


class DivisionUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    owner_text: str | None = Field(default=None, max_length=64)
    note: str | None = Field(default=None, max_length=2000)
    status: EntityStatus | None = None


class DivisionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    code: str
    name: str
    owner_text: str
    status: str
    status_label: str
    note: str
    system_count: int = 0
    created_at: str | None = None
    updated_at: str | None = None
    updated_by_name: str = ""


class DivisionListOut(PageOut):
    items: list[DivisionOut]


# --------------------------------------------------------------------------- 产品


# --------------------------------------------------------------------------- 项目


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    system_id: str = Field(min_length=1, description="所属系统")
    project_type: Literal["new_product", "iteration"]
    version_code: str = Field(min_length=1, max_length=64, description="项目版本号")
    division_id: str | None = None
    weight: str = Field(default="1", max_length=16, description="系统合并 UEI 权重，正数")
    owner_text: str = Field(default="", max_length=64)
    members_text: str = Field(default="", max_length=2000)
    description: str = Field(default="", max_length=4000)


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    owner_text: str | None = Field(default=None, max_length=64)
    members_text: str | None = Field(default=None, max_length=2000)
    description: str | None = Field(default=None, max_length=4000)
    status: ProjectStatus | None = None
    system_id: str | None = None
    version_code: str | None = Field(default=None, max_length=64)
    weight: str | None = Field(default=None, max_length=16)
    expected_version: int | None = Field(default=None, description="乐观锁：期望的 row_version")


class ArchiveRequest(BaseModel):
    reason: str | None = Field(default=None, max_length=2000, description="归档 / 停用原因（可选）")


class ProjectListItemOut(BaseModel):
    id: str
    code: str
    name: str
    system_id: str = ""
    system_name: str = ""
    version_code: str = ""
    project_type: str
    project_type_label: str = ""
    owner_text: str = ""
    division_name: str = ""
    current_node_code: str = ""
    current_node_name: str = ""
    status: str
    status_label: str = ""
    updated_by_name: str = ""
    updated_at: str | None = None


class ProjectListOut(PageOut):
    items: list[ProjectListItemOut]


class AuditEntryOut(BaseModel):
    action: str
    target_type: str
    target_id: str
    summary: str
    actor_name: str
    created_at: str | None = None


class SystemRefOut(BaseModel):
    id: str
    code: str
    name: str
    owner_text: str = ""
    scheme_id: str = ""
    weight: str = "1"


class ProjectNodeSummaryOut(BaseModel):
    id: str
    code: str
    node_order: int
    stage_code: str
    name: str
    status: str
    status_label: str
    applicable: bool


class ProjectDetailOut(BaseModel):
    id: str
    code: str
    name: str
    system_id: str = ""
    system_name: str = ""
    version_code: str = ""
    weight: str = "1"
    division_id: str | None = None
    division_name: str = ""
    project_type: str
    project_type_label: str = ""
    owner_text: str = ""
    members_text: str = ""
    description: str = ""
    status: str
    status_label: str = ""
    core_business_involved: bool | None = None
    core_business_reason: str = ""
    core_business_confirmed_at: str | None = None
    row_version: int = 1
    created_at: str | None = None
    updated_at: str | None = None
    created_by_name: str = ""
    updated_by_name: str = ""
    nodes: list[ProjectNodeSummaryOut] = Field(default_factory=list)
    system: SystemRefOut | None = None
    audit_timeline: list[AuditEntryOut] = Field(default_factory=list)


# --------------------------------------------------------------------------- 节点


class AllowedActionOut(BaseModel):
    action: str
    label: str
    target: str
    target_label: str = ""
    requires_reason: bool = False


class ArtifactRefOut(BaseModel):
    artifact_id: str | None = None
    kind: str
    template_name: str = ""
    status: str
    status_label: str = ""


class NodeOut(BaseModel):
    id: str
    project_id: str
    code: str
    node_order: int
    stage_code: str
    stage_name: str = ""
    name: str
    scope: str = ""
    owner: str = ""
    collaborators: str = ""
    duration_days: int = 0
    outputs: str = ""
    status: str
    status_label: str
    allow_not_applicable: bool = False
    iteration_only: bool = False
    applicable: bool = True
    planned_start_at: str | None = None
    planned_end_at: str | None = None
    actual_start_at: str | None = None
    actual_end_at: str | None = None
    not_applicable_reason: str = ""
    note: str = ""
    blocked_reason: str = ""
    artifact_summary: list[ArtifactRefOut] = Field(default_factory=list)
    artifact_count: int = 0
    allowed_actions: list[AllowedActionOut] = Field(default_factory=list)


class NodeListOut(BaseModel):
    project_id: str
    total: int
    items: list[NodeOut]


class StageSpecOut(BaseModel):
    code: str
    name: str
    order: int


class NodeSpecOut(BaseModel):
    code: str
    order: int
    stage_code: str
    stage_name: str
    name: str
    scope: str
    owner: str
    collaborators: str
    duration_days: int
    outputs: str
    artifact_kinds: list[str]
    upstream_deps: list[str]
    allow_not_applicable: bool
    iteration_only: bool
    review_gated: bool


class NodeSpecsOut(BaseModel):
    stages: list[StageSpecOut]
    nodes: list[NodeSpecOut]
    project_types: list[dict[str, str]]


class NodeBoardCardOut(BaseModel):
    id: str
    code: str
    node_order: int
    stage_code: str
    stage_name: str
    name: str
    status: str
    status_label: str
    duration_days: int
    outputs: str
    allow_not_applicable: bool
    applicable: bool
    blocking: bool = False
    blocked_reason: str = ""
    artifact_summary: list[ArtifactRefOut] = Field(default_factory=list)
    artifact_count: int = 0
    allowed_actions: list[AllowedActionOut] = Field(default_factory=list)


class BoardStageOut(BaseModel):
    code: str
    name: str
    order: int
    nodes: list[NodeBoardCardOut] = Field(default_factory=list)


class BoardProjectOut(BaseModel):
    id: str
    code: str
    name: str
    project_type: str
    project_type_label: str = ""
    system_name: str = ""
    version_code: str = ""
    division_name: str = ""
    status: str


class BoardOut(BaseModel):
    project: BoardProjectOut
    stages: list[BoardStageOut]


class NodeInputOut(BaseModel):
    code: str
    name: str
    status: str
    status_label: str
    applicable: bool


class NodeArtifactOut(BaseModel):
    id: str
    kind: str
    template_name: str = ""
    title: str = ""
    status: str
    status_label: str = ""


class NodeHistoryOut(BaseModel):
    action: str
    action_label: str = ""
    from_status: str
    to_status: str
    reason: str = ""
    actor_name: str = ""
    created_at: str | None = None


class NodeDetailOut(NodeOut):
    scene_explanation: dict[str, object] = Field(default_factory=dict)
    inputs: list[NodeInputOut] = Field(default_factory=list)
    steps: list[str] = Field(default_factory=list)
    artifacts: list[NodeArtifactOut] = Field(default_factory=list)
    issue_stats: dict[str, object] = Field(default_factory=dict)
    completion_conditions: list[str] = Field(default_factory=list)
    history: list[NodeHistoryOut] = Field(default_factory=list)
    downstream_stale: list[dict[str, str]] = Field(default_factory=list)


class TransitionRequest(BaseModel):
    """节点迁移请求。

    正常调用只传 ``action``（如 ``start`` / ``complete`` / ``mark_na`` / ``reopen``）；
    同时支持直接传 ``target``（目标状态），便于前端与测试表达「未开始 → 已完成」
    这类**未在状态机中声明**的迁移，从而得到含 ``current`` / ``target`` 的 409。
    """

    action: str | None = Field(default=None, max_length=32)
    target: str | None = Field(default=None, max_length=20)
    reason: str | None = Field(default=None, max_length=2000)
    expected_version: int | None = None

    @model_validator(mode="after")
    def _require_action_or_target(self) -> "TransitionRequest":
        if not self.action and not self.target:
            raise ValueError("必须提供 action 或 target")
        return self


class CoreBusinessRequest(BaseModel):
    involved: bool
    reason: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def _require_reason(self) -> "CoreBusinessRequest":
        if not self.reason.strip():
            raise ValueError("核心业务判定理由不能为空")
        return self


class CoreBusinessConfirmRequest(BaseModel):
    note: str = Field(default="", max_length=2000)


class MessageOut(BaseModel):
    message: str


__all__ = [
    "AllowedActionOut",
    "ArchiveRequest",
    "ArtifactRefOut",
    "AuditEntryOut",
    "BoardOut",
    "BoardProjectOut",
    "BoardStageOut",
    "CoreBusinessConfirmRequest",
    "CoreBusinessRequest",
    "DivisionCreate",
    "DivisionListOut",
    "DivisionOut",
    "DivisionUpdate",
    "MessageOut",
    "NodeArtifactOut",
    "NodeBoardCardOut",
    "NodeDetailOut",
    "NodeHistoryOut",
    "NodeInputOut",
    "NodeListOut",
    "NodeOut",
    "NodeSpecOut",
    "NodeSpecsOut",
    "PageOut",
    "ProjectCreate",
    "ProjectDetailOut",
    "ProjectListItemOut",
    "ProjectListOut",
    "ProjectNodeSummaryOut",
    "ProjectUpdate",
    "StageSpecOut",
    "TransitionRequest",
    "SystemRefOut",
]
