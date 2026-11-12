"""系统与系统合并 UEI 的请求 / 响应模型（T10 / v1.1 层级合并）。

- 请求模型只做结构性校验；跨字段与业务规则在 ``app.services.systems`` 中校验。
- 所有分值与扣分以 ``str``（十进制字符串，1 位小数）返回。
- 权重加权口径：Σ(项目 UEI × 项目权重) / Σ权重（默认展示）；去重重算口径为权威，两者并列展示。
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

CALIBER_AUTHORITATIVE = "系统 UEI（权威）：系统内纳入项目的 SnapshotIssue 并集按问题 ID 去重后，用系统绑定方案重算"
CALIBER_WEIGHTED = "权重加权平均（默认展示口径）：Σ(项目 UEI × 项目权重) / Σ权重"
CALIBER_BUCKET = "木桶分（非权威参考）：系统内项目 UEI 最低值"


# --------------------------------------------------------------------------- 系统


class SystemCreate(BaseModel):
    code: str = Field(min_length=1, max_length=64, description="系统编码（唯一）")
    name: str = Field(min_length=1, max_length=160)
    scheme_id: str = Field(min_length=1, description="必须绑定评分方案")
    owner_text: str = Field(default="", max_length=64)
    division_id: str | None = None
    note: str = Field(default="", max_length=2000)


class SystemUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    owner_text: str | None = Field(default=None, max_length=64)
    division_id: str | None = None
    note: str | None = Field(default=None, max_length=2000)


class SchemeBindingOut(BaseModel):
    id: str
    code: str
    name: str
    business_ratio: str
    problem_ratio: str
    scheme_version: int


class SystemMemberOut(BaseModel):
    id: str
    system_id: str
    project_id: str
    project_name: str = ""
    code: str = ""
    version_code: str = ""
    weight: str = "1"
    project_type: str = ""
    owner_text: str = ""
    status: str = "active"
    current_node_name: str = ""


class SystemAlertOut(BaseModel):
    """口径外提示。"""

    level: str = "info"
    kind: str = "out_of_scope"
    message: str
    project_id: str = ""
    project_name: str = ""
    system_id: str = ""
    system_name: str = ""


class SystemSnapshotSummaryOut(BaseModel):
    id: str
    system_id: str
    system_code: str = ""
    system_name: str = ""
    scheme_id: str
    scheme_code: str = ""
    selection_mode: str
    filters: dict[str, Any] = Field(default_factory=dict)
    source_snapshot_count: int = 0
    effective_project_count: int = 0
    outlier_project_count: int = 0
    raw_issue_count: int = 0
    deduped_issue_count: int = 0
    core_deduction: str = "0.0"
    non_core_deduction: str = "0.0"
    total_deduction: str = "0.0"
    authoritative_uei: str = "100.0"
    weighted_average_uei: str = ""
    bucket_uei: str = ""
    sample_sufficient: bool = False
    cell_counts: dict[str, int] = Field(default_factory=dict)
    created_by_name: str = ""
    snapshot_at: str | None = None


class SystemOut(BaseModel):
    id: str
    code: str
    name: str
    owner_text: str = ""
    division_id: str | None = None
    status: str
    status_label: str = ""
    scheme_id: str
    scheme_version: int
    scheme_code: str = ""
    scheme_name: str = ""
    scheme: SchemeBindingOut | None = None
    note: str = ""
    member_count: int = 0
    effective_project_count: int = 0
    created_at: str | None = None
    updated_at: str | None = None
    updated_by_name: str = ""


class SystemListOut(BaseModel):
    page: int = 1
    page_size: int = 50
    total: int = 0
    items: list[SystemOut] = Field(default_factory=list)


class SystemDetailOut(SystemOut):
    members: list[SystemMemberOut] = Field(default_factory=list)
    active_members: list[SystemMemberOut] = Field(default_factory=list)
    alerts: list[SystemAlertOut] = Field(default_factory=list)
    snapshot_history: list[SystemSnapshotSummaryOut] = Field(default_factory=list)


class MemberAttachRequest(BaseModel):
    project_id: str = Field(min_length=1)
    weight: str = Field(default="1", max_length=16, description="合并 UEI 权重，正数")


class MemberWeightRequest(BaseModel):
    weight: str = Field(min_length=1, max_length=16, description="合并 UEI 权重，正数")


class MemberLeaveRequest(BaseModel):
    reason: str | None = Field(default=None, max_length=2000)


class SchemeChangeRequest(BaseModel):
    scheme_id: str = Field(min_length=1)
    reason: str | None = Field(default=None, max_length=2000)


# --------------------------------------------------------------------------- L2 预览 / 快照


class L2SourceOut(BaseModel):
    project_id: str
    project_name: str = ""
    version_code: str = ""
    weight: str = "1"
    l1_snapshot_id: str
    l1_scheme_code: str = ""
    l1_uei: str = ""
    is_out_of_scope: bool = False
    issue_count: int = 0
    project_uei: str = ""


class L2IssueOut(BaseModel):
    issue_id: str
    issue_code: str = ""
    business_level: str
    severity: str
    cell_key: str
    deduction: str
    project_id: str = ""
    project_name: str = ""


class RankOut(BaseModel):
    project_id: str
    project_name: str = ""
    project_uei: str
    deviation: str
    issue_count: int = 0


class ExposureOut(BaseModel):
    key: str
    label: str = ""
    issue_count: int = 0


class TrendOut(BaseModel):
    version_code: str
    project_count: int = 0
    deduped_issue_count: int = 0
    uei: str = "100.0"


class AuxiliaryOut(BaseModel):
    weighted_average_uei: str = ""
    bucket_uei: str = ""
    authoritative: bool = False
    caliber_weighted: str = CALIBER_WEIGHTED
    caliber_bucket: str = CALIBER_BUCKET


class L2PreviewOut(BaseModel):
    system_id: str
    system_code: str = ""
    system_name: str = ""
    status: str = ""
    scheme: SchemeBindingOut
    selection_mode: str
    selection_mode_label: str = ""
    filters: dict[str, Any] = Field(default_factory=dict)

    sources: list[L2SourceOut] = Field(default_factory=list)
    out_of_scope_projects: list[L2SourceOut] = Field(default_factory=list)
    source_snapshot_count: int = 0
    effective_project_count: int = 0
    outlier_project_count: int = 0
    raw_issue_count: int = 0
    deduped_issue_count: int = 0

    issues: list[L2IssueOut] = Field(default_factory=list)
    cell_counts: dict[str, int] = Field(default_factory=dict)
    core_deduction: str = "0.0"
    non_core_deduction: str = "0.0"
    total_deduction: str = "0.0"
    authoritative_uei: str = "100.0"
    display_uei: str = "100.0"
    clamp_zero: bool = False

    auxiliary: AuxiliaryOut = Field(default_factory=AuxiliaryOut)
    sample_sufficient: bool = False
    sample_gap: str = ""
    rankings: list[RankOut] = Field(default_factory=list)
    top_exposure: list[ExposureOut] = Field(default_factory=list)
    trend: list[TrendOut] = Field(default_factory=list)
    caliber_note: str = CALIBER_AUTHORITATIVE


class L2SelectionFilters(BaseModel):
    """L2 快照筛选条件（随快照保存，保证历史可复算）。"""

    from_: str | None = Field(default=None, alias="from")
    to: str | None = None
    version_prefix: str | None = None

    model_config = {"populate_by_name": True}


class L2SnapshotCreate(BaseModel):
    system_id: str = Field(min_length=1)
    selection_mode: str = Field(default="latest", description="latest / window / version")
    from_: str | None = Field(default=None, alias="from")
    to: str | None = None
    version_prefix: str | None = None
    note: str = Field(default="", max_length=2000)

    model_config = {"populate_by_name": True}


class L2SnapshotOut(SystemSnapshotSummaryOut):
    sources: list[L2SourceOut] = Field(default_factory=list)
    issues: list[L2IssueOut] = Field(default_factory=list)
    auxiliary: AuxiliaryOut = Field(default_factory=AuxiliaryOut)
    sample_gap: str = ""
    immutable: bool = True
    caliber_note: str = CALIBER_AUTHORITATIVE


class L2SnapshotListOut(BaseModel):
    page: int = 1
    page_size: int = 50
    total: int = 0
    items: list[SystemSnapshotSummaryOut] = Field(default_factory=list)


# --------------------------------------------------------------------------- 跨线对比


class SystemComparisonRequest(BaseModel):
    system_ids: list[str] = Field(min_length=2, max_length=5, description="只允许 2–5 个系统")
    selection_mode: str = Field(default="latest")
    from_: str | None = Field(default=None, alias="from")
    to: str | None = None
    version_prefix: str | None = None
    top_n: int = Field(default=5, ge=1, le=20)

    model_config = {"populate_by_name": True}


class ComparisonColumnOut(BaseModel):
    system_id: str
    system_code: str = ""
    system_name: str = ""
    scheme_code: str = ""
    authoritative_uei: str = "100.0"
    weighted_average_uei: str = ""
    bucket_uei: str = ""
    sample_sufficient: bool = False
    effective_project_count: int = 0
    deduped_issue_count: int = 0
    outlier_project_count: int = 0
    cell_counts: dict[str, int] = Field(default_factory=dict)
    top_exposure: list[ExposureOut] = Field(default_factory=list)
    trend: list[TrendOut] = Field(default_factory=list)
    ranking_excluded: bool = False
    exclude_reason: str = ""


class SystemComparisonOut(BaseModel):
    system_count: int = 0
    selection_mode: str = "latest"
    same_caliber_note: str = (
        "跨系统对比仅在**同一口径**下进行：均为系统绑定方案的并集重算结果；"
        "样本不足的系统不进入排名并显式标注。"
    )
    columns: list[ComparisonColumnOut] = Field(default_factory=list)
    ranking: list[str] = Field(default_factory=list, description="进入排名的 system id（权威 UEI 降序）")
    excluded_from_ranking: list[dict[str, str]] = Field(default_factory=list)
    comparison_note: str = "不同系统分值与单项目 L1 分值不可跨层比较；本对比仅在系统层内进行。"


__all__ = [
    "CALIBER_AUTHORITATIVE",
    "CALIBER_BUCKET",
    "CALIBER_WEIGHTED",
    "AuxiliaryOut",
    "ComparisonColumnOut",
    "ExposureOut",
    "L2IssueOut",
    "L2PreviewOut",
    "L2SelectionFilters",
    "L2SnapshotCreate",
    "L2SnapshotListOut",
    "L2SnapshotOut",
    "L2SourceOut",
    "MemberAttachRequest",
    "MemberWeightRequest",
    "RankOut",
    "SchemeBindingOut",
    "SchemeChangeRequest",
    "SystemAlertOut",
    "SystemComparisonOut",
    "SystemComparisonRequest",
    "SystemCreate",
    "SystemDetailOut",
    "SystemListOut",
    "SystemMemberOut",
    "SystemOut",
    "SystemSnapshotSummaryOut",
    "SystemUpdate",
    "TrendOut",
]
