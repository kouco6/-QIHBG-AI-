"""Provider 适配层契约（T13 / PRD §12.1）。

三类外部能力（飞书 / AI / WorkBuddy）**共用统一 Provider 接口边界**：

```
ProviderAdapter
  kind: 'feishu' | 'ai' | 'workbuddy'
  mode: 'mock' | 'real'
  validate_configuration() -> ProviderStatus
  submit(request, idempotency_key) -> ProviderReceipt
  poll(receipt) -> ProviderProgress
  cancel(receipt) -> None
```

设计约束：

- 本模块的 ``ProviderStatus`` / ``ProviderReceipt`` / ``ProviderProgress`` 是**纯数据类**
  （dataclass），与 ``app.models.provider`` 的 ORM 模型分离；同一模块内不得同时以同名
  引入 ORM 模型，避免混淆。
- ``RealAdapterSkeleton`` 只做配置校验，**任何外部调用在本轮范围外**，一律抛
  :class:`~app.core.errors.BlockedError`，确保不产生真实网络请求。
"""

from __future__ import annotations

import abc
import datetime as _dt
from dataclasses import dataclass, field
from typing import Any, Mapping

from app.core.errors import BlockedError
from app.models.provider import MODE_MOCK, MODE_REAL


@dataclass(frozen=True)
class ProviderStatus:
    """配置状态（**只反映是否配置，绝不回显凭证值**）。"""

    kind: str
    mode: str
    configured: bool
    endpoint_label: str = ""
    capability_note: str = ""
    detail: str = ""


@dataclass(frozen=True)
class ProviderReceipt:
    """一次提交的回执（Mock 回执使用 ``mock_`` 前缀，不得伪装成真实同步成功）。"""

    external_id: str
    is_mock: bool
    code: str = "ok"
    message: str = ""
    body: dict[str, Any] = field(default_factory=dict)
    received_at: _dt.datetime | None = None


@dataclass(frozen=True)
class ProviderProgress:
    """轮询进度。"""

    status: str
    progress: int
    is_mock: bool = True
    message: str = ""


class ProviderAdapter(abc.ABC):
    """Provider 统一适配接口。"""

    kind: str = ""
    mode: str = MODE_MOCK

    @abc.abstractmethod
    def validate_configuration(self) -> ProviderStatus:
        """返回配置状态（只报告是否配置，不回显密钥）。"""

    @abc.abstractmethod
    def submit(self, request: Mapping[str, Any], idempotency_key: str) -> ProviderReceipt:
        """提交作业；幂等键相同的提交必须返回同一回执。"""

    @abc.abstractmethod
    def poll(self, receipt: ProviderReceipt) -> ProviderProgress:
        """查询进度。"""

    @abc.abstractmethod
    def cancel(self, receipt: ProviderReceipt) -> None:
        """取消作业（Mock 立即生效）。"""


class RealAdapterSkeleton(ProviderAdapter):
    """真实模式接口骨架：仅校验配置，**禁止任何外部调用**。

    三个真实 Provider（飞书 / AI / WorkBuddy）继承本骨架，仅需声明 ``kind`` /
    ``endpoint_label`` / ``capability_note`` 并实现 :meth:`_configured`。
    """

    mode = MODE_REAL
    endpoint_label = ""
    capability_note = ""

    BLOCKED_MESSAGE = "真实外部调用在本轮范围外，禁止执行"

    def _configured(self) -> bool:  # pragma: no cover - 由子类覆盖
        return False

    def validate_configuration(self) -> ProviderStatus:
        configured = self._configured()
        return ProviderStatus(
            kind=self.kind,
            mode=MODE_REAL,
            configured=configured,
            endpoint_label=self.endpoint_label,
            capability_note=self.capability_note,
            detail=(
                "已配置外部凭证（真实模式仍在本轮范围外，不会发起外部调用）"
                if configured
                else "未配置外部凭证，运行时自动降级为本地 Mock"
            ),
        )

    def _blocked(self) -> BlockedError:
        return BlockedError(
            self.BLOCKED_MESSAGE,
            extra={"provider_kind": self.kind, "mode": MODE_REAL, "external_call": False},
        )

    def submit(self, request: Mapping[str, Any], idempotency_key: str) -> ProviderReceipt:
        raise self._blocked()

    def poll(self, receipt: ProviderReceipt) -> ProviderProgress:
        raise self._blocked()

    def cancel(self, receipt: ProviderReceipt) -> None:
        raise self._blocked()
