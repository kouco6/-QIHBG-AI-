"""账号、会话与审计模型（T03）。

- ``Account``：单一体验人员角色；``is_primary`` 标记首账号（额外拥有系统设置写权限）。
- ``AuthSession``：会话记录；只保存令牌摘要，支持撤销与过期。
- ``AuditLog``：业务 / 设置 / 鉴权三类审计；明细字段写库前必须脱敏。
"""

from __future__ import annotations

import datetime as _dt

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models import Base, TimestampMixin

# 单一角色常量：所有账号业务权限一致（DESIGN §6.1）
ROLE_EXPERIENCE_MEMBER = "experience_member"

# 审计分类
AUDIT_CATEGORY_AUTH = "auth"
AUDIT_CATEGORY_BUSINESS = "business"
AUDIT_CATEGORY_SETTING = "setting"


class Account(Base, TimestampMixin):
    """体验人员账号。"""

    __tablename__ = "account"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    account: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    role: Mapped[str] = mapped_column(String(32), nullable=False, default=ROLE_EXPERIENCE_MEMBER)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)

    # 首账号：数据库中的第一个账号；仅其可写系统设置
    is_primary: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    last_login_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    sessions: Mapped[list[AuthSession]] = relationship(
        back_populates="account", cascade="all, delete-orphan", lazy="selectin"
    )

    @property
    def display(self) -> str:
        return f"{self.name}（{self.account}）"


class AuthSession(Base):
    """登录会话；``token_hash`` 为令牌摘要，明文令牌不落库。"""

    __tablename__ = "auth_session"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    account_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("account.id", ondelete="CASCADE"), nullable=False, index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)

    created_at: Mapped[_dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen_at: Mapped[_dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[_dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    revoked_at: Mapped[_dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user_agent: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    ip_address: Mapped[str] = mapped_column(String(64), nullable=False, default="")

    account: Mapped[Account] = relationship(back_populates="sessions", lazy="joined")


class AuditLog(Base):
    """审计日志：业务操作、设置变更与鉴权事件。

    ``detail`` 为 JSON 文本，写入前统一经 ``app.core.audit.redact`` 脱敏，
    密码 / 密钥 / 令牌等敏感字段一律替换为占位符（T03 验收：日志不含密码）。
    """

    __tablename__ = "audit_log"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    category: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    action: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    actor_account_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    actor_name: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    actor_role: Mapped[str] = mapped_column(String(32), nullable=False, default="")

    target_type: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    target_id: Mapped[str] = mapped_column(String(64), nullable=False, default="")

    summary: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    detail: Mapped[str] = mapped_column(Text, nullable=False, default="{}")

    request_id: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    ip_address: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    created_at: Mapped[_dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)


# 常用检索组合：按分类+时间、按操作者+时间
Index("ix_audit_log_category_created", AuditLog.category, AuditLog.created_at)
Index("ix_audit_log_actor_created", AuditLog.actor_account_id, AuditLog.created_at)
