"""WorkBuddy Provider 真实模式骨架（T13 / PRD §12.1）。

WorkBuddy 使用「HTTP 提交 + 回调 + 轮询」适配模式。本轮**只做配置校验**，
不发起任何网络请求；``submit`` 在真实模式下抛 ``BlockedError``。

注意：当前运行期配置（``app.core.config.Settings``）**没有 WorkBuddy 凭证变量**，
因此其 ``_configured`` 恒为 ``False``，运行期一律降级为 Mock。
"""

from __future__ import annotations

from app.models.provider import PROVIDER_WORKBUDDY
from app.providers.base import RealAdapterSkeleton


class WorkBuddyAdapter(RealAdapterSkeleton):
    """WorkBuddy 提交适配器骨架。"""

    kind = PROVIDER_WORKBUDDY
    endpoint_label = "WorkBuddy HTTP 提交 / 回调 / 轮询"
    capability_note = "WorkBuddy 作业提交与轮询；本轮未配置凭证，固定使用本地 Mock。"

    def _configured(self) -> bool:
        # 本轮未提供 WorkBuddy 凭证变量；真实模式未启用，不回显任何配置值
        return False
