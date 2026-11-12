"""可用性研究模型（T09 / N12）。

- ``UsabilityStudy``：研究（小组走查 / 可用性测试），关联项目与脚本产物。
- ``StudyParticipant``：匿名化参与者（新手/熟手、有效/无效）。
- ``StudyTask``：任务（来自脚本设计）。
- ``TaskRun``：参与者 × 任务执行记录（完成状态、耗时秒、出错步骤）。
- ``SusAnswer``：标准十题 SUS 答卷与满意度。
"""

from __future__ import annotations

import datetime as _dt

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models import AuditMixin, Base, TimestampMixin

STUDY_WALKTHROUGH = "group_walkthrough"   # 小组走查
STUDY_USABILITY = "usability_test"        # 可用性测试
STUDY_KINDS: tuple[str, ...] = (STUDY_WALKTHROUGH, STUDY_USABILITY)
STUDY_KIND_LABELS: dict[str, str] = {
    STUDY_WALKTHROUGH: "小组走查",
    STUDY_USABILITY: "可用性测试",
}

STUDY_DRAFT = "draft"
STUDY_RUNNING = "running"
STUDY_COMPLETED = "completed"
STUDY_NA = "not_applicable"

PARTICIPANT_NOVICE = "novice"
PARTICIPANT_EXPERT = "expert"
PARTICIPANT_GROUPS: tuple[str, ...] = (PARTICIPANT_NOVICE, PARTICIPANT_EXPERT)
PARTICIPANT_GROUP_LABELS: dict[str, str] = {
    PARTICIPANT_NOVICE: "新手",
    PARTICIPANT_EXPERT: "熟手",
}

RUN_COMPLETED = "completed"
RUN_PARTIAL = "partial"
RUN_FAILED = "failed"
RUN_STATUSES: tuple[str, ...] = (RUN_COMPLETED, RUN_PARTIAL, RUN_FAILED)
RUN_STATUS_LABELS: dict[str, str] = {
    RUN_COMPLETED: "完成",
    RUN_PARTIAL: "部分完成",
    RUN_FAILED: "未完成",
}

SUS_INDUSTRY_REFERENCE = "67.6"   # 行业参考均值（PRD §10.1）
SATISFACTION_MIN = 1
SATISFACTION_MAX = 10


class UsabilityStudy(Base, TimestampMixin, AuditMixin):
    """可用性研究 / 小组走查。"""

    __tablename__ = "usability_study"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    code: Mapped[str] = mapped_column(String(32), nullable=False, unique=True, index=True)
    project_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("project.id", ondelete="CASCADE"), nullable=False, index=True
    )
    version_code: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    name: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    study_kind: Mapped[str] = mapped_column(String(24), nullable=False, default=STUDY_USABILITY, index=True)
    script_artifact_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=STUDY_DRAFT, index=True)
    not_applicable_reason: Mapped[str] = mapped_column(Text, nullable=False, default="")
    report_artifact_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    note: Mapped[str] = mapped_column(Text, nullable=False, default="")

    participants: Mapped[list[StudyParticipant]] = relationship(
        back_populates="study", cascade="all, delete-orphan", lazy="selectin",
        order_by="StudyParticipant.order_no",
    )
    tasks: Mapped[list[StudyTask]] = relationship(
        back_populates="study", cascade="all, delete-orphan", lazy="selectin",
        order_by="StudyTask.task_no",
    )


class StudyParticipant(Base, TimestampMixin):
    """参与者（匿名代号，不创建账号）。"""

    __tablename__ = "study_participant"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    study_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("usability_study.id", ondelete="CASCADE"), nullable=False, index=True
    )
    order_no: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    alias: Mapped[str] = mapped_column(String(32), nullable=False)
    group_type: Mapped[str] = mapped_column(String(16), nullable=False, default=PARTICIPANT_NOVICE)
    is_valid: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)
    exclusion_reason: Mapped[str] = mapped_column(Text, nullable=False, default="")
    satisfaction: Mapped[int | None] = mapped_column(Integer, nullable=True)
    note: Mapped[str] = mapped_column(Text, nullable=False, default="")

    study: Mapped[UsabilityStudy] = relationship(back_populates="participants")
    runs: Mapped[list[TaskRun]] = relationship(
        back_populates="participant", cascade="all, delete-orphan", lazy="selectin",
    )
    sus: Mapped[SusAnswer | None] = relationship(
        back_populates="participant", cascade="all, delete-orphan", lazy="selectin", uselist=False,
    )


Index("ix_study_participant_unique", StudyParticipant.study_id, StudyParticipant.alias, unique=True)


class StudyTask(Base, TimestampMixin):
    """研究任务（默认来自脚本设计产物）。"""

    __tablename__ = "study_task"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    study_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("usability_study.id", ondelete="CASCADE"), nullable=False, index=True
    )
    task_no: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    flow: Mapped[str] = mapped_column(String(32), nullable=False, default="")
    module: Mapped[str] = mapped_column(String(120), nullable=False, default="", index=True)
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    expected: Mapped[str] = mapped_column(Text, nullable=False, default="")

    study: Mapped[UsabilityStudy] = relationship(back_populates="tasks")
    runs: Mapped[list[TaskRun]] = relationship(
        back_populates="task", cascade="all, delete-orphan", lazy="selectin",
    )


class TaskRun(Base, TimestampMixin):
    """参与者 × 任务执行记录。"""

    __tablename__ = "task_run"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    study_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    task_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("study_task.id", ondelete="CASCADE"), nullable=False, index=True
    )
    participant_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("study_participant.id", ondelete="CASCADE"), nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=RUN_COMPLETED, index=True)
    duration_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_steps: Mapped[str] = mapped_column(Text, nullable=False, default="")
    error_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    note: Mapped[str] = mapped_column(Text, nullable=False, default="")

    task: Mapped[StudyTask] = relationship(back_populates="runs")
    participant: Mapped[StudyParticipant] = relationship(back_populates="runs")


Index("ix_task_run_unique", TaskRun.task_id, TaskRun.participant_id, unique=True)


class SusAnswer(Base, TimestampMixin):
    """标准 10 题 SUS 答卷（缺题不计算）。"""

    __tablename__ = "sus_answer"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    study_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    participant_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("study_participant.id", ondelete="CASCADE"), nullable=False, index=True
    )
    q1: Mapped[int | None] = mapped_column(Integer, nullable=True)
    q2: Mapped[int | None] = mapped_column(Integer, nullable=True)
    q3: Mapped[int | None] = mapped_column(Integer, nullable=True)
    q4: Mapped[int | None] = mapped_column(Integer, nullable=True)
    q5: Mapped[int | None] = mapped_column(Integer, nullable=True)
    q6: Mapped[int | None] = mapped_column(Integer, nullable=True)
    q7: Mapped[int | None] = mapped_column(Integer, nullable=True)
    q8: Mapped[int | None] = mapped_column(Integer, nullable=True)
    q9: Mapped[int | None] = mapped_column(Integer, nullable=True)
    q10: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # 0–100，缺题时为 NULL（禁止臆造）
    sus_score: Mapped[str | None] = mapped_column(String(24), nullable=True)
    satisfaction: Mapped[int | None] = mapped_column(Integer, nullable=True)
    entered_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    participant: Mapped[StudyParticipant] = relationship(back_populates="sus")
