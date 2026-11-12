"""T03 迁移：账号、会话与审计日志。

Revision ID: 0002_accounts_auth
Revises: 0001_initial
Create Date: 2026-10-16
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_accounts_auth"
down_revision: str | None = "0001_initial"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "account",
        sa.Column("id", sa.String(length=36), primary_key=True, nullable=False),
        sa.Column("account", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("role", sa.String(length=32), nullable=False, server_default="experience_member"),
        sa.Column("password_hash", sa.String(length=255), nullable=False),
        sa.Column("is_primary", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_account_account", "account", ["account"], unique=True)

    op.create_table(
        "auth_session",
        sa.Column("id", sa.String(length=36), primary_key=True, nullable=False),
        sa.Column("account_id", sa.String(length=36), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("user_agent", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("ip_address", sa.String(length=64), nullable=False, server_default=""),
        sa.ForeignKeyConstraint(["account_id"], ["account.id"], name="fk_auth_session_account", ondelete="CASCADE"),
    )
    op.create_index("ix_auth_session_account_id", "auth_session", ["account_id"])
    op.create_index("ix_auth_session_token_hash", "auth_session", ["token_hash"], unique=True)
    op.create_index("ix_auth_session_expires_at", "auth_session", ["expires_at"])

    op.create_table(
        "audit_log",
        sa.Column("id", sa.String(length=36), primary_key=True, nullable=False),
        sa.Column("category", sa.String(length=32), nullable=False),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column("actor_account_id", sa.String(length=36), nullable=True),
        sa.Column("actor_name", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("actor_role", sa.String(length=32), nullable=False, server_default=""),
        sa.Column("target_type", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("target_id", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("summary", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("detail", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("request_id", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("ip_address", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_audit_log_category", "audit_log", ["category"])
    op.create_index("ix_audit_log_action", "audit_log", ["action"])
    op.create_index("ix_audit_log_actor_account_id", "audit_log", ["actor_account_id"])
    op.create_index("ix_audit_log_category_created", "audit_log", ["category", "created_at"])
    op.create_index("ix_audit_log_actor_created", "audit_log", ["actor_account_id", "created_at"])


def downgrade() -> None:
    op.drop_table("audit_log")
    op.drop_table("auth_session")
    op.drop_index("ix_account_account", table_name="account")
    op.drop_table("account")
