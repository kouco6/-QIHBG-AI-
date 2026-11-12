"""T07 统一问题、代录与评审三段式

Revision ID: 0005_issues_reviews
Revises: 0004_artifacts
Create Date: 2026-10-16

本迁移由 SQLAlchemy 元数据确定性生成（autogenerate 后按任务拆分），
升级/降级均自包含，不依赖运行时模型定义。
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0005_issues_reviews"
down_revision: str | None = '0004_artifacts'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
        op.create_table('issue',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('code', sa.String(length=32), nullable=False),
        sa.Column('project_id', sa.String(length=36), nullable=False),
        sa.Column('product_id', sa.String(length=36), nullable=True),
        sa.Column('product_version_id', sa.String(length=36), nullable=True),
        sa.Column('division_id', sa.String(length=36), nullable=True),
        sa.Column('module', sa.String(length=120), nullable=False),
        sa.Column('description', sa.Text(), nullable=False),
        sa.Column('business_level', sa.String(length=20), nullable=False),
        sa.Column('severity', sa.String(length=20), nullable=False),
        sa.Column('metric_l1', sa.String(length=120), nullable=False),
        sa.Column('metric_l2', sa.String(length=120), nullable=False),
        sa.Column('metric_l3', sa.String(length=120), nullable=False),
        sa.Column('check_item_no', sa.Integer(), nullable=True),
        sa.Column('issue_type', sa.String(length=32), nullable=False),
        sa.Column('owner_text', sa.String(length=64), nullable=False),
        sa.Column('status', sa.String(length=24), nullable=False),
        sa.Column('pre_business_level', sa.String(length=20), nullable=False),
        sa.Column('pre_severity', sa.String(length=20), nullable=False),
        sa.Column('final_business_level', sa.String(length=20), nullable=False),
        sa.Column('final_severity', sa.String(length=20), nullable=False),
        sa.Column('final_classified_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('final_classified_by', sa.String(length=64), nullable=False),
        sa.Column('division_reply', sa.Text(), nullable=False),
        sa.Column('solution', sa.Text(), nullable=False),
        sa.Column('committed_version', sa.String(length=64), nullable=False),
        sa.Column('actual_version', sa.String(length=64), nullable=False),
        sa.Column('first_replied_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('closed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('source_refs_json', sa.Text(), nullable=False),
        sa.Column('note', sa.Text(), nullable=False),
        sa.Column('reference_count', sa.Integer(), nullable=False),
        sa.Column('is_proxy', sa.Boolean(), nullable=False),
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
        with op.batch_alter_table('issue', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_issue_business_level'), ['business_level'], unique=False)
            batch_op.create_index(batch_op.f('ix_issue_code'), ['code'], unique=True)
            batch_op.create_index(batch_op.f('ix_issue_division_id'), ['division_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_issue_issue_type'), ['issue_type'], unique=False)
            batch_op.create_index(batch_op.f('ix_issue_module'), ['module'], unique=False)
            batch_op.create_index(batch_op.f('ix_issue_product_id'), ['product_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_issue_product_version_id'), ['product_version_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_issue_project_id'), ['project_id'], unique=False)
            batch_op.create_index('ix_issue_project_status', ['project_id', 'status'], unique=False)
            batch_op.create_index(batch_op.f('ix_issue_severity'), ['severity'], unique=False)
            batch_op.create_index(batch_op.f('ix_issue_status'), ['status'], unique=False)

        op.create_table('issue_transition',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('issue_id', sa.String(length=36), nullable=False),
        sa.Column('action', sa.String(length=32), nullable=False),
        sa.Column('from_status', sa.String(length=24), nullable=False),
        sa.Column('to_status', sa.String(length=24), nullable=False),
        sa.Column('reason', sa.Text(), nullable=False),
        sa.Column('detail_json', sa.Text(), nullable=False),
        sa.Column('actor_account_id', sa.String(length=36), nullable=False),
        sa.Column('actor_name', sa.String(length=64), nullable=False),
        sa.Column('request_id', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['issue_id'], ['issue.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('issue_transition', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_issue_transition_issue_id'), ['issue_id'], unique=False)

        op.create_table('proxy_record',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('target_type', sa.String(length=32), nullable=False),
        sa.Column('target_id', sa.String(length=36), nullable=False),
        sa.Column('field_key', sa.String(length=64), nullable=False),
        sa.Column('issue_id', sa.String(length=36), nullable=True),
        sa.Column('actual_provider', sa.String(length=64), nullable=False),
        sa.Column('provider_department', sa.String(length=64), nullable=False),
        sa.Column('proxy_by', sa.String(length=36), nullable=False),
        sa.Column('proxy_by_name', sa.String(length=64), nullable=False),
        sa.Column('proxy_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('source_note', sa.Text(), nullable=False),
        sa.Column('content_digest', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['issue_id'], ['issue.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('proxy_record', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_proxy_record_issue_id'), ['issue_id'], unique=False)
            batch_op.create_index('ix_proxy_record_target', ['target_type', 'target_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_proxy_record_target_id'), ['target_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_proxy_record_target_type'), ['target_type'], unique=False)

        op.create_table('issue_acceptance',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('issue_id', sa.String(length=36), nullable=False),
        sa.Column('result', sa.String(length=20), nullable=False),
        sa.Column('evidence', sa.Text(), nullable=False),
        sa.Column('reason', sa.Text(), nullable=False),
        sa.Column('tested_version', sa.String(length=64), nullable=False),
        sa.Column('actor_account_id', sa.String(length=36), nullable=False),
        sa.Column('actor_name', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['issue_id'], ['issue.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('issue_acceptance', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_issue_acceptance_issue_id'), ['issue_id'], unique=False)

        op.create_table('issue_evidence',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('issue_id', sa.String(length=36), nullable=False),
        sa.Column('kind', sa.String(length=32), nullable=False),
        sa.Column('file_name', sa.String(length=255), nullable=False),
        sa.Column('mime_type', sa.String(length=128), nullable=False),
        sa.Column('size_bytes', sa.Integer(), nullable=False),
        sa.Column('uri', sa.String(length=500), nullable=False),
        sa.Column('note', sa.Text(), nullable=False),
        sa.Column('created_by_name', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['issue_id'], ['issue.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('issue_evidence', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_issue_evidence_issue_id'), ['issue_id'], unique=False)

        op.create_table('review',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('code', sa.String(length=32), nullable=False),
        sa.Column('project_id', sa.String(length=36), nullable=False),
        sa.Column('node_code', sa.String(length=8), nullable=False),
        sa.Column('review_kind', sa.String(length=24), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('stage', sa.String(length=16), nullable=False),
        sa.Column('scope_locked_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('preliminary_snapshot_id', sa.String(length=36), nullable=True),
        sa.Column('preliminary_uei', sa.String(length=16), nullable=False),
        sa.Column('final_snapshot_id', sa.String(length=36), nullable=True),
        sa.Column('final_uei', sa.String(length=16), nullable=False),
        sa.Column('archived_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('archive_confirm_text', sa.String(length=120), nullable=False),
        sa.Column('conclusion', sa.Text(), nullable=False),
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
        with op.batch_alter_table('review', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_review_code'), ['code'], unique=True)
            batch_op.create_index(batch_op.f('ix_review_node_code'), ['node_code'], unique=False)
            batch_op.create_index(batch_op.f('ix_review_project_id'), ['project_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_review_review_kind'), ['review_kind'], unique=False)
            batch_op.create_index(batch_op.f('ix_review_stage'), ['stage'], unique=False)

        op.create_table('review_decision',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('review_id', sa.String(length=36), nullable=False),
        sa.Column('issue_id', sa.String(length=36), nullable=True),
        sa.Column('issue_code', sa.String(length=32), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('dispute', sa.Text(), nullable=False),
        sa.Column('discussion', sa.Text(), nullable=False),
        sa.Column('decision', sa.Text(), nullable=False),
        sa.Column('solution', sa.Text(), nullable=False),
        sa.Column('committed_version', sa.String(length=64), nullable=False),
        sa.Column('owner_text', sa.String(length=64), nullable=False),
        sa.Column('business_level_after', sa.String(length=20), nullable=False),
        sa.Column('severity_after', sa.String(length=20), nullable=False),
        sa.Column('created_by_name', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['review_id'], ['review.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('review_decision', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_review_decision_issue_id'), ['issue_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_review_decision_review_id'), ['review_id'], unique=False)
            batch_op.create_index('ix_review_decision_review_status', ['review_id', 'status'], unique=False)
            batch_op.create_index(batch_op.f('ix_review_decision_status'), ['status'], unique=False)

        op.create_table('review_signature',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('review_id', sa.String(length=36), nullable=False),
        sa.Column('department', sa.String(length=64), nullable=False),
        sa.Column('principal', sa.String(length=64), nullable=False),
        sa.Column('members', sa.String(length=255), nullable=False),
        sa.Column('opinion', sa.Text(), nullable=False),
        sa.Column('is_approved', sa.Boolean(), nullable=False),
        sa.Column('is_proxy', sa.Boolean(), nullable=False),
        sa.Column('actual_provider', sa.String(length=64), nullable=False),
        sa.Column('proxy_by', sa.String(length=36), nullable=False),
        sa.Column('proxy_by_name', sa.String(length=64), nullable=False),
        sa.Column('proxy_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['review_id'], ['review.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('review_signature', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_review_signature_review_id'), ['review_id'], unique=False)
            batch_op.create_index('ix_review_signature_unique', ['review_id', 'department'], unique=True)


def downgrade() -> None:
    op.drop_table('review_signature')
    op.drop_table('review_decision')
    op.drop_table('review')
    op.drop_table('issue_evidence')
    op.drop_table('issue_acceptance')
    op.drop_table('proxy_record')
    op.drop_table('issue_transition')
    op.drop_table('issue')

