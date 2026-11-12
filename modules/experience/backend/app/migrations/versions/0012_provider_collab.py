"""T13 Provider 作业、协作空间与 AI 会话

Revision ID: 0012_provider_collab
Revises: 0011_usability
Create Date: 2026-10-16

本迁移由 SQLAlchemy 元数据确定性生成（autogenerate 后按任务拆分），
升级/降级均自包含，不依赖运行时模型定义。
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0012_provider_collab"
down_revision: str | None = '0011_usability'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
        op.create_table('provider_config',
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('configured', sa.Boolean(), nullable=False),
        sa.Column('configured_mode', sa.String(length=8), nullable=False),
        sa.Column('effective_mode', sa.String(length=8), nullable=False),
        sa.Column('endpoint_label', sa.String(length=120), nullable=False),
        sa.Column('last_tested_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_test_result', sa.String(length=255), nullable=False),
        sa.Column('capability_note', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.PrimaryKeyConstraint('kind')
        )

        op.create_table('provider_job',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('provider_kind', sa.String(length=16), nullable=False),
        sa.Column('job_type', sa.String(length=32), nullable=False),
        sa.Column('mode', sa.String(length=8), nullable=False),
        sa.Column('idempotency_key', sa.String(length=160), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('target_type', sa.String(length=32), nullable=False),
        sa.Column('target_id', sa.String(length=36), nullable=False),
        sa.Column('project_id', sa.String(length=36), nullable=True),
        sa.Column('payload_json', sa.Text(), nullable=False),
        sa.Column('progress', sa.Integer(), nullable=False),
        sa.Column('retry_count', sa.Integer(), nullable=False),
        sa.Column('max_retries', sa.Integer(), nullable=False),
        sa.Column('retry_of', sa.String(length=36), nullable=True),
        sa.Column('failure_reason', sa.Text(), nullable=False),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_by', sa.String(length=36), nullable=False),
        sa.Column('created_by_name', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('provider_job', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_provider_job_idempotency_key'), ['idempotency_key'], unique=True)
            batch_op.create_index(batch_op.f('ix_provider_job_job_type'), ['job_type'], unique=False)
            batch_op.create_index(batch_op.f('ix_provider_job_mode'), ['mode'], unique=False)
            batch_op.create_index(batch_op.f('ix_provider_job_project_id'), ['project_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_provider_job_provider_kind'), ['provider_kind'], unique=False)
            batch_op.create_index(batch_op.f('ix_provider_job_status'), ['status'], unique=False)
            batch_op.create_index(batch_op.f('ix_provider_job_target_id'), ['target_id'], unique=False)

        op.create_table('provider_receipt',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('job_id', sa.String(length=36), nullable=False),
        sa.Column('external_id', sa.String(length=120), nullable=False),
        sa.Column('is_mock', sa.Boolean(), nullable=False),
        sa.Column('code', sa.String(length=32), nullable=False),
        sa.Column('message', sa.String(length=255), nullable=False),
        sa.Column('body_json', sa.Text(), nullable=False),
        sa.Column('received_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['job_id'], ['provider_job.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('provider_receipt', schema=None) as batch_op:
            batch_op.create_index('ix_provider_receipt_job', ['job_id', 'received_at'], unique=False)
            batch_op.create_index(batch_op.f('ix_provider_receipt_job_id'), ['job_id'], unique=False)

        op.create_table('collaboration_thread',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('project_id', sa.String(length=36), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('node_code', sa.String(length=8), nullable=False),
        sa.Column('ref_type', sa.String(length=24), nullable=False),
        sa.Column('ref_id', sa.String(length=36), nullable=False),
        sa.Column('started_by', sa.String(length=36), nullable=False),
        sa.Column('started_by_name', sa.String(length=64), nullable=False),
        sa.Column('reply_count', sa.Integer(), nullable=False),
        sa.Column('last_reply_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('members_text', sa.String(length=255), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['project_id'], ['project.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('collaboration_thread', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_collaboration_thread_project_id'), ['project_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_collaboration_thread_status'), ['status'], unique=False)

        op.create_table('collaboration_message',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('thread_id', sa.String(length=36), nullable=False),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('ref_type', sa.String(length=24), nullable=False),
        sa.Column('ref_id', sa.String(length=36), nullable=False),
        sa.Column('ref_label', sa.String(length=200), nullable=False),
        sa.Column('is_proxy', sa.Boolean(), nullable=False),
        sa.Column('actual_provider', sa.String(length=64), nullable=False),
        sa.Column('author_id', sa.String(length=36), nullable=False),
        sa.Column('author_name', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['thread_id'], ['collaboration_thread.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('collaboration_message', schema=None) as batch_op:
            batch_op.create_index('ix_collab_message_thread', ['thread_id', 'created_at'], unique=False)
            batch_op.create_index(batch_op.f('ix_collaboration_message_thread_id'), ['thread_id'], unique=False)

        op.create_table('ai_conversation',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('project_id', sa.String(length=36), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('scope_type', sa.String(length=16), nullable=False),
        sa.Column('scope_json', sa.Text(), nullable=False),
        sa.Column('template_key', sa.String(length=32), nullable=False),
        sa.Column('provider_kind', sa.String(length=16), nullable=False),
        sa.Column('mode', sa.String(length=8), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('message_count', sa.Integer(), nullable=False),
        sa.Column('last_message_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['project_id'], ['project.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('ai_conversation', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_ai_conversation_project_id'), ['project_id'], unique=False)

        op.create_table('ai_message',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('conversation_id', sa.String(length=36), nullable=False),
        sa.Column('role', sa.String(length=16), nullable=False),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('refs_json', sa.Text(), nullable=False),
        sa.Column('job_id', sa.String(length=36), nullable=True),
        sa.Column('is_mock', sa.Boolean(), nullable=False),
        sa.Column('author_name', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['conversation_id'], ['ai_conversation.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('ai_message', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_ai_message_conversation_id'), ['conversation_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_ai_message_job_id'), ['job_id'], unique=False)


def downgrade() -> None:
    op.drop_table('ai_message')
    op.drop_table('ai_conversation')
    op.drop_table('collaboration_message')
    op.drop_table('collaboration_thread')
    op.drop_table('provider_receipt')
    op.drop_table('provider_job')
    op.drop_table('provider_config')

