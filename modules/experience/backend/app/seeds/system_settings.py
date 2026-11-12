"""系统设置默认值（单一数据源）。

迁移 ``0001_initial`` 内联了同名向量作为历史快照；本模块用于运行期自愈与测试播种，
保证「空库也能拿到完整默认配置」。

注意：这里只放**非敏感**配置。密钥一律仅从环境变量读取，禁止入库（DESIGN §7-6）。
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.system import SystemSetting

DEFAULT_SYSTEM_SETTINGS: tuple[dict[str, str], ...] = (
    {
        "key": "uei.clamp_zero",
        "value": "false",
        "value_type": "bool",
        "description": "UEI 得分是否封 0（默认关闭，允许显示负分）",
    },
    {
        "key": "bei.threshold_version",
        "value": "v1",
        "value_type": "string",
        "description": "当前生效的 BEI 经验阈值版本（首版来自 PRD V1.2 §8.8.6）",
    },
    {
        "key": "provider.mode",
        "value": "mock",
        "value_type": "string",
        "description": "Provider 运行模式；未配置外部凭证时强制 Mock",
    },
)


def seed_default_settings(db: Session) -> int:
    """补齐缺失的默认配置项，已存在的保持不动。返回新增条数。"""
    existing = set(db.execute(select(SystemSetting.key)).scalars().all())
    added = 0
    for item in DEFAULT_SYSTEM_SETTINGS:
        if item["key"] in existing:
            continue
        db.add(SystemSetting(**item))
        added += 1
    if added:
        db.commit()
    return added
