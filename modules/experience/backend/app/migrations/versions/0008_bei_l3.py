"""T11 BEI 阈值版本、指标值与季度评价

Revision ID: 0008_bei_l3
Revises: 0007_product_lines_l2
Create Date: 2026-10-16

本迁移由 SQLAlchemy 元数据确定性生成（autogenerate 后按任务拆分），
升级/降级均自包含，不依赖运行时模型定义。
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0008_bei_l3"
down_revision: str | None = '0007_product_lines_l2'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
        op.create_table('bei_threshold_version',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('version_label', sa.String(length=32), nullable=False),
        sa.Column('source_ref', sa.String(length=255), nullable=False),
        sa.Column('source_note', sa.Text(), nullable=False),
        sa.Column('status_label', sa.String(length=32), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False),
        sa.Column('weights_json', sa.Text(), nullable=False),
        sa.Column('created_by_name', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('bei_threshold_version', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_bei_threshold_version_is_active'), ['is_active'], unique=False)
            batch_op.create_index(batch_op.f('ix_bei_threshold_version_status'), ['status'], unique=False)
            batch_op.create_index(batch_op.f('ix_bei_threshold_version_version_label'), ['version_label'], unique=True)

        op.create_table('bei_threshold_item',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('version_id', sa.String(length=36), nullable=False),
        sa.Column('metric_key', sa.String(length=64), nullable=False),
        sa.Column('item_order', sa.Integer(), nullable=False),
        sa.Column('dimension', sa.String(length=8), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('unit', sa.String(length=24), nullable=False),
        sa.Column('direction', sa.String(length=20), nullable=False),
        sa.Column('full_line', sa.String(length=24), nullable=True),
        sa.Column('pass_line', sa.String(length=24), nullable=True),
        sa.Column('zero_line', sa.String(length=24), nullable=True),
        sa.Column('is_scoring', sa.Boolean(), nullable=False),
        sa.Column('source_field', sa.String(length=255), nullable=False),
        sa.Column('drill_down', sa.String(length=255), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['version_id'], ['bei_threshold_version.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('bei_threshold_item', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_bei_threshold_item_metric_key'), ['metric_key'], unique=False)
            batch_op.create_index('ix_bei_threshold_item_unique', ['version_id', 'metric_key'], unique=True)
            batch_op.create_index(batch_op.f('ix_bei_threshold_item_version_id'), ['version_id'], unique=False)

        op.create_table('division_evaluation',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('division_id', sa.String(length=36), nullable=False),
        sa.Column('division_name', sa.String(length=120), nullable=False),
        sa.Column('period', sa.String(length=16), nullable=False),
        sa.Column('threshold_version_id', sa.String(length=36), nullable=False),
        sa.Column('threshold_version_label', sa.String(length=32), nullable=False),
        sa.Column('status', sa.String(length=24), nullable=False),
        sa.Column('issue_count', sa.Integer(), nullable=False),
        sa.Column('sample_sufficient', sa.Boolean(), nullable=False),
        sa.Column('participating_product_count', sa.Integer(), nullable=False),
        sa.Column('d1_score', sa.String(length=24), nullable=True),
        sa.Column('d2_score', sa.String(length=24), nullable=True),
        sa.Column('d3_score', sa.String(length=24), nullable=True),
        sa.Column('d4_score', sa.String(length=24), nullable=True),
        sa.Column('d5_score', sa.String(length=24), nullable=True),
        sa.Column('active_dimensions_json', sa.Text(), nullable=False),
        sa.Column('rescaled_weights_json', sa.Text(), nullable=False),
        sa.Column('auto_score', sa.String(length=24), nullable=True),
        sa.Column('auto_weight', sa.String(length=16), nullable=False),
        sa.Column('manual_weight', sa.String(length=16), nullable=False),
        sa.Column('combined_score', sa.String(length=24), nullable=True),
        sa.Column('grade', sa.String(length=16), nullable=True),
        sa.Column('finalized_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('finalized_by_name', sa.String(length=64), nullable=False),
        sa.Column('calc_trace_json', sa.Text(), nullable=False),
        sa.Column('disclaimer', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('created_by', sa.String(length=36), nullable=False),
        sa.Column('created_by_name', sa.String(length=64), nullable=False),
        sa.Column('updated_by', sa.String(length=36), nullable=False),
        sa.Column('updated_by_name', sa.String(length=64), nullable=False),
        sa.Column('row_version', sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('division_evaluation', schema=None) as batch_op:
            batch_op.create_index('ix_division_eval_unique', ['division_id', 'period', 'threshold_version_id'], unique=True)
            batch_op.create_index(batch_op.f('ix_division_evaluation_division_id'), ['division_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_division_evaluation_grade'), ['grade'], unique=False)
            batch_op.create_index(batch_op.f('ix_division_evaluation_period'), ['period'], unique=False)
            batch_op.create_index(batch_op.f('ix_division_evaluation_status'), ['status'], unique=False)
            batch_op.create_index(batch_op.f('ix_division_evaluation_threshold_version_id'), ['threshold_version_id'], unique=False)

        op.create_table('bei_metric_value',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('evaluation_id', sa.String(length=36), nullable=False),
        sa.Column('metric_key', sa.String(length=64), nullable=False),
        sa.Column('dimension', sa.String(length=8), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('unit', sa.String(length=24), nullable=False),
        sa.Column('direction', sa.String(length=20), nullable=False),
        sa.Column('is_scoring', sa.Boolean(), nullable=False),
        sa.Column('raw_value', sa.String(length=24), nullable=True),
        sa.Column('normalized', sa.String(length=24), nullable=True),
        sa.Column('has_data', sa.Boolean(), nullable=False),
        sa.Column('blocks_json', sa.Text(), nullable=False),
        sa.Column('drill_json', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['evaluation_id'], ['division_evaluation.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('bei_metric_value', schema=None) as batch_op:
            batch_op.create_index('ix_bei_metric_unique', ['evaluation_id', 'metric_key'], unique=True)
            batch_op.create_index(batch_op.f('ix_bei_metric_value_dimension'), ['dimension'], unique=False)
            batch_op.create_index(batch_op.f('ix_bei_metric_value_evaluation_id'), ['evaluation_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_bei_metric_value_metric_key'), ['metric_key'], unique=False)

        op.create_table('bei_manual_score',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('evaluation_id', sa.String(length=36), nullable=False),
        sa.Column('score', sa.String(length=24), nullable=False),
        sa.Column('weight', sa.String(length=16), nullable=False),
        sa.Column('reason', sa.Text(), nullable=False),
        sa.Column('basis', sa.Text(), nullable=False),
        sa.Column('entered_by', sa.String(length=64), nullable=False),
        sa.Column('entered_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['evaluation_id'], ['division_evaluation.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('bei_manual_score', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_bei_manual_score_evaluation_id'), ['evaluation_id'], unique=False)


def downgrade() -> None:
    op.drop_table('bei_manual_score')
    op.drop_table('bei_metric_value')
    op.drop_table('division_evaluation')
    op.drop_table('bei_threshold_item')
    op.drop_table('bei_threshold_version')

