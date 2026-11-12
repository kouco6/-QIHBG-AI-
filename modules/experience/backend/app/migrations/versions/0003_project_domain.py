"""T04 项目域：事业部/产品/版本/项目/13节点实例

Revision ID: 0003_project_domain
Revises: 0002_accounts_auth
Create Date: 2026-10-16

本迁移由 SQLAlchemy 元数据确定性生成（autogenerate 后按任务拆分），
升级/降级均自包含，不依赖运行时模型定义。
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0003_project_domain"
down_revision: str | None = '0002_accounts_auth'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
        op.create_table('division',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('code', sa.String(length=64), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('owner_text', sa.String(length=64), nullable=False),
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
        with op.batch_alter_table('division', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_division_code'), ['code'], unique=True)
            batch_op.create_index(batch_op.f('ix_division_status'), ['status'], unique=False)

        op.create_table('product',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('code', sa.String(length=64), nullable=False),
        sa.Column('name', sa.String(length=160), nullable=False),
        sa.Column('division_id', sa.String(length=36), nullable=True),
        sa.Column('category', sa.String(length=64), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('note', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('created_by', sa.String(length=36), nullable=False),
        sa.Column('created_by_name', sa.String(length=64), nullable=False),
        sa.Column('updated_by', sa.String(length=36), nullable=False),
        sa.Column('updated_by_name', sa.String(length=64), nullable=False),
        sa.Column('row_version', sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(['division_id'], ['division.id'], ondelete='RESTRICT'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('product', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_product_code'), ['code'], unique=True)
            batch_op.create_index(batch_op.f('ix_product_division_id'), ['division_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_product_name'), ['name'], unique=False)

        op.create_table('product_version',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('product_id', sa.String(length=36), nullable=False),
        sa.Column('version_code', sa.String(length=64), nullable=False),
        sa.Column('released_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('is_current', sa.Boolean(), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('note', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('created_by', sa.String(length=36), nullable=False),
        sa.Column('created_by_name', sa.String(length=64), nullable=False),
        sa.Column('updated_by', sa.String(length=36), nullable=False),
        sa.Column('updated_by_name', sa.String(length=64), nullable=False),
        sa.Column('row_version', sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(['product_id'], ['product.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('product_version', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_product_version_product_id'), ['product_id'], unique=False)
            batch_op.create_index('ix_product_version_unique', ['product_id', 'version_code'], unique=True)
            batch_op.create_index(batch_op.f('ix_product_version_version_code'), ['version_code'], unique=False)

        op.create_table('project',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('code', sa.String(length=64), nullable=False),
        sa.Column('name', sa.String(length=160), nullable=False),
        sa.Column('product_id', sa.String(length=36), nullable=False),
        sa.Column('product_version_id', sa.String(length=36), nullable=True),
        sa.Column('division_id', sa.String(length=36), nullable=True),
        sa.Column('project_type', sa.String(length=20), nullable=False),
        sa.Column('owner_text', sa.String(length=64), nullable=False),
        sa.Column('members_text', sa.Text(), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('description', sa.Text(), nullable=False),
        sa.Column('core_business_involved', sa.Boolean(), nullable=True),
        sa.Column('core_business_reason', sa.Text(), nullable=False),
        sa.Column('core_business_confirmed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('closed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('created_by', sa.String(length=36), nullable=False),
        sa.Column('created_by_name', sa.String(length=64), nullable=False),
        sa.Column('updated_by', sa.String(length=36), nullable=False),
        sa.Column('updated_by_name', sa.String(length=64), nullable=False),
        sa.Column('row_version', sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(['division_id'], ['division.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['product_id'], ['product.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['product_version_id'], ['product_version.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('project', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_project_code'), ['code'], unique=True)
            batch_op.create_index(batch_op.f('ix_project_division_id'), ['division_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_project_name'), ['name'], unique=False)
            batch_op.create_index(batch_op.f('ix_project_product_id'), ['product_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_project_product_version_id'), ['product_version_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_project_project_type'), ['project_type'], unique=False)
            batch_op.create_index(batch_op.f('ix_project_status'), ['status'], unique=False)

        op.create_table('workflow_node',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('project_id', sa.String(length=36), nullable=False),
        sa.Column('code', sa.String(length=8), nullable=False),
        sa.Column('node_order', sa.Integer(), nullable=False),
        sa.Column('stage_code', sa.String(length=8), nullable=False),
        sa.Column('name', sa.String(length=64), nullable=False),
        sa.Column('scope', sa.String(length=64), nullable=False),
        sa.Column('duration_days', sa.Integer(), nullable=False),
        sa.Column('outputs_text', sa.String(length=255), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('allow_not_applicable', sa.Boolean(), nullable=False),
        sa.Column('iteration_only', sa.Boolean(), nullable=False),
        sa.Column('planned_start_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('planned_end_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('actual_start_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('actual_end_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('not_applicable_reason', sa.Text(), nullable=False),
        sa.Column('note', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('created_by', sa.String(length=36), nullable=False),
        sa.Column('created_by_name', sa.String(length=64), nullable=False),
        sa.Column('updated_by', sa.String(length=36), nullable=False),
        sa.Column('updated_by_name', sa.String(length=64), nullable=False),
        sa.Column('row_version', sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(['project_id'], ['project.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('workflow_node', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_workflow_node_code'), ['code'], unique=False)
            batch_op.create_index('ix_workflow_node_project_code', ['project_id', 'code'], unique=True)
            batch_op.create_index(batch_op.f('ix_workflow_node_project_id'), ['project_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_workflow_node_status'), ['status'], unique=False)

        op.create_table('workflow_node_event',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('node_id', sa.String(length=36), nullable=False),
        sa.Column('project_id', sa.String(length=36), nullable=False),
        sa.Column('action', sa.String(length=32), nullable=False),
        sa.Column('from_status', sa.String(length=20), nullable=False),
        sa.Column('to_status', sa.String(length=20), nullable=False),
        sa.Column('reason', sa.Text(), nullable=False),
        sa.Column('actor_account_id', sa.String(length=36), nullable=False),
        sa.Column('actor_name', sa.String(length=64), nullable=False),
        sa.Column('request_id', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['node_id'], ['workflow_node.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('workflow_node_event', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_workflow_node_event_node_id'), ['node_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_workflow_node_event_project_id'), ['project_id'], unique=False)


def downgrade() -> None:
    op.drop_table('workflow_node_event')
    op.drop_table('workflow_node')
    op.drop_table('project')
    op.drop_table('product_version')
    op.drop_table('product')
    op.drop_table('division')

