"""Mock Provider：确定性回执，不访问任何网络（T13 / PRD §12.1）。

- **确定性**：同一 ``(kind, idempotency_key)`` 永远返回同一 ``external_id``，
  形如 ``mock_feishu_<8位哈希>``，便于幂等断言与界面显示；
- **poll**：按调用次数推进 ``0 → 40 → 80 → 100``；
- **cancel**：立即生效（记录已取消，无外部副作用）。
"""

from __future__ import annotations

import hashlib

from app.core.errors import ValidationError
from app.core.timeutil import utcnow
from app.domain.states import JOB_RUNNING, JOB_SUCCEEDED
from app.models.provider import MOCK_RECEIPT_PREFIX, MODE_MOCK, PROVIDER_KINDS
from app.providers.base import ProviderAdapter, ProviderProgress, ProviderReceipt, ProviderStatus

# poll 调用的进度序列（第 1 次返回 0，其后 40 / 80 / 100，再之后维持 100）
_PROGRESS_SEQUENCE: tuple[int, ...] = (0, 40, 80, 100)


class MockAdapter(ProviderAdapter):
    """本地模拟适配器（默认模式，主流程在无凭证环境可完整运行）。"""

    mode = MODE_MOCK
    capability_note = "本地模拟：不访问任何外部网络，回执 ID 以 mock_ 前缀标识"

    def __init__(self, kind: str) -> None:
        if kind not in PROVIDER_KINDS:
            raise ValueError(f"未知 Provider 类型：{kind}")
        self.kind = kind
        self._poll_counts: dict[str, int] = {}
        self._cancelled: set[str] = set()

    # ---------------------------------------------------------------- 配置
    def validate_configuration(self) -> ProviderStatus:
        return ProviderStatus(
            kind=self.kind,
            mode=MODE_MOCK,
            configured=True,
            endpoint_label="本地 Mock（无外部端点）",
            capability_note=self.capability_note,
            detail="当前使用本地 Mock，未配置真实外部凭证，主流程可继续。",
        )

    # ---------------------------------------------------------------- 提交
    def submit(self, request, idempotency_key: str) -> ProviderReceipt:  # type: ignore[override]
        key = (idempotency_key or "").strip()
        if not key:
            raise ValidationError(
                "幂等键不能为空",
                field_errors=[
                    {"field": "idempotency_key", "message": "幂等键不能为空", "type": "value_error"}
                ],
            )
        digest = hashlib.sha256(f"{self.kind}:{key}".encode("utf-8")).hexdigest()[:8]
        external_id = f"{MOCK_RECEIPT_PREFIX}{self.kind}_{digest}"
        payload = dict(request or {})
        return ProviderReceipt(
            external_id=external_id,
            is_mock=True,
            code="ok",
            message="模拟执行成功（未发送任何外部数据）",
            body={
                "simulated": True,
                "provider_kind": self.kind,
                "idempotency_key": key,
                "request": payload,
                "note": "本地模拟回执，未发生任何外部调用",
            },
            received_at=utcnow(),
        )

    # ---------------------------------------------------------------- 轮询
    def poll(self, receipt: ProviderReceipt) -> ProviderProgress:
        count = self._poll_counts.get(receipt.external_id, 0) + 1
        self._poll_counts[receipt.external_id] = count
        index = min(count - 1, len(_PROGRESS_SEQUENCE) - 1)
        progress = _PROGRESS_SEQUENCE[index]
        status = JOB_SUCCEEDED if progress >= 100 else JOB_RUNNING
        return ProviderProgress(
            status=status,
            progress=progress,
            is_mock=True,
            message=f"本地模拟进度 {progress}%",
        )

    # ---------------------------------------------------------------- 取消
    def cancel(self, receipt: ProviderReceipt) -> None:
        self._cancelled.add(receipt.external_id)

    def is_cancelled(self, receipt: ProviderReceipt) -> bool:
        return receipt.external_id in self._cancelled
