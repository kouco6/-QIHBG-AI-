"""字典管理请求/响应模型（T06）。

对外形状与 DESIGN §5 一致：分页统一 ``page/page_size``，错误统一由
``app.core.errors`` 处理；本模块只定义成功响应与请求体。
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class DictNodeOut(BaseModel):
    """字典树节点（左树）。"""

    model_config = ConfigDict(from_attributes=True)

    id: str
    dict_type: str
    parent_id: str | None = None
    level: int
    code: str
    name: str
    order_no: int
    path: str = ""
    severity: str = ""
    deduction: str = ""
    note: str = ""
    source_standard: str = ""
    example: str = ""
    image_meta: list[Any] = Field(default_factory=list)
    is_active: bool = True
    reference_count: int = 0


class TreeNodeOut(BaseModel):
    """树节点 + 子节点摘要（供懒加载判断）。"""

    id: str
    dict_type: str
    parent_id: str | None = None
    level: int
    code: str
    name: str
    order_no: int
    path: str = ""
    is_active: bool = True
    reference_count: int = 0
    child_count: int = 0
    has_children: bool = False


class TreeOut(BaseModel):
    """左树响应：``parent_id`` 为空时返回第一层；带 ``q`` 时返回匹配集合。"""

    dict_type: str
    label: str
    parent_id: str | None = None
    query: str = ""
    items: list[TreeNodeOut] = Field(default_factory=list)


class CheckItemOut(BaseModel):
    """右表检查项：软件返回 item_no/name/description/source_standard/example/image_meta。"""

    model_config = ConfigDict(from_attributes=True)

    id: str
    dict_type: str
    node_id: str
    item_no: int
    name: str = ""
    description: str = ""
    source_standard: str = ""
    example: str = ""
    image_meta: list[Any] = Field(default_factory=list)
    severity: str = ""
    deduction: str = ""
    is_active: bool = True
    reference_count: int = 0


class ItemPageOut(BaseModel):
    page: int
    page_size: int
    total: int
    items: list[CheckItemOut] = Field(default_factory=list)


class DictSummaryOut(BaseModel):
    """层级计数与检查项计数（用于数量验收）。"""

    dict_type: str
    label: str
    counts: dict[str, Any]
    expected: dict[str, Any]
    grades: list[str] = Field(default_factory=list)
    deductions: dict[str, int] = Field(default_factory=dict)


class BatchOut(BaseModel):
    id: str
    source_path: str
    source_sha256: str
    source_size_bytes: int
    source_modified_at: str | None = None
    status: str
    dry_run: bool
    counts: dict[str, Any] = Field(default_factory=dict)
    expected: dict[str, Any] = Field(default_factory=dict)
    diff: dict[str, Any] = Field(default_factory=dict)
    blocked_reason: str = ""
    notes: str = ""
    created_by_name: str = ""
    created_at: str | None = None
    finished_at: str | None = None


class ImportRequest(BaseModel):
    """导入预检/执行请求：可选覆盖源路径（默认取源清单路径）。"""

    source: str | None = Field(default=None, max_length=1000, description="源工作簿绝对路径；默认取源清单")


class NodeUpdateRequest(BaseModel):
    """节点维护：名称 / 说明 / 来源标准 / 示例 / 启停。"""

    name: str | None = Field(default=None, min_length=1, max_length=255)
    note: str | None = Field(default=None, max_length=4000)
    source_standard: str | None = Field(default=None, max_length=255)
    example: str | None = Field(default=None, max_length=8000)
    is_active: bool | None = None


class ItemUpdateRequest(BaseModel):
    """检查项维护：名称 / 说明 / 来源标准 / 示例 / 等级 / 扣分 / 启停。"""

    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=8000)
    source_standard: str | None = Field(default=None, max_length=255)
    example: str | None = Field(default=None, max_length=8000)
    severity: str | None = Field(default=None, max_length=20)
    deduction: str | None = Field(default=None, max_length=16)
    is_active: bool | None = None


class UpdateResultOut(BaseModel):
    """维护结果：实体快照 + 参考提示（停用而非删除）。"""

    node: DictNodeOut | None = None
    item: CheckItemOut | None = None
    message: str = ""


class MessageOut(BaseModel):
    message: str
    code: str = "ok"
    reference_count: int = 0
