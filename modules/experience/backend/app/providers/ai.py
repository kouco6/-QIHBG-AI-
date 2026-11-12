"""AI Provider 真实模式骨架（T13 / PRD §12.1）。

本轮**只做配置校验**，不发起任何网络请求；``submit`` 在真实模式下抛
``BlockedError``。AI 会话与消息一律本地持久化。
"""

from __future__ import annotations

from app.core.config import settings
from app.models.provider import PROVIDER_AI
from app.providers.base import RealAdapterSkeleton


class AiAdapter(RealAdapterSkeleton):
    """OpenAI 兼容协议适配器骨架。"""

    kind = PROVIDER_AI
    endpoint_label = "OpenAI 兼容端点（地址与密钥均不回显）"
    capability_note = "体验问题汇总分析与会话；未配置时使用本地模拟摘要，不发送外部数据。"

    def _configured(self) -> bool:
        # 仅报告「是否配置」，绝不回显 ai_api_key / ai_endpoint 的值
        return settings.ai_configured
