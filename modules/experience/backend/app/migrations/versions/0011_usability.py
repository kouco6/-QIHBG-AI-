"""T09 可用性研究：研究/参与者/任务/运行/SUS

Revision ID: 0011_usability
Revises: 0010_dictionary
Create Date: 2026-10-16

本迁移由 SQLAlchemy 元数据确定性生成（autogenerate 后按任务拆分），
升级/降级均自包含，不依赖运行时模型定义。
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0011_usability"
down_revision: str | None = '0010_dictionary'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
        op.create_table('usability_study',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('code', sa.String(length=32), nullable=False),
        sa.Column('project_id', sa.String(length=36), nullable=False),
        sa.Column('product_version_id', sa.String(length=36), nullable=True),
        sa.Column('version_code', sa.String(length=64), nullable=False),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('study_kind', sa.String(length=24), nullable=False),
        sa.Column('script_artifact_id', sa.String(length=36), nullable=True),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('not_applicable_reason', sa.Text(), nullable=False),
        sa.Column('report_artifact_id', sa.String(length=36), nullable=True),
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
        with op.batch_alter_table('usability_study', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_usability_study_code'), ['code'], unique=True)
            batch_op.create_index(batch_op.f('ix_usability_study_product_version_id'), ['product_version_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_usability_study_project_id'), ['project_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_usability_study_status'), ['status'], unique=False)
            batch_op.create_index(batch_op.f('ix_usability_study_study_kind'), ['study_kind'], unique=False)

        op.create_table('study_participant',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('study_id', sa.String(length=36), nullable=False),
        sa.Column('order_no', sa.Integer(), nullable=False),
        sa.Column('alias', sa.String(length=32), nullable=False),
        sa.Column('group_type', sa.String(length=16), nullable=False),
        sa.Column('is_valid', sa.Boolean(), nullable=False),
        sa.Column('exclusion_reason', sa.Text(), nullable=False),
        sa.Column('satisfaction', sa.Integer(), nullable=True),
        sa.Column('note', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['study_id'], ['usability_study.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('study_participant', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_study_participant_is_valid'), ['is_valid'], unique=False)
            batch_op.create_index(batch_op.f('ix_study_participant_study_id'), ['study_id'], unique=False)
            batch_op.create_index('ix_study_participant_unique', ['study_id', 'alias'], unique=True)

        op.create_table('study_task',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('study_id', sa.String(length=36), nullable=False),
        sa.Column('task_no', sa.Integer(), nullable=False),
        sa.Column('flow', sa.String(length=32), nullable=False),
        sa.Column('module', sa.String(length=120), nullable=False),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('expected', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['study_id'], ['usability_study.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('study_task', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_study_task_module'), ['module'], unique=False)
            batch_op.create_index(batch_op.f('ix_study_task_study_id'), ['study_id'], unique=False)

        op.create_table('task_run',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('study_id', sa.String(length=36), nullable=False),
        sa.Column('task_id', sa.String(length=36), nullable=False),
        sa.Column('participant_id', sa.String(length=36), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('duration_seconds', sa.Integer(), nullable=True),
        sa.Column('error_steps', sa.Text(), nullable=False),
        sa.Column('error_count', sa.Integer(), nullable=False),
        sa.Column('note', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['participant_id'], ['study_participant.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['task_id'], ['study_task.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('task_run', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_task_run_participant_id'), ['participant_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_task_run_status'), ['status'], unique=False)
            batch_op.create_index(batch_op.f('ix_task_run_study_id'), ['study_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_task_run_task_id'), ['task_id'], unique=False)
            batch_op.create_index('ix_task_run_unique', ['task_id', 'participant_id'], unique=True)

        # ### end Alembic commands ###

        op.create_table('sus_answer',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('study_id', sa.String(length=36), nullable=False),
        sa.Column('participant_id', sa.String(length=36), nullable=False),
        sa.Column('q1', sa.Integer(), nullable=True),
        sa.Column('q2', sa.Integer(), nullable=True),
        sa.Column('q3', sa.Integer(), nullable=True),
        sa.Column('q4', sa.Integer(), nullable=True),
        sa.Column('q5', sa.Integer(), nullable=True),
        sa.Column('q6', sa.Integer(), nullable=True),
        sa.Column('q7', sa.Integer(), nullable=True),
        sa.Column('q8', sa.Integer(), nullable=True),
        sa.Column('q9', sa.Integer(), nullable=True),
        sa.Column('q10', sa.Integer(), nullable=True),
        sa.Column('sus_score', sa.String(length=24), nullable=True),
        sa.Column('satisfaction', sa.Integer(), nullable=True),
        sa.Column('entered_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['participant_id'], ['study_participant.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('sus_answer', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_sus_answer_participant_id'), ['participant_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_sus_answer_study_id'), ['study_id'], unique=False)


def downgrade() -> None:
    op.drop_table('sus_answer')
    op.drop_table('task_run')
    op.drop_table('study_task')
    op.drop_table('study_participant')
    op.drop_table('usability_study')

