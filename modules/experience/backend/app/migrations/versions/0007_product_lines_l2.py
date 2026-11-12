"""T10 产品线、多对多成员与 L2 快照

Revision ID: 0007_product_lines_l2
Revises: 0006_scoring_l1
Create Date: 2026-10-16

本迁移由 SQLAlchemy 元数据确定性生成（autogenerate 后按任务拆分），
升级/降级均自包含，不依赖运行时模型定义。
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0007_product_lines_l2"
down_revision: str | None = '0006_scoring_l1'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
        op.create_table('product_line',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('code', sa.String(length=64), nullable=False),
        sa.Column('name', sa.String(length=160), nullable=False),
        sa.Column('owner_text', sa.String(length=64), nullable=False),
        sa.Column('division_id', sa.String(length=36), nullable=True),
        sa.Column('scheme_id', sa.String(length=36), nullable=False),
        sa.Column('scheme_version', sa.Integer(), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('note', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('created_by', sa.String(length=36), nullable=False),
        sa.Column('created_by_name', sa.String(length=64), nullable=False),
        sa.Column('updated_by', sa.String(length=36), nullable=False),
        sa.Column('updated_by_name', sa.String(length=64), nullable=False),
        sa.Column('row_version', sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('product_line', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_product_line_code'), ['code'], unique=True)
            batch_op.create_index(batch_op.f('ix_product_line_division_id'), ['division_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_product_line_name'), ['name'], unique=False)
            batch_op.create_index(batch_op.f('ix_product_line_scheme_id'), ['scheme_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_product_line_status'), ['status'], unique=False)

        op.create_table('product_line_member',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('line_id', sa.String(length=36), nullable=False),
        sa.Column('product_id', sa.String(length=36), nullable=False),
        sa.Column('product_name', sa.String(length=160), nullable=False),
        sa.Column('joined_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('left_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=False),
        sa.Column('note', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('created_by', sa.String(length=36), nullable=False),
        sa.Column('created_by_name', sa.String(length=64), nullable=False),
        sa.Column('updated_by', sa.String(length=36), nullable=False),
        sa.Column('updated_by_name', sa.String(length=64), nullable=False),
        sa.Column('row_version', sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(['line_id'], ['product_line.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('product_line_member', schema=None) as batch_op:
            batch_op.create_index('ix_line_member_product', ['line_id', 'product_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_product_line_member_is_active'), ['is_active'], unique=False)
            batch_op.create_index(batch_op.f('ix_product_line_member_line_id'), ['line_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_product_line_member_product_id'), ['product_id'], unique=False)

        op.create_table('product_line_snapshot',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('line_id', sa.String(length=36), nullable=False),
        sa.Column('line_code', sa.String(length=64), nullable=False),
        sa.Column('line_name', sa.String(length=160), nullable=False),
        sa.Column('division_id', sa.String(length=36), nullable=True),
        sa.Column('scheme_id', sa.String(length=36), nullable=False),
        sa.Column('scheme_code', sa.String(length=32), nullable=False),
        sa.Column('selection_mode', sa.String(length=16), nullable=False),
        sa.Column('filters_json', sa.Text(), nullable=False),
        sa.Column('source_snapshot_count', sa.Integer(), nullable=False),
        sa.Column('effective_product_count', sa.Integer(), nullable=False),
        sa.Column('outlier_product_count', sa.Integer(), nullable=False),
        sa.Column('raw_issue_count', sa.Integer(), nullable=False),
        sa.Column('deduped_issue_count', sa.Integer(), nullable=False),
        sa.Column('core_deduction', sa.String(length=24), nullable=False),
        sa.Column('non_core_deduction', sa.String(length=24), nullable=False),
        sa.Column('total_deduction', sa.String(length=24), nullable=False),
        sa.Column('authoritative_uei', sa.String(length=24), nullable=False),
        sa.Column('weighted_average_uei', sa.String(length=24), nullable=False),
        sa.Column('bucket_uei', sa.String(length=24), nullable=False),
        sa.Column('sample_sufficient', sa.Boolean(), nullable=False),
        sa.Column('severity_counts_json', sa.Text(), nullable=False),
        sa.Column('product_scores_json', sa.Text(), nullable=False),
        sa.Column('calc_trace_json', sa.Text(), nullable=False),
        sa.Column('created_by', sa.String(length=36), nullable=False),
        sa.Column('created_by_name', sa.String(length=64), nullable=False),
        sa.Column('snapshot_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('product_line_snapshot', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_product_line_snapshot_division_id'), ['division_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_product_line_snapshot_line_id'), ['line_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_product_line_snapshot_snapshot_at'), ['snapshot_at'], unique=False)

        op.create_table('product_line_snapshot_source',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('snapshot_id', sa.String(length=36), nullable=False),
        sa.Column('product_id', sa.String(length=36), nullable=False),
        sa.Column('product_name', sa.String(length=160), nullable=False),
        sa.Column('version_code', sa.String(length=64), nullable=False),
        sa.Column('l1_snapshot_id', sa.String(length=36), nullable=False),
        sa.Column('l1_scheme_code', sa.String(length=32), nullable=False),
        sa.Column('l1_uei', sa.String(length=24), nullable=False),
        sa.Column('is_out_of_scope', sa.Boolean(), nullable=False),
        sa.Column('issue_count', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['snapshot_id'], ['product_line_snapshot.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('product_line_snapshot_source', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_product_line_snapshot_source_product_id'), ['product_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_product_line_snapshot_source_snapshot_id'), ['snapshot_id'], unique=False)


def downgrade() -> None:
    op.drop_table('product_line_snapshot_source')
    op.drop_table('product_line_snapshot')
    op.drop_table('product_line_member')
    op.drop_table('product_line')

