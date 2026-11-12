"""外部集成 Provider 包（默认 Mock，真实外部调用在本轮范围外）。

对外导出：

- :func:`resolve_mode`：按 ``settings.effective_provider_mode`` 与类型级凭证决定
  ``mock`` / ``real``；**未配置凭证一律降级为 mock**；
- :func:`get_adapter`：取得归一化的 :class:`~app.providers.base.ProviderAdapter`
  实例（mock 或 real 骨架）；
- 契约数据类与适配器类，便于测试直接构造。
"""

from __future__ import annotations

from app.core.config import settings
from app.models.provider import (
    MODE_MOCK,
    MODE_REAL,
    PROVIDER_AI,
    PROVIDER_FEISHU,
    PROVIDER_KINDS,
    PROVIDER_WORKBUDDY,
)
from app.providers.ai import AiAdapter
from app.providers.base import (
    ProviderAdapter,
    ProviderProgress,
    ProviderReceipt,
    ProviderStatus,
)
from app.providers.feishu import FeishuAdapter
from app.providers.mock import MockAdapter
from app.providers.workbuddy import WorkBuddyAdapter

# 真实模式骨架映射：仅在显式 real 模式时按需实例化（仍不会发起外部调用）
_REAL_ADAPTERS: dict[str, type[ProviderAdapter]] = {
    PROVIDER_FEISHU: FeishuAdapter,
    PROVIDER_AI: AiAdapter,
    PROVIDER_WORKBUDDY: WorkBuddyAdapter,
}


def resolve_mode(kind: str) -> str:
    """解析某类 Provider 的**实际生效模式**（``mock`` / ``real``）。

    - 未配置全局凭证 → ``mock``（``settings.effective_provider_mode`` 为准）；
    - 类型级凭证缺失 → ``mock``；
    - WorkBuddy 本轮无凭证变量 → 恒为 ``mock``。
    """
    if kind not in PROVIDER_KINDS:
        raise ValueError(f"未知 Provider 类型：{kind}")

    effective = settings.effective_provider_mode
    if effective == MODE_MOCK:
        return MODE_MOCK
    if kind == PROVIDER_FEISHU and not settings.feishu_configured:
        return MODE_MOCK
    if kind == PROVIDER_AI and not settings.ai_configured:
        return MODE_MOCK
    if kind == PROVIDER_WORKBUDDY:
        return MODE_MOCK
    return MODE_REAL


def get_adapter(kind: str, mode: str | None = None) -> ProviderAdapter:
    """取得适配器实例；``mode`` 缺省时以 :func:`resolve_mode` 为准。"""
    if kind not in PROVIDER_KINDS:
        raise ValueError(f"未知 Provider 类型：{kind}")
    resolved = (mode or resolve_mode(kind)).lower()
    if resolved not in (MODE_MOCK, MODE_REAL):
        raise ValueError(f"未知 Provider 模式：{mode}")
    if resolved == MODE_MOCK:
        return MockAdapter(kind)
    return _REAL_ADAPTERS[kind]()


__all__ = [
    "AiAdapter",
    "FeishuAdapter",
    "MockAdapter",
    "ProviderAdapter",
    "ProviderProgress",
    "ProviderReceipt",
    "ProviderStatus",
    "WorkBuddyAdapter",
    "get_adapter",
    "resolve_mode",
]
