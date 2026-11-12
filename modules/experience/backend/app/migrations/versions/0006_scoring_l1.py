"""T08 UEI 评分方案、矩阵单元与 L1 快照

Revision ID: 0006_scoring_l1
Revises: 0005_issues_reviews
Create Date: 2026-10-16

本迁移由 SQLAlchemy 元数据确定性生成（autogenerate 后按任务拆分），
升级/降级均自包含，不依赖运行时模型定义。
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0006_scoring_l1"
down_revision: str | None = '0005_issues_reviews'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
        op.create_table('scoring_scheme',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('code', sa.String(length=32), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('business_ratio', sa.String(length=16), nullable=False),
        sa.Column('problem_ratio', sa.String(length=32), nullable=False),
        sa.Column('scheme_version', sa.Integer(), nullable=False),
        sa.Column('is_default', sa.Boolean(), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False),
        sa.Column('is_builtin', sa.Boolean(), nullable=False),
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
        with op.batch_alter_table('scoring_scheme', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_scoring_scheme_business_ratio'), ['business_ratio'], unique=False)
            batch_op.create_index(batch_op.f('ix_scoring_scheme_code'), ['code'], unique=True)
            batch_op.create_index(batch_op.f('ix_scoring_scheme_is_active'), ['is_active'], unique=False)
            batch_op.create_index(batch_op.f('ix_scoring_scheme_is_default'), ['is_default'], unique=False)
            batch_op.create_index(batch_op.f('ix_scoring_scheme_problem_ratio'), ['problem_ratio'], unique=False)

        op.create_table('scoring_scheme_cell',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('scheme_id', sa.String(length=36), nullable=False),
        sa.Column('cell_key', sa.String(length=32), nullable=False),
        sa.Column('business_level', sa.String(length=20), nullable=False),
        sa.Column('severity', sa.String(length=20), nullable=False),
        sa.Column('cell_order', sa.Integer(), nullable=False),
        sa.Column('deduction', sa.String(length=16), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['scheme_id'], ['scoring_scheme.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('scoring_scheme_cell', schema=None) as batch_op:
            batch_op.create_index('ix_scoring_cell_unique', ['scheme_id', 'cell_key'], unique=True)
            batch_op.create_index(batch_op.f('ix_scoring_scheme_cell_cell_key'), ['cell_key'], unique=False)
            batch_op.create_index(batch_op.f('ix_scoring_scheme_cell_scheme_id'), ['scheme_id'], unique=False)

        op.create_table('product_score_snapshot',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('scope', sa.String(length=20), nullable=False),
        sa.Column('project_id', sa.String(length=36), nullable=True),
        sa.Column('product_id', sa.String(length=36), nullable=False),
        sa.Column('product_version_id', sa.String(length=36), nullable=True),
        sa.Column('product_name', sa.String(length=160), nullable=False),
        sa.Column('version_code', sa.String(length=64), nullable=False),
        sa.Column('division_id', sa.String(length=36), nullable=True),
        sa.Column('scheme_id', sa.String(length=36), nullable=False),
        sa.Column('scheme_code', sa.String(length=32), nullable=False),
        sa.Column('scheme_business_ratio', sa.String(length=16), nullable=False),
        sa.Column('scheme_problem_ratio', sa.String(length=32), nullable=False),
        sa.Column('issue_count', sa.Integer(), nullable=False),
        sa.Column('core_issue_count', sa.Integer(), nullable=False),
        sa.Column('non_core_issue_count', sa.Integer(), nullable=False),
        sa.Column('severity_counts_json', sa.Text(), nullable=False),
        sa.Column('core_deduction', sa.String(length=24), nullable=False),
        sa.Column('non_core_deduction', sa.String(length=24), nullable=False),
        sa.Column('total_deduction', sa.String(length=24), nullable=False),
        sa.Column('raw_uei', sa.String(length=24), nullable=False),
        sa.Column('display_uei', sa.String(length=24), nullable=False),
        sa.Column('clamp_zero', sa.Boolean(), nullable=False),
        sa.Column('is_effective', sa.Boolean(), nullable=False),
        sa.Column('input_manifest_json', sa.Text(), nullable=False),
        sa.Column('calc_trace_json', sa.Text(), nullable=False),
        sa.Column('created_by', sa.String(length=36), nullable=False),
        sa.Column('created_by_name', sa.String(length=64), nullable=False),
        sa.Column('snapshot_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('product_score_snapshot', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_product_score_snapshot_division_id'), ['division_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_product_score_snapshot_is_effective'), ['is_effective'], unique=False)
            batch_op.create_index(batch_op.f('ix_product_score_snapshot_product_id'), ['product_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_product_score_snapshot_product_version_id'), ['product_version_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_product_score_snapshot_project_id'), ['project_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_product_score_snapshot_scheme_id'), ['scheme_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_product_score_snapshot_scope'), ['scope'], unique=False)
            batch_op.create_index(batch_op.f('ix_product_score_snapshot_snapshot_at'), ['snapshot_at'], unique=False)

        op.create_table('snapshot_issue',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('snapshot_id', sa.String(length=36), nullable=False),
        sa.Column('issue_id', sa.String(length=36), nullable=False),
        sa.Column('issue_code', sa.String(length=32), nullable=False),
        sa.Column('business_level', sa.String(length=20), nullable=False),
        sa.Column('severity', sa.String(length=20), nullable=False),
        sa.Column('cell_key', sa.String(length=32), nullable=False),
        sa.Column('deduction', sa.String(length=16), nullable=False),
        sa.Column('module', sa.String(length=120), nullable=False),
        sa.Column('metric_l1', sa.String(length=120), nullable=False),
        sa.Column('metric_l2', sa.String(length=120), nullable=False),
        sa.Column('description_digest', sa.String(length=255), nullable=False),
        sa.Column('source_snapshot_id', sa.String(length=36), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['snapshot_id'], ['product_score_snapshot.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('snapshot_issue', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_snapshot_issue_issue_id'), ['issue_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_snapshot_issue_snapshot_id'), ['snapshot_id'], unique=False)
            batch_op.create_index('ix_snapshot_issue_unique', ['snapshot_id', 'issue_id'], unique=True)


def downgrade() -> None:
    op.drop_table('snapshot_issue')
    op.drop_table('product_score_snapshot')
    op.drop_table('scoring_scheme_cell')
    op.drop_table('scoring_scheme')

