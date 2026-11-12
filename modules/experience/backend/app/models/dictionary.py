"""体验字典模型：导入批次、字典节点、检查项（T06）。

字典是自查表 / 走查表 / 问题分类的共同基础；**数量与来源不得改动**，
必须来自指定 UEI 源工作簿的真实内容（禁止摘要、虚构说明或重复占位行凑数）。
被引用的字典条目**不得物理删除**，只能停用（``is_active=False``）。
"""

from __future__ import annotations

import datetime as _dt

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models import Base, TimestampMixin

# 字典类型
DICT_SOFTWARE = "software"              # 软件体验指标（1/4/33/114）
DICT_HARDWARE = "hardware"              # 硬件体验指标（1/4/15）
DICT_HARDWARE_PRODUCT = "hardware_product"  # 硬件单品维度（4/41/56/224）
DICT_CONTROL_SOFTWARE = "control_software"  # 交互控件（软件）：46 组件 / 136 细则
DICT_CONTROL_HARDWARE = "control_hardware"  # 交互控件（硬件）

DICT_TYPES: tuple[str, ...] = (
    DICT_SOFTWARE,
    DICT_HARDWARE,
    DICT_HARDWARE_PRODUCT,
    DICT_CONTROL_SOFTWARE,
    DICT_CONTROL_HARDWARE,
)
DICT_TYPE_LABELS: dict[str, str] = {
    DICT_SOFTWARE: "软件体验指标",
    DICT_HARDWARE: "硬件体验指标",
    DICT_HARDWARE_PRODUCT: "硬件单品体验维度",
    DICT_CONTROL_SOFTWARE: "交互控件（软件）",
    DICT_CONTROL_HARDWARE: "交互控件（硬件）",
}

# 问题等级扣分（硬件单品：致命/严重/一般/轻微 = 5/3/2/1）
HARDWARE_SEVERITY_DEDUCTION: dict[str, int] = {"fatal": 5, "major": 3, "normal": 2, "minor": 1}

BATCH_PENDING = "pending"
BATCH_IMPORTED = "imported"
BATCH_BLOCKED = "blocked"
BATCH_FAILED = "failed"


class DictionaryBatch(Base, TimestampMixin):
    """字典导入批次（源只读；记录来源哈希与数量核对结果）。"""

    __tablename__ = "dictionary_batch"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    source_path: Mapped[str] = mapped_column(String(500), nullable=False)
    source_sha256: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    source_size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    source_modified_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=BATCH_PENDING, index=True)
    dry_run: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    counts_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    expected_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    diff_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    blocked_reason: Mapped[str] = mapped_column(Text, nullable=False, default="")
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_by_name: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    finished_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DictionaryNode(Base, TimestampMixin):
    """字典层级节点（一级 / 二级 / 三级 或 维度行）。"""

    __tablename__ = "dictionary_node"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    dict_type: Mapped[str] = mapped_column(String(24), nullable=False, index=True)
    batch_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    parent_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("dictionary_node.id", ondelete="CASCADE"), nullable=True, index=True
    )
    level: Mapped[int] = mapped_column(Integer, nullable=False, default=1, index=True)
    path: Mapped[str] = mapped_column(String(500), nullable=False, default="", index=True)
    code: Mapped[str] = mapped_column(String(64), nullable=False, default="", index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    order_no: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # 硬件单品维度行的等级与扣分
    severity: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    deduction: Mapped[str] = mapped_column(String(16), nullable=False, default="")

    note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    source_standard: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    example: Mapped[str] = mapped_column(Text, nullable=False, default="")
    image_meta_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    raw_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")

    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)
    reference_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    children: Mapped[list[DictionaryNode]] = relationship(
        back_populates="parent", cascade="all, delete-orphan", lazy="selectin",
        order_by="DictionaryNode.order_no",
    )
    parent: Mapped[DictionaryNode | None] = relationship(back_populates="children", remote_side="DictionaryNode.id")
    check_items: Mapped[list[CheckItem]] = relationship(
        back_populates="node", cascade="all, delete-orphan", lazy="selectin",
        order_by="CheckItem.item_no",
    )


Index("ix_dict_node_type_level", DictionaryNode.dict_type, DictionaryNode.level)


class CheckItem(Base, TimestampMixin):
    """检查项（软件 1–114 连续编号；交互控件细则等）。

    字段口径（PRD §9.1）：指标说明、来源标准、问题示例、示例图片引用。
    """

    __tablename__ = "check_item"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    dict_type: Mapped[str] = mapped_column(String(24), nullable=False, index=True)
    node_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("dictionary_node.id", ondelete="CASCADE"), nullable=False, index=True
    )
    batch_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    item_no: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    source_standard: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    example: Mapped[str] = mapped_column(Text, nullable=False, default="")
    image_meta_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    severity: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    deduction: Mapped[str] = mapped_column(String(16), nullable=False, default="")
    raw_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)
    reference_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    node: Mapped[DictionaryNode] = relationship(back_populates="check_items")


Index("ix_check_item_unique", CheckItem.dict_type, CheckItem.node_id, CheckItem.item_no, unique=True)
