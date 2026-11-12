"""v1.1 层级合并：产品线 → 系统，项目直挂系统，产品/产品版本层取消。

变更：

- ``product_line`` → ``system``（id/数据保留）；
- ``project``：新增 ``system_id``（由 product→line 成员关系回填）、``version_code``（由
  product_version 回填）、``weight``（默认 "1"）；删除 ``product_id``/``product_version_id``；
- L1/L2 快照表整体重建（演示数据，历史快照不保留）：
  ``product_score_snapshot`` → ``project_score_snapshot``、``snapshot_issue`` 重建（FK 指向新表）、
  ``product_line_snapshot`` → ``system_snapshot``、``product_line_snapshot_source`` → ``system_snapshot_source``；
- ``issue``：``product_id`` → ``system_id``（由项目回填），删除 ``product_version_id``；
- ``score_library``：``product_id``/``product_line_id`` → ``project_id``/``system_id``；
- ``usability_study``：删除 ``product_version_id``；
- 删除 ``product``、``product_version``、``product_line_member`` 表。

Revision ID: 0013_system_merge
Revises: 0012_provider_collab
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0013_system_merge"
down_revision: str | None = "0012_provider_collab"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    # 0. 迁移期间关闭外键强制（SQLite 连接级）
    op.execute("PRAGMA foreign_keys=OFF")

    # 1. 预删将被改名/删除列上的索引
    for idx in (
        "ix_issue_product_id",
        "ix_issue_product_version_id",
        "ix_score_library_product_id",
        "ix_score_library_product_line_id",
        "ix_usability_study_product_version_id",
        "ix_project_product_id",
        "ix_project_product_version_id",
    ):
        op.execute(f"DROP INDEX IF EXISTS {idx}")

    # 2. 旧快照表直接删除（演示数据，不保留历史快照）
    op.execute("DROP TABLE IF EXISTS product_line_snapshot_source")
    op.execute("DROP TABLE IF EXISTS product_line_snapshot")
    op.execute("DROP TABLE IF EXISTS snapshot_issue")
    op.execute("DROP TABLE IF EXISTS product_score_snapshot")

    # 3. product_line → system（结构相同，仅表名）
    op.rename_table("product_line", "system")

    # 4. project：加列 + 回填
    op.add_column("project", sa.Column("system_id", sa.String(36), nullable=True))
    op.add_column("project", sa.Column("version_code", sa.String(64), nullable=False, server_default=""))
    op.add_column("project", sa.Column("weight", sa.String(16), nullable=False, server_default="1"))
    conn.execute(
        sa.text(
            """
            UPDATE project
            SET version_code = COALESCE(
                (SELECT pv.version_code FROM product_version pv WHERE pv.id = project.product_version_id),
                ''
            )
            """
        )
    )
    conn.execute(
        sa.text(
            """
            UPDATE project
            SET system_id = (
                SELECT m.line_id FROM product_line_member m
                WHERE m.product_id = project.product_id AND m.is_active = 1
                ORDER BY m.joined_at DESC LIMIT 1
            )
            WHERE project.system_id IS NULL
            """
        )
    )
    conn.execute(
        sa.text(
            """
            UPDATE project
            SET system_id = (SELECT s.id FROM system s WHERE s.division_id = project.division_id LIMIT 1)
            WHERE project.system_id IS NULL
            """
        )
    )
    conn.execute(
        sa.text(
            "DELETE FROM workflow_node_event WHERE project_id IN (SELECT id FROM project WHERE system_id IS NULL)"
        )
    )
    conn.execute(sa.text("DELETE FROM workflow_node WHERE project_id IN (SELECT id FROM project WHERE system_id IS NULL)"))
    conn.execute(sa.text("DELETE FROM issue WHERE project_id IN (SELECT id FROM project WHERE system_id IS NULL)"))
    conn.execute(sa.text("DELETE FROM project WHERE system_id IS NULL"))
    conn.execute(
        sa.text(
            """
            UPDATE system
            SET division_id = COALESCE(
                system.division_id,
                (SELECT division_id FROM project WHERE project.system_id = system.id AND project.division_id IS NOT NULL LIMIT 1)
            )
            """
        )
    )
    with op.batch_alter_table("project") as batch:
        batch.alter_column("system_id", existing_type=sa.String(36), nullable=False)
        batch.drop_column("product_id")
        batch.drop_column("product_version_id")
    op.create_index("ix_project_system_id", "project", ["system_id"])

    # 5. issue：product_id → system_id
    with op.batch_alter_table("issue") as batch:
        batch.drop_column("product_version_id")
        batch.alter_column("product_id", new_column_name="system_id", existing_type=sa.String(36))
    op.create_index("ix_issue_system_id", "issue", ["system_id"])
    conn.execute(
        sa.text("UPDATE issue SET system_id = (SELECT system_id FROM project WHERE project.id = issue.project_id)")
    )

    # 6. score_library
    with op.batch_alter_table("score_library") as batch:
        batch.alter_column("product_id", new_column_name="project_id", existing_type=sa.String(36))
        batch.alter_column("product_line_id", new_column_name="system_id", existing_type=sa.String(36))
    op.create_index("ix_score_library_project_id", "score_library", ["project_id"])
    op.create_index("ix_score_library_system_id", "score_library", ["system_id"])
    conn.execute(
        sa.text(
            """
            UPDATE score_library
            SET system_id = CASE
                WHEN level = 'L2' THEN object_id
                ELSE (SELECT system_id FROM project WHERE project.id = score_library.project_id)
            END
            """
        )
    )
    conn.execute(sa.text("UPDATE score_library SET project_id = CASE WHEN level = 'L1' THEN object_id ELSE project_id END"))
    conn.execute(sa.text("UPDATE score_library SET source_type = 'project_score_snapshot' WHERE source_type = 'product_score_snapshot'"))
    conn.execute(sa.text("UPDATE score_library SET source_type = 'system_snapshot' WHERE source_type = 'product_line_snapshot'"))
    conn.execute(sa.text("UPDATE score_library SET object_type = 'project' WHERE object_type = 'product'"))
    conn.execute(sa.text("UPDATE score_library SET object_type = 'system' WHERE object_type = 'product_line'"))

    # 7. usability_study：删 product_version_id
    with op.batch_alter_table("usability_study") as batch:
        batch.drop_column("product_version_id")

    # 8. 新 L1 快照表
    op.execute(
        """
        CREATE TABLE project_score_snapshot (
            id VARCHAR(36) NOT NULL PRIMARY KEY,
            scope VARCHAR(20) NOT NULL DEFAULT 'project',
            project_id VARCHAR(36) NOT NULL,
            project_name VARCHAR(160) NOT NULL DEFAULT '',
            version_code VARCHAR(64) NOT NULL DEFAULT '',
            division_id VARCHAR(36),
            scheme_id VARCHAR(36) NOT NULL,
            scheme_code VARCHAR(32) NOT NULL DEFAULT '',
            scheme_business_ratio VARCHAR(16) NOT NULL DEFAULT '',
            scheme_problem_ratio VARCHAR(32) NOT NULL DEFAULT '',
            issue_count INTEGER NOT NULL DEFAULT 0,
            core_issue_count INTEGER NOT NULL DEFAULT 0,
            non_core_issue_count INTEGER NOT NULL DEFAULT 0,
            severity_counts_json TEXT NOT NULL DEFAULT '{}',
            core_deduction VARCHAR(24) NOT NULL DEFAULT '0',
            non_core_deduction VARCHAR(24) NOT NULL DEFAULT '0',
            total_deduction VARCHAR(24) NOT NULL DEFAULT '0',
            raw_uei VARCHAR(24) NOT NULL DEFAULT '100',
            display_uei VARCHAR(24) NOT NULL DEFAULT '100',
            clamp_zero BOOLEAN NOT NULL DEFAULT 0,
            is_effective BOOLEAN NOT NULL DEFAULT 1,
            input_manifest_json TEXT NOT NULL DEFAULT '{}',
            calc_trace_json TEXT NOT NULL DEFAULT '{}',
            created_by VARCHAR(36) NOT NULL DEFAULT '',
            created_by_name VARCHAR(64) NOT NULL DEFAULT '',
            snapshot_at DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    for stmt in (
        "CREATE INDEX ix_project_score_snapshot_project_id ON project_score_snapshot (project_id)",
        "CREATE INDEX ix_project_score_snapshot_scope ON project_score_snapshot (scope)",
        "CREATE INDEX ix_project_score_snapshot_scheme_id ON project_score_snapshot (scheme_id)",
        "CREATE INDEX ix_project_score_snapshot_is_effective ON project_score_snapshot (is_effective)",
        "CREATE INDEX ix_project_score_snapshot_division_id ON project_score_snapshot (division_id)",
        "CREATE INDEX ix_project_score_snapshot_snapshot_at ON project_score_snapshot (snapshot_at)",
    ):
        op.execute(stmt)
    op.execute(
        """
        CREATE TABLE snapshot_issue (
            id VARCHAR(36) NOT NULL PRIMARY KEY,
            snapshot_id VARCHAR(36) NOT NULL REFERENCES project_score_snapshot (id) ON DELETE CASCADE,
            issue_id VARCHAR(36) NOT NULL,
            issue_code VARCHAR(32) NOT NULL DEFAULT '',
            business_level VARCHAR(20) NOT NULL,
            severity VARCHAR(20) NOT NULL,
            cell_key VARCHAR(32) NOT NULL,
            deduction VARCHAR(16) NOT NULL,
            module VARCHAR(120) NOT NULL DEFAULT '',
            metric_l1 VARCHAR(120) NOT NULL DEFAULT '',
            metric_l2 VARCHAR(120) NOT NULL DEFAULT '',
            description_digest VARCHAR(255) NOT NULL DEFAULT '',
            source_snapshot_id VARCHAR(36),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    op.execute("CREATE INDEX ix_snapshot_issue_snapshot_id ON snapshot_issue (snapshot_id)")
    op.execute("CREATE INDEX ix_snapshot_issue_issue_id ON snapshot_issue (issue_id)")
    op.execute(
        "CREATE UNIQUE INDEX ix_snapshot_issue_unique ON snapshot_issue (snapshot_id, issue_id)"
    )

    # 9. 新 L2 快照表
    op.execute(
        """
        CREATE TABLE system_snapshot (
            id VARCHAR(36) NOT NULL PRIMARY KEY,
            system_id VARCHAR(36) NOT NULL,
            system_code VARCHAR(64) NOT NULL DEFAULT '',
            system_name VARCHAR(160) NOT NULL DEFAULT '',
            division_id VARCHAR(36),
            scheme_id VARCHAR(36) NOT NULL,
            scheme_code VARCHAR(32) NOT NULL DEFAULT '',
            selection_mode VARCHAR(16) NOT NULL DEFAULT 'latest',
            filters_json TEXT NOT NULL DEFAULT '{}',
            source_snapshot_count INTEGER NOT NULL DEFAULT 0,
            effective_project_count INTEGER NOT NULL DEFAULT 0,
            outlier_project_count INTEGER NOT NULL DEFAULT 0,
            raw_issue_count INTEGER NOT NULL DEFAULT 0,
            deduped_issue_count INTEGER NOT NULL DEFAULT 0,
            core_deduction VARCHAR(24) NOT NULL DEFAULT '0',
            non_core_deduction VARCHAR(24) NOT NULL DEFAULT '0',
            total_deduction VARCHAR(24) NOT NULL DEFAULT '0',
            authoritative_uei VARCHAR(24) NOT NULL DEFAULT '100',
            weighted_average_uei VARCHAR(24) NOT NULL DEFAULT '',
            bucket_uei VARCHAR(24) NOT NULL DEFAULT '',
            sample_sufficient BOOLEAN NOT NULL DEFAULT 0,
            severity_counts_json TEXT NOT NULL DEFAULT '{}',
            project_scores_json TEXT NOT NULL DEFAULT '[]',
            calc_trace_json TEXT NOT NULL DEFAULT '{}',
            created_by VARCHAR(36) NOT NULL DEFAULT '',
            created_by_name VARCHAR(64) NOT NULL DEFAULT '',
            snapshot_at DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    for stmt in (
        "CREATE INDEX ix_system_snapshot_system_id ON system_snapshot (system_id)",
        "CREATE INDEX ix_system_snapshot_division_id ON system_snapshot (division_id)",
        "CREATE INDEX ix_system_snapshot_snapshot_at ON system_snapshot (snapshot_at)",
        """
        CREATE TABLE system_snapshot_source (
            id VARCHAR(36) NOT NULL PRIMARY KEY,
            snapshot_id VARCHAR(36) NOT NULL REFERENCES system_snapshot (id) ON DELETE CASCADE,
            project_id VARCHAR(36) NOT NULL,
            project_name VARCHAR(160) NOT NULL DEFAULT '',
            version_code VARCHAR(64) NOT NULL DEFAULT '',
            weight VARCHAR(16) NOT NULL DEFAULT '1',
            l1_snapshot_id VARCHAR(36) NOT NULL,
            l1_scheme_code VARCHAR(32) NOT NULL DEFAULT '',
            l1_uei VARCHAR(24) NOT NULL DEFAULT '',
            is_out_of_scope BOOLEAN NOT NULL DEFAULT 0,
            issue_count INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        """,
        "CREATE INDEX ix_system_snapshot_source_snapshot_id ON system_snapshot_source (snapshot_id)",
        "CREATE INDEX ix_system_snapshot_source_project_id ON system_snapshot_source (project_id)",
    ):
        op.execute(stmt)

    # 10. bei 表列名
    if _has_column(conn, "division_evaluation", "participating_product_count"):
        with op.batch_alter_table("division_evaluation") as batch:
            batch.alter_column(
                "participating_product_count", new_column_name="participating_project_count", existing_type=sa.Integer
            )

    # 11. 删除产品层表
    op.drop_table("product_line_member")
    op.drop_table("product_version")
    op.drop_table("product")

    op.execute("PRAGMA foreign_keys=ON")


def _has_column(conn: sa.Connection, table: str, column: str) -> bool:
    cols = [r[1] for r in conn.execute(sa.text(f"PRAGMA table_info({table})")).fetchall()]
    return column in cols


def downgrade() -> None:
    raise NotImplementedError("v1.1 层级合并不可逆（产品层已取消，无回迁路径）")
