"""UEI 评分方案、L1 预览与快照的请求 / 响应模型（T08）。

设计约定：

- 请求模型只做**结构性校验**（必填、长度、枚举）；跨字段与业务规则在
  ``app.services.scoring`` 中二次校验，统一抛 :class:`app.core.errors.ValidationError`（422）。
- 响应模型中的分值与扣分统一使用 ``str``（十进制字符串，展示 1 位小数），
  避免二进制浮点误差进入接口层（PRD §8.1「禁止以二进制浮点误差决定快照值」）。
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

CALIBER_L1 = "单产品 UEI = 100 − Σ逐问题单项扣分；矩阵值已含业务权重，禁止二次乘权重"


# --------------------------------------------------------------------------- 方案


class SchemeCellOut(BaseModel):
    """矩阵单元（8 个）。"""

    model_config = ConfigDict(from_attributes=True)

    cell_key: str
    business_level: str
    severity: str
    cell_order: int
    deduction: str
    display_deduction: str = ""


class SchemeOut(BaseModel):
    """评分方案（含 8 个单元与引用数）。"""

    id: str
    code: str
    name: str
    business_ratio: str
    problem_ratio: str
    scheme_version: int
    is_default: bool
    is_active: bool
    is_builtin: bool
    note: str = ""
    cell_count: int = 8
    reference_count: int = 0
    snapshot_reference_count: int = 0
    line_reference_count: int = 0
    is_referenced: bool = False
    read_only: bool = False
    read_only_reason: str = ""
    cells: list[SchemeCellOut] = Field(default_factory=list)
    created_at: str | None = None
    updated_at: str | None = None


class SchemeListOut(BaseModel):
    total: int
    include_inactive: bool = True
    default_code: str = ""
    items: list[SchemeOut] = Field(default_factory=list)


class SchemeCellIn(BaseModel):
    """待写入的矩阵单元。"""

    cell_key: str = Field(min_length=1, max_length=32)
    deduction: str = Field(min_length=1, max_length=16, description="非负十进制字符串")


class SchemeCreate(BaseModel):
    """创建方案 / 新方案版本（仅首账号）。"""

    code: str | None = Field(default=None, max_length=32, description="方案编码；缺省按业务比/问题比生成")
    name: str = Field(min_length=1, max_length=120)
    business_ratio: str = Field(min_length=1, max_length=16)
    problem_ratio: str = Field(min_length=1, max_length=32)
    cells: list[SchemeCellIn] = Field(default_factory=list, description="8 个矩阵单元")
    note: str = Field(default="", max_length=2000)


class SchemeUpdate(BaseModel):
    """修改方案（仅首账号；被引用的方案只读 → 409）。"""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    note: str | None = Field(default=None, max_length=2000)
    cells: list[SchemeCellIn] | None = None
    is_active: bool | None = None


# --------------------------------------------------------------------------- 预览


class SchemeRefOut(BaseModel):
    id: str
    code: str
    name: str
    business_ratio: str
    problem_ratio: str
    scheme_version: int


class ConflictLineOut(BaseModel):
    """冲突产品线（产品归属多条线且绑定方案不同）。"""

    line_id: str
    line_code: str
    line_name: str
    scheme_id: str
    scheme_code: str


class PreviewIssueOut(BaseModel):
    """逐问题明细（可展开到命中矩阵单元）。"""

    issue_id: str
    issue_code: str
    description: str = ""
    business_level: str
    severity: str
    cell_key: str
    deduction: str
    module: str = ""
    metric_l1: str = ""
    classification_source: str = "current"


class ScorePreviewOut(BaseModel):
    """L1 UEI 实时预览。"""

    project_id: str
    system_id: str = ""
    system_name: str = ""
    version_code: str = ""
    division_id: str | None = None

    scheme: SchemeRefOut
    scheme_source: str = "default"
    scheme_source_label: str = "默认方案"
    scheme_conflict: bool = False
    conflict_lines: list[ConflictLineOut] = Field(default_factory=list)

    cell_counts: dict[str, int] = Field(default_factory=dict)
    cell_labels: dict[str, str] = Field(default_factory=dict)
    issues: list[PreviewIssueOut] = Field(default_factory=list)

    cores: dict[str, int] = Field(default_factory=dict)
    core_deduction: str = "0.0"
    non_core_deduction: str = "0.0"
    total_deduction: str = "0.0"
    raw_uei: str = "100.0"
    display_uei: str = "100.0"
    clamp_zero: bool = False
    issue_count: int = 0
    excluded_issue_count: int = 0
    caliber_note: str = CALIBER_L1


# --------------------------------------------------------------------------- 快照


class SnapshotCreateRequest(BaseModel):
    """创建 L1 快照（追加写，不可变）。"""

    project_id: str = Field(min_length=1)
    scheme_id: str | None = Field(default=None, description="显式方案；缺省按系统归属解析")


class SnapshotIssueOut(BaseModel):
    issue_id: str
    issue_code: str
    business_level: str
    severity: str
    cell_key: str
    deduction: str
    module: str = ""
    metric_l1: str = ""
    description_digest: str = ""


class SnapshotSummaryOut(BaseModel):
    id: str
    scope: str
    project_id: str
    project_name: str = ""
    version_code: str = ""
    division_id: str | None = None
    scheme_id: str
    scheme_code: str = ""
    scheme_business_ratio: str = ""
    scheme_problem_ratio: str = ""
    issue_count: int = 0
    core_issue_count: int = 0
    non_core_issue_count: int = 0
    cell_counts: dict[str, int] = Field(default_factory=dict)
    core_deduction: str = "0.0"
    non_core_deduction: str = "0.0"
    total_deduction: str = "0.0"
    raw_uei: str = "100.0"
    display_uei: str = "100.0"
    clamp_zero: bool = False
    is_effective: bool = True
    created_by_name: str = ""
    snapshot_at: str | None = None


class SnapshotOut(SnapshotSummaryOut):
    issues: list[SnapshotIssueOut] = Field(default_factory=list)
    input_manifest: dict[str, Any] = Field(default_factory=dict)
    calc_trace: dict[str, Any] = Field(default_factory=dict)
    immutable: bool = True
    caliber_note: str = CALIBER_L1


class SnapshotListOut(BaseModel):
    page: int = 1
    page_size: int = 50
    total: int = 0
    items: list[SnapshotSummaryOut] = Field(default_factory=list)


__all__ = [
    "CALIBER_L1",
    "ConflictLineOut",
    "PreviewIssueOut",
    "SchemeCellIn",
    "SchemeCellOut",
    "SchemeCreate",
    "SchemeListOut",
    "SchemeOut",
    "SchemeRefOut",
    "SchemeUpdate",
    "ScorePreviewOut",
    "SnapshotCreateRequest",
    "SnapshotIssueOut",
    "SnapshotListOut",
    "SnapshotOut",
    "SnapshotSummaryOut",
]
