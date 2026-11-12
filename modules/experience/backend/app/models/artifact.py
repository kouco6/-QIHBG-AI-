"""结构化产物模型：模板、产物、产物版本（T05）。

- ``ArtifactTemplate``：模板定义（字段 schema 以 JSON 承载），运行期数据，可版本化。
- ``Artifact``：产物主体，关联项目与节点，状态机见 ``domain.states``。
- ``ArtifactVersion``：**追加写**版本快照；已提交/已确认版本不可原地修改，
  修改必须复制为新版本（``change_note`` 记录变更原因）。
"""

from __future__ import annotations

import datetime as _dt

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.domain import states as st
from app.models import AuditMixin, Base, TimestampMixin


class ArtifactTemplate(Base, TimestampMixin):
    """产物模板（单行一模板，``schema_json`` 保存字段定义）。"""

    __tablename__ = "artifact_template"

    kind: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    node_code: Mapped[str] = mapped_column(String(8), nullable=False, index=True)
    allow_not_applicable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    schema_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    template_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class Artifact(Base, TimestampMixin, AuditMixin):
    """产物主体。"""

    __tablename__ = "artifact"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("project.id", ondelete="CASCADE"), nullable=False, index=True
    )
    node_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workflow_node.id", ondelete="CASCADE"), nullable=False, index=True
    )
    node_code: Mapped[str] = mapped_column(String(8), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=st.ARTIFACT_DRAFT, index=True)
    current_version_no: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    collaborators_text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    not_applicable_reason: Mapped[str] = mapped_column(Text, nullable=False, default="")
    last_saved_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    submitted_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    confirmed_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    versions: Mapped[list[ArtifactVersion]] = relationship(
        back_populates="artifact", cascade="all, delete-orphan", lazy="selectin",
        order_by="ArtifactVersion.version_no.desc()",
    )


Index("ix_artifact_project_kind", Artifact.project_id, Artifact.kind)


class ArtifactVersion(Base, TimestampMixin):
    """产物版本（追加写，不可覆盖）。"""

    __tablename__ = "artifact_version"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    artifact_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("artifact.id", ondelete="CASCADE"), nullable=False, index=True
    )
    version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=st.ARTIFACT_DRAFT)
    payload_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    # 保存时的状态机快照，用于版本对比展示（草稿态为自动保存；提交/确认态为冻结版本）
    is_frozen: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    change_note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    source_version_no: Mapped[int | None] = mapped_column(Integer, nullable=True)
    issue_ids_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")

    created_by: Mapped[str] = mapped_column(String(36), nullable=False, default="")
    created_by_name: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    request_id: Mapped[str] = mapped_column(String(64), nullable=False, default="")

    artifact: Mapped[Artifact] = relationship(back_populates="versions")


Index("ix_artifact_version_unique", ArtifactVersion.artifact_id, ArtifactVersion.version_no, unique=True)
