"""种子数据包。

- ``source_manifest.json``：T01 只读源清单（源文件指纹、字典预期计数、冻结口径）。
- ``system_settings``：系统设置默认值。
- ``scoring_schemes``：20 套评分方案 × 8 单元 = 160 矩阵单元。
- ``artifact_templates``：产物模板字段定义。
- ``bei_thresholds``：BEI 经验阈值版本 v1（15 个二级指标）。
- ``flow_fixtures`` / ``demo_seed``：示例项目数据（T15）。

``seed_all`` 是所有播种入口的**唯一聚合点**，供 ``start.ps1``、测试与
``scripts/verify_seed_counts.py`` 复用。
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.seeds.artifact_templates import seed_artifact_templates, template_schema_json
from app.seeds.bei_thresholds import active_threshold, seed_bei_thresholds
from app.seeds.scoring_schemes import default_scheme, scheme_cell_map, seed_scoring_schemes
from app.seeds.system_settings import DEFAULT_SYSTEM_SETTINGS, seed_default_settings

__all__ = [
    "DEFAULT_SYSTEM_SETTINGS",
    "active_threshold",
    "default_scheme",
    "scheme_cell_map",
    "seed_all",
    "seed_artifact_templates",
    "seed_bei_thresholds",
    "seed_default_settings",
    "seed_scoring_schemes",
    "template_schema_json",
]


def seed_all(db: Session, *, include_demo: bool = False) -> dict[str, int]:
    """按依赖顺序播种全部基础数据。返回各步骤新增条数。"""
    result = {
        "system_settings": seed_default_settings(db),
        "scoring_schemes": seed_scoring_schemes(db),
        "artifact_templates": seed_artifact_templates(db),
        "bei_threshold_versions": seed_bei_thresholds(db),
    }
    if include_demo:
        from app.seeds.demo_seed import seed_demo_project

        result["demo_projects"] = seed_demo_project(db)
    return result
