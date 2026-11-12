"""T12 三层分值库

Revision ID: 0009_score_library
Revises: 0008_bei_l3
Create Date: 2026-10-16

本迁移由 SQLAlchemy 元数据确定性生成（autogenerate 后按任务拆分），
升级/降级均自包含，不依赖运行时模型定义。
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0009_score_library"
down_revision: str | None = '0008_bei_l3'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
        op.create_table('score_library',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('level', sa.String(length=4), nullable=False),
        sa.Column('level_label', sa.String(length=32), nullable=False),
        sa.Column('caliber', sa.Text(), nullable=False),
        sa.Column('object_type', sa.String(length=32), nullable=False),
        sa.Column('object_id', sa.String(length=36), nullable=False),
        sa.Column('object_name', sa.String(length=160), nullable=False),
        sa.Column('product_id', sa.String(length=36), nullable=True),
        sa.Column('product_line_id', sa.String(length=36), nullable=True),
        sa.Column('division_id', sa.String(length=36), nullable=True),
        sa.Column('period', sa.String(length=32), nullable=False),
        sa.Column('version_code', sa.String(length=64), nullable=False),
        sa.Column('score', sa.String(length=24), nullable=True),
        sa.Column('display_score', sa.String(length=24), nullable=True),
        sa.Column('grade', sa.String(length=16), nullable=True),
        sa.Column('has_score', sa.Boolean(), nullable=False),
        sa.Column('sample_sufficient', sa.Boolean(), nullable=False),
        sa.Column('status_note', sa.String(length=120), nullable=False),
        sa.Column('scheme_ref', sa.String(length=64), nullable=False),
        sa.Column('threshold_ref', sa.String(length=64), nullable=False),
        sa.Column('source_type', sa.String(length=40), nullable=False),
        sa.Column('source_snapshot_id', sa.String(length=36), nullable=False),
        sa.Column('issue_count', sa.Integer(), nullable=False),
        sa.Column('extra_json', sa.Text(), nullable=False),
        sa.Column('snapshot_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_by_name', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('score_library', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_score_library_division_id'), ['division_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_score_library_level'), ['level'], unique=False)
            batch_op.create_index('ix_score_library_level_object', ['level', 'object_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_score_library_object_id'), ['object_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_score_library_object_name'), ['object_name'], unique=False)
            batch_op.create_index(batch_op.f('ix_score_library_object_type'), ['object_type'], unique=False)
            batch_op.create_index(batch_op.f('ix_score_library_period'), ['period'], unique=False)
            batch_op.create_index(batch_op.f('ix_score_library_product_id'), ['product_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_score_library_product_line_id'), ['product_line_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_score_library_snapshot_at'), ['snapshot_at'], unique=False)
            batch_op.create_index('ix_score_library_source', ['source_type', 'source_snapshot_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_score_library_source_snapshot_id'), ['source_snapshot_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_score_library_source_type'), ['source_type'], unique=False)


def downgrade() -> None:
    op.drop_table('score_library')

