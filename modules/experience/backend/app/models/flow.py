"""项目域模型：事业部、系统、产品项目与 13 节点实例（T04 / v1.1 层级合并）。

- ``Division`` 事业部：**被评价主体**，不是登录主体；受控字典。
- ``System`` 系统（在 ``app.models.systems``）：产品项目的分组单位，项目直挂系统。
- ``Project`` 项目（产品项目）：自带版本号与系统内权重，承载负责人（字段，非账号）。
- ``WorkflowNode`` 13 节点实例：项目创建时按类型实例化，状态迁移由服务端校验。
- ``WorkflowNodeEvent`` 节点历史（供节点详情页「历史」区）。
"""

from __future__ import annotations

import datetime as _dt

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.domain import states as st
from app.models import AuditMixin, Base, TimestampMixin

# 事业部状态
DIVISION_ACTIVE = "active"
DIVISION_ARCHIVED = "archived"

# 项目状态
PROJECT_ACTIVE = "active"
PROJECT_ARCHIVED = "archived"
PROJECT_CLOSED = "closed"


class Division(Base, TimestampMixin, AuditMixin):
    """事业部（被评价主体，非登录主体）。"""

    __tablename__ = "division"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    code: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    owner_text: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=DIVISION_ACTIVE, index=True)
    note: Mapped[str] = mapped_column(Text, nullable=False, default="")

class Project(Base, TimestampMixin, AuditMixin):
    """产品项目（新产品 / 迭代产品），直接挂在系统下。"""

    __tablename__ = "project"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    code: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(160), nullable=False, index=True)
    system_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("system.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    version_code: Mapped[str] = mapped_column(String(64), nullable=False, default="", index=True)
    # 系统合并 UEI 的加权权重（Σ(项目UEI×权重)/Σ权重），默认等权
    weight: Mapped[str] = mapped_column(String(16), nullable=False, default="1")
    division_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("division.id", ondelete="SET NULL"), nullable=True, index=True
    )
    project_type: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    owner_text: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    members_text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=PROJECT_ACTIVE, index=True)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")

    # 迭代产品 N03 的核心业务判定（由 N03 提交、N04 确认，见 DESIGN §6.1.3）
    core_business_involved: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    core_business_reason: Mapped[str] = mapped_column(Text, nullable=False, default="")
    core_business_confirmed_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    started_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    system: Mapped["System"] = relationship(lazy="joined")
    division: Mapped[Division | None] = relationship(lazy="joined")
    nodes: Mapped[list[WorkflowNode]] = relationship(
        back_populates="project", cascade="all, delete-orphan", lazy="selectin",
        order_by="WorkflowNode.node_order",
    )

    @property
    def is_iteration(self) -> bool:
        from app.domain.nodes import PROJECT_TYPE_ITERATION

        return self.project_type == PROJECT_TYPE_ITERATION


class WorkflowNode(Base, TimestampMixin, AuditMixin):
    """项目节点实例（13 个固定节点的实例化）。"""

    __tablename__ = "workflow_node"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("project.id", ondelete="CASCADE"), nullable=False, index=True
    )
    code: Mapped[str] = mapped_column(String(8), nullable=False, index=True)
    node_order: Mapped[int] = mapped_column(Integer, nullable=False)
    stage_code: Mapped[str] = mapped_column(String(8), nullable=False)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    scope: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    duration_days: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    outputs_text: Mapped[str] = mapped_column(String(255), nullable=False, default="")

    status: Mapped[str] = mapped_column(String(20), nullable=False, default=st.NODE_NOT_STARTED, index=True)
    allow_not_applicable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    iteration_only: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    planned_start_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    planned_end_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    actual_start_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    actual_end_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    not_applicable_reason: Mapped[str] = mapped_column(Text, nullable=False, default="")
    note: Mapped[str] = mapped_column(Text, nullable=False, default="")

    project: Mapped[Project] = relationship(back_populates="nodes")
    events: Mapped[list[WorkflowNodeEvent]] = relationship(
        back_populates="node", cascade="all, delete-orphan", lazy="selectin",
        order_by="WorkflowNodeEvent.created_at",
    )


Index("ix_workflow_node_project_code", WorkflowNode.project_id, WorkflowNode.code, unique=True)


class WorkflowNodeEvent(Base, TimestampMixin):
    """节点状态迁移历史（不可编辑）。"""

    __tablename__ = "workflow_node_event"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    node_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workflow_node.id", ondelete="CASCADE"), nullable=False, index=True
    )
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    action: Mapped[str] = mapped_column(String(32), nullable=False)
    from_status: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    to_status: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    reason: Mapped[str] = mapped_column(Text, nullable=False, default="")
    actor_account_id: Mapped[str] = mapped_column(String(36), nullable=False, default="")
    actor_name: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    request_id: Mapped[str] = mapped_column(String(64), nullable=False, default="")

    node: Mapped[WorkflowNode] = relationship(back_populates="events")
