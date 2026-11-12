"""飞书 Provider 真实模式骨架（T13 / PRD §12.1）。

本轮**只做配置校验**，不发起任何网络请求；``submit`` 在真实模式下抛
``BlockedError``（"真实外部调用在本轮范围外，禁止执行"）。
"""

from __future__ import annotations

from app.core.config import settings
from app.models.provider import PROVIDER_FEISHU
from app.providers.base import RealAdapterSkeleton


class FeishuAdapter(RealAdapterSkeleton):
    """飞书项目管理（Meego 工作项）适配器骨架。"""

    kind = PROVIDER_FEISHU
    endpoint_label = "open.feishu.cn（Meego 工作项）"
    capability_note = "问题一键同步飞书项目管理：幂等键 + 回执 + 重试；本轮不执行真实外调。"

    def _configured(self) -> bool:
        # 仅报告「是否配置」，绝不回显 app_id / app_secret 的值
        return settings.feishu_configured
