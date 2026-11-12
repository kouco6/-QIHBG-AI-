"""T02 初始迁移：建立系统设置表。

Revision ID: 0001_initial
Revises:
Create Date: 2026-10-16
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001_initial"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "system_setting",
        sa.Column("key", sa.String(length=120), primary_key=True, nullable=False),
        sa.Column("value", sa.Text(), nullable=False, server_default=""),
        sa.Column("value_type", sa.String(length=20), nullable=False, server_default="string"),
        sa.Column("description", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("updated_by", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    # 默认配置：UEI 封0 开关默认关闭（PRD §8 / DESIGN §7）
    op.bulk_insert(
        sa.table(
            "system_setting",
            sa.column("key", sa.String),
            sa.column("value", sa.Text),
            sa.column("value_type", sa.String),
            sa.column("description", sa.String),
        ),
        [
            {
                "key": "uei.clamp_zero",
                "value": "false",
                "value_type": "bool",
                "description": "UEI 得分是否封 0（默认关闭，允许显示负分）",
            },
            {
                "key": "bei.threshold_version",
                "value": "v1",
                "value_type": "string",
                "description": "当前生效的 BEI 经验阈值版本（首版来自 PRD V1.2 §8.8.6）",
            },
            {
                "key": "provider.mode",
                "value": "mock",
                "value_type": "string",
                "description": "Provider 运行模式；未配置外部凭证时强制 Mock",
            },
        ],
    )


def downgrade() -> None:
    op.drop_table("system_setting")
