"""结构化产物请求 / 响应模型（T05）。

对应用户可见页面（DESIGN §6.2.2）：

- 产物编辑器 ``/artifacts/:id/edit``：标题 / 协作人、按模板分组字段、关联问题、
  自动保存状态、提交、恢复草稿；
- 产物版本与对比 ``/artifacts/:id/versions``：版本列表、创建人 / 时间 / 状态、
  字段级左右差异、已确认版本只读。

字段类型与 ``app.domain.templates`` 保持一致；本模块只做**形状**校验，
业务校验（必填、状态机、代录完整性）一律在服务层完成。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

ChangeKind = Literal["added", "removed", "modified", "unchanged"]


# ----------------------------------------------------------------------------- 模板


class TemplateFieldOut(BaseModel):
    """模板字段定义（``artifact_template.schema_json`` 中的单项）。"""

    key: str
    label: str
    type: str
    required: bool = False
    group: str = ""
    help: str = ""
    options: list[str] = Field(default_factory=list)
    columns: list[str] = Field(default_factory=list)
    max_length: int = 2000


class TemplateOut(BaseModel):
    """模板对外视图。"""

    kind: str
    name: str
    node_code: str
    allow_not_applicable: bool = False
    description: str = ""
    template_version: int = 1
    is_active: bool = True
    required_count: int = 0
    fields: list[TemplateFieldOut] = Field(default_factory=list)


# ----------------------------------------------------------------------------- 产物


class ActionOut(BaseModel):
    """产物当前状态可执行的合法动作（来自 ``ARTIFACT_TRANSITIONS``）。"""

    action: str
    label: str
    target: str
    requires_reason: bool = False


class ArtifactVersionOut(BaseModel):
    """产物版本快照。"""

    id: str
    version_no: int
    status: str
    is_frozen: bool
    change_note: str = ""
    source_version_no: int | None = None
    created_by: str = ""
    created_by_name: str = ""
    created_at: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    issue_ids: list[str] = Field(default_factory=list)


class ArtifactOut(BaseModel):
    """产物主体对外视图。"""

    id: str
    project_id: str
    node_id: str
    node_code: str
    kind: str
    title: str
    status: str
    status_label: str
    current_version_no: int
    collaborators_text: str = ""
    not_applicable_reason: str = ""
    last_saved_at: str | None = None
    submitted_at: str | None = None
    confirmed_at: str | None = None
    created_by_name: str = ""
    updated_by_name: str = ""
    created_at: str | None = None
    updated_at: str | None = None
    row_version: int = 1


class ArtifactDetailOut(ArtifactOut):
    """产物详情：主体 + 当前版本 payload + 模板定义 + 可用动作。"""

    template: TemplateOut
    current_version: ArtifactVersionOut | None = None
    allowed_actions: list[ActionOut] = Field(default_factory=list)


class ArtifactPageOut(BaseModel):
    page: int
    page_size: int
    total: int
    items: list[ArtifactOut] = Field(default_factory=list)


# ----------------------------------------------------------------------------- 请求


class ArtifactCreateRequest(BaseModel):
    """创建产物；``node_id`` 与 ``node_code`` 二选一。"""

    model_config = ConfigDict(extra="ignore")

    project_id: str = Field(min_length=1)
    node_id: str | None = None
    node_code: str | None = None
    kind: str = Field(min_length=1)
    title: str = Field(default="", max_length=200)
    collaborators_text: str = ""
    payload: dict[str, Any] | None = None


class ArtifactPatchRequest(BaseModel):
    """只允许修改标题与协作人文本；payload 走草稿保存接口。"""

    model_config = ConfigDict(extra="ignore")

    title: str | None = Field(default=None, max_length=200)
    collaborators_text: str | None = None


class DraftSaveRequest(BaseModel):
    """草稿自动保存（30 秒或失焦触发）。"""

    model_config = ConfigDict(extra="ignore")

    payload: dict[str, Any]
    autosave: bool = True


class DraftSaveOut(BaseModel):
    version_no: int
    saved_at: str | None = None
    autosave: bool = True


class SubmitRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    payload: dict[str, Any] | None = None
    change_note: str = ""


class ReturnRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    reason: str = ""


class ResumeRequest(BaseModel):
    """恢复 / 重开：``reason`` 用于退回恢复，``change_note`` 用于已确认版本重开。"""

    model_config = ConfigDict(extra="ignore")

    reason: str = ""
    change_note: str = ""


class MarkNotApplicableRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    reason: str = ""


class IssueRefsRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    issue_ids: list[str] = Field(default_factory=list)


# ----------------------------------------------------------------------------- 差异


class RowChangeOut(BaseModel):
    """表格 / 勾选式字段的行级差异。"""

    row_key: str
    change: ChangeKind
    from_row: dict[str, Any] | None = None
    to_row: dict[str, Any] | None = None


class FieldDiffOut(BaseModel):
    """字段级差异项；``table`` / ``checklist`` 额外给出 ``row_changes``。"""

    field: str
    label: str
    type: str
    from_value: Any = None
    to_value: Any = None
    change: ChangeKind
    row_changes: list[RowChangeOut] = Field(default_factory=list)
