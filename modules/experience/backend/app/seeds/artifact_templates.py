"""产物模板种子（T05 单一数据源）。

模板字段逐字来自 ``app.domain.templates``（PRD §7.3）。模板是**数据**：
运行期可版本化；本函数幂等，按 ``kind`` 补齐。
"""

from __future__ import annotations

import json

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.timeutil import utcnow
from app.domain.templates import TEMPLATES
from app.models.artifact import ArtifactTemplate


def template_schema_json(kind: str) -> str:
    from app.domain.templates import TEMPLATE_BY_KIND

    spec = TEMPLATE_BY_KIND[kind]
    return json.dumps(
        [
            {
                "key": f.key,
                "label": f.label,
                "type": f.type,
                "required": f.required,
                "group": f.group,
                "help": f.help,
                "options": list(f.options),
                "columns": list(f.columns),
                "max_length": f.max_length,
            }
            for f in spec.fields
        ],
        ensure_ascii=False,
    )


def seed_artifact_templates(db: Session) -> int:
    """写入/补齐产物模板定义，返回新增条数。"""
    existing = set(db.execute(select(ArtifactTemplate.kind)).scalars().all())
    added = 0
    now = utcnow()
    for spec in TEMPLATES:
        if spec.kind in existing:
            continue
        db.add(
            ArtifactTemplate(
                kind=spec.kind,
                name=spec.name,
                node_code=spec.node_code,
                allow_not_applicable=spec.allow_not_applicable,
                description=spec.description,
                schema_json=template_schema_json(spec.kind),
                template_version=1,
                is_active=True,
                created_at=now,
                updated_at=now,
            )
        )
        added += 1
    if added:
        db.commit()
    return added
