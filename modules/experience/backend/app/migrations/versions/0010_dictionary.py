"""T06 体验字典：导入批次/层级节点/检查项

Revision ID: 0010_dictionary
Revises: 0009_score_library
Create Date: 2026-10-16

本迁移由 SQLAlchemy 元数据确定性生成（autogenerate 后按任务拆分），
升级/降级均自包含，不依赖运行时模型定义。
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0010_dictionary"
down_revision: str | None = '0009_score_library'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
        op.create_table('dictionary_batch',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('source_path', sa.String(length=500), nullable=False),
        sa.Column('source_sha256', sa.String(length=64), nullable=False),
        sa.Column('source_size_bytes', sa.Integer(), nullable=False),
        sa.Column('source_modified_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('dry_run', sa.Boolean(), nullable=False),
        sa.Column('counts_json', sa.Text(), nullable=False),
        sa.Column('expected_json', sa.Text(), nullable=False),
        sa.Column('diff_json', sa.Text(), nullable=False),
        sa.Column('blocked_reason', sa.Text(), nullable=False),
        sa.Column('notes', sa.Text(), nullable=False),
        sa.Column('created_by_name', sa.String(length=64), nullable=False),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('dictionary_batch', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_dictionary_batch_status'), ['status'], unique=False)

        op.create_table('dictionary_node',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('dict_type', sa.String(length=24), nullable=False),
        sa.Column('batch_id', sa.String(length=36), nullable=True),
        sa.Column('parent_id', sa.String(length=36), nullable=True),
        sa.Column('level', sa.Integer(), nullable=False),
        sa.Column('path', sa.String(length=500), nullable=False),
        sa.Column('code', sa.String(length=64), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('order_no', sa.Integer(), nullable=False),
        sa.Column('severity', sa.String(length=20), nullable=False),
        sa.Column('deduction', sa.String(length=16), nullable=False),
        sa.Column('note', sa.Text(), nullable=False),
        sa.Column('source_standard', sa.String(length=255), nullable=False),
        sa.Column('example', sa.Text(), nullable=False),
        sa.Column('image_meta_json', sa.Text(), nullable=False),
        sa.Column('raw_json', sa.Text(), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False),
        sa.Column('reference_count', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['parent_id'], ['dictionary_node.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('dictionary_node', schema=None) as batch_op:
            batch_op.create_index('ix_dict_node_type_level', ['dict_type', 'level'], unique=False)
            batch_op.create_index(batch_op.f('ix_dictionary_node_batch_id'), ['batch_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_dictionary_node_code'), ['code'], unique=False)
            batch_op.create_index(batch_op.f('ix_dictionary_node_dict_type'), ['dict_type'], unique=False)
            batch_op.create_index(batch_op.f('ix_dictionary_node_is_active'), ['is_active'], unique=False)
            batch_op.create_index(batch_op.f('ix_dictionary_node_level'), ['level'], unique=False)
            batch_op.create_index(batch_op.f('ix_dictionary_node_parent_id'), ['parent_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_dictionary_node_path'), ['path'], unique=False)

        op.create_table('check_item',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('dict_type', sa.String(length=24), nullable=False),
        sa.Column('node_id', sa.String(length=36), nullable=False),
        sa.Column('batch_id', sa.String(length=36), nullable=True),
        sa.Column('item_no', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('description', sa.Text(), nullable=False),
        sa.Column('source_standard', sa.String(length=255), nullable=False),
        sa.Column('example', sa.Text(), nullable=False),
        sa.Column('image_meta_json', sa.Text(), nullable=False),
        sa.Column('severity', sa.String(length=20), nullable=False),
        sa.Column('deduction', sa.String(length=16), nullable=False),
        sa.Column('raw_json', sa.Text(), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False),
        sa.Column('reference_count', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['node_id'], ['dictionary_node.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
        )
        with op.batch_alter_table('check_item', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_check_item_batch_id'), ['batch_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_check_item_dict_type'), ['dict_type'], unique=False)
            batch_op.create_index(batch_op.f('ix_check_item_is_active'), ['is_active'], unique=False)
            batch_op.create_index(batch_op.f('ix_check_item_item_no'), ['item_no'], unique=False)
            batch_op.create_index(batch_op.f('ix_check_item_node_id'), ['node_id'], unique=False)
            batch_op.create_index('ix_check_item_unique', ['dict_type', 'node_id', 'item_no'], unique=True)


def downgrade() -> None:
    op.drop_table('check_item')
    op.drop_table('dictionary_node')
    op.drop_table('dictionary_batch')

