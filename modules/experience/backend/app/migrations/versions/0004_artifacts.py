"""T05 结构化产物：模板/产物/产物版本

Revision ID: 0004_artifacts
Revises: 0003_project_domain
Create Date: 2026-10-16

本迁移由 SQLAlchemy 元数据确定性生成（autogenerate 后按任务拆分），
升级/降级均自包含，不依赖运行时模型定义。
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0004_artifacts"
down_revision: str | None = '0003_project_domain'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
        op.create_table('artifact_template',
        sa.Column('kind', sa.String(length=64), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('node_code', sa.String(length=8), nullable=False),
        sa.Column('allow_not_applicable', sa.Boolean(), nullable=False),
        sa.Column('description', sa.Text(), nullable=False),
        sa.Column('schema_json', sa.Text(), nullable=False),
        sa.Column('template_version', sa.Integer(), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.PrimaryKeyConstraint('kind')
        )
        with op.batch_alter_table('artifact_template', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_artifact_template_node_code'), ['node_code'], unique=False)

        op.create_table('artifact',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('project_id', sa.String(length=36), nullable=False),
        sa.Column('node_id', sa.String(length=36), nullable=False),
        sa.Column('node_code', sa.String(length=8), nullable=False),
        sa.Column('kind', sa.String(length=64), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('current_version_no', sa.Integer(), nullable=False),
        sa.Column('collaborators_text', sa.Text(), nullable=False),
        sa.Column('not_applicable_reason', sa.Text(), nullable=False),
        sa.Column('last_saved_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('submitted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('confirmed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('created_by', sa.String(length=36), nullable=False),
        sa.Column('created_by_name', sa.String(length=64), nullable=False),
        sa.Column('updated_by', sa.String(length=36), nullable=False),
        sa.Column('updated_by_name', sa.String(length=64), nullable=False),
        sa.Column('row_version', sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(['node_id'], ['workflow_node.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['project_id'], ['project.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('artifact', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_artifact_kind'), ['kind'], unique=False)
            batch_op.create_index(batch_op.f('ix_artifact_node_code'), ['node_code'], unique=False)
            batch_op.create_index(batch_op.f('ix_artifact_node_id'), ['node_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_artifact_project_id'), ['project_id'], unique=False)
            batch_op.create_index('ix_artifact_project_kind', ['project_id', 'kind'], unique=False)
            batch_op.create_index(batch_op.f('ix_artifact_status'), ['status'], unique=False)

        op.create_table('artifact_version',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('artifact_id', sa.String(length=36), nullable=False),
        sa.Column('version_no', sa.Integer(), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('payload_json', sa.Text(), nullable=False),
        sa.Column('is_frozen', sa.Boolean(), nullable=False),
        sa.Column('change_note', sa.Text(), nullable=False),
        sa.Column('source_version_no', sa.Integer(), nullable=True),
        sa.Column('issue_ids_json', sa.Text(), nullable=False),
        sa.Column('created_by', sa.String(length=36), nullable=False),
        sa.Column('created_by_name', sa.String(length=64), nullable=False),
        sa.Column('request_id', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['artifact_id'], ['artifact.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('artifact_version', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_artifact_version_artifact_id'), ['artifact_id'], unique=False)
            batch_op.create_index('ix_artifact_version_unique', ['artifact_id', 'version_no'], unique=True)


def downgrade() -> None:
    op.drop_table('artifact_version')
    op.drop_table('artifact')
    op.drop_table('artifact_template')

