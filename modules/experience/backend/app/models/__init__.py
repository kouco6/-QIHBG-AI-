"""SQLAlchemy 声明式基类与公共混入。"""

from __future__ import annotations

import datetime as _dt

from sqlalchemy import DateTime, Integer, String, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    """所有 ORM 模型的基类。"""


class TimestampMixin:
    """创建/更新时间。使用数据库侧默认值，保证一致。"""

    created_at: Mapped[_dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[_dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class AuditMixin:
    """业务表通用审计字段（DESIGN §3：创建人/修改人 + 乐观锁版本）。"""

    created_by: Mapped[str] = mapped_column(String(36), nullable=False, default="")
    created_by_name: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    updated_by: Mapped[str] = mapped_column(String(36), nullable=False, default="")
    updated_by_name: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)


# --- 模型注册（供 Alembic autogenerate 与 metadata.create_all 使用） ---
# 新增模型后必须在此登记，否则不会进入 Base.metadata
from app.models.account import (  # noqa: E402,F401
    AUDIT_CATEGORY_AUTH,
    AUDIT_CATEGORY_BUSINESS,
    AUDIT_CATEGORY_SETTING,
    ROLE_EXPERIENCE_MEMBER,
    Account,
    AuditLog,
    AuthSession,
)
from app.models.flow import (  # noqa: E402,F401
    Division,
    Project,
    WorkflowNode,
    WorkflowNodeEvent,
)
from app.models.artifact import (  # noqa: E402,F401
    Artifact,
    ArtifactTemplate,
    ArtifactVersion,
)
from app.models.issue import (  # noqa: E402,F401
    Issue,
    IssueAcceptance,
    IssueEvidence,
    IssueTransition,
    ProxyRecord,
)
from app.models.review import Review, ReviewDecision, ReviewSignature  # noqa: E402,F401
from app.models.scoring import (  # noqa: E402,F401
    ProjectScoreSnapshot,
    ScoringScheme,
    ScoringSchemeCell,
    SnapshotIssue,
)
from app.models.systems import (  # noqa: E402,F401
    System,
    SystemSnapshot,
    SystemSnapshotSource,
)
from app.models.bei import (  # noqa: E402,F401
    BeiManualScore,
    BeiMetricValue,
    BeiThresholdItem,
    BeiThresholdVersion,
    DivisionEvaluation,
)
from app.models.score_library import ScoreLibraryEntry  # noqa: E402,F401
from app.models.dictionary import (  # noqa: E402,F401
    CheckItem,
    DictionaryBatch,
    DictionaryNode,
)
from app.models.usability import (  # noqa: E402,F401
    StudyParticipant,
    StudyTask,
    SusAnswer,
    TaskRun,
    UsabilityStudy,
)
from app.models.provider import (  # noqa: E402,F401
    ProviderConfig,
    ProviderJob,
    ProviderReceipt,
)
from app.models.collab import (  # noqa: E402,F401
    AiConversation,
    AiMessage,
    CollaborationMessage,
    CollaborationThread,
)
from app.models.system import SystemSetting  # noqa: E402,F401

__all__ = [
    "AUDIT_CATEGORY_AUTH",
    "AUDIT_CATEGORY_BUSINESS",
    "AUDIT_CATEGORY_SETTING",
    "ROLE_EXPERIENCE_MEMBER",
    "Account",
    "AiConversation",
    "AiMessage",
    "Artifact",
    "ArtifactTemplate",
    "ArtifactVersion",
    "AuditLog",
    "AuditMixin",
    "AuthSession",
    "Base",
    "BeiManualScore",
    "BeiMetricValue",
    "BeiThresholdItem",
    "BeiThresholdVersion",
    "CheckItem",
    "CollaborationMessage",
    "CollaborationThread",
    "DictionaryBatch",
    "DictionaryNode",
    "Division",
    "DivisionEvaluation",
    "Issue",
    "IssueAcceptance",
    "IssueEvidence",
    "IssueTransition",
    "Project",
    "ProjectScoreSnapshot",
    "ProviderConfig",
    "ProviderJob",
    "ProviderReceipt",
    "ProxyRecord",
    "Review",
    "ReviewDecision",
    "ReviewSignature",
    "ScoreLibraryEntry",
    "ScoringScheme",
    "ScoringSchemeCell",
    "SnapshotIssue",
    "StudyParticipant",
    "StudyTask",
    "SusAnswer",
    "System",
    "SystemSetting",
    "SystemSnapshot",
    "SystemSnapshotSource",
    "TaskRun",
    "TimestampMixin",
    "UsabilityStudy",
    "WorkflowNode",
    "WorkflowNodeEvent",
]
