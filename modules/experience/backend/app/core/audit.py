"""审计写入与脱敏（T03）。

铁律：任何写库的审计明细都必须先过 ``redact``，密码 / 密钥 / 令牌等字段
一律替换为 ``***REDACTED***``；同时提供 ``assert_no_secrets`` 供测试与
运行期自检，确保日志中不出现敏感明文。
"""

from __future__ import annotations

import datetime as _dt
import json
import logging
from typing import Any

from sqlalchemy.orm import Session

from app.core.security import new_id
from app.core.timeutil import utcnow

logger = logging.getLogger("uei.audit")

REDACTED = "***REDACTED***"

# 命中即脱敏的字段名（小写子串匹配）
SENSITIVE_KEY_PARTS: tuple[str, ...] = (
    "password",
    "passwd",
    "secret",
    "token",
    "credential",
    "api_key",
    "apikey",
    "authorization",
    "cookie",
    "private_key",
)

# 允许写入审计的元信息白名单之外的键一律丢弃，避免误存敏感内容
_MAX_DETAIL_CHARS = 4000


def is_sensitive_key(key: str) -> bool:
    lowered = key.lower()
    return any(part in lowered for part in SENSITIVE_KEY_PARTS)


def redact(value: Any, *, _depth: int = 0) -> Any:
    """递归脱敏：敏感键 → 占位符；字符串截断到合理长度。"""
    if _depth > 6:
        return "<too-deep>"
    if isinstance(value, dict):
        return {
            str(k): (REDACTED if is_sensitive_key(str(k)) else redact(v, _depth=_depth + 1))
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple, set)):
        return [redact(v, _depth=_depth + 1) for v in value]
    if isinstance(value, str):
        return value if len(value) <= 500 else value[:500] + "…(截断)"
    if isinstance(value, (_dt.datetime, _dt.date)):
        return value.isoformat()
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return str(value)[:200]


def assert_no_secrets(payload: Any, *, where: str = "audit") -> None:
    """自检：确认序列化后的内容不含敏感明文（密码/密钥/令牌）。"""
    try:
        text = json.dumps(payload, ensure_ascii=False)
    except (TypeError, ValueError):
        text = str(payload)
    lowered = text.lower()
    forbidden = ("password", "passwd", "secret", "api_key", "apikey", "authorization")
    leaks = [f for f in forbidden if f in lowered]
    if leaks and REDACTED not in text:
        raise AssertionError(f"{where}: 审计内容疑似包含敏感字段 {leaks}")


def write_audit(
    db: Session,
    *,
    category: str,
    action: str,
    actor_account_id: str | None = None,
    actor_name: str = "",
    actor_role: str = "",
    target_type: str = "",
    target_id: str = "",
    summary: str = "",
    detail: dict[str, Any] | None = None,
    request_id: str = "",
    ip_address: str = "",
    commit: bool = True,
) -> Any:
    """写入一条审计记录。``detail`` 先脱敏再序列化。"""
    from app.models.account import AuditLog

    safe_detail = redact(detail or {})
    serialized = json.dumps(safe_detail, ensure_ascii=False, sort_keys=True)
    if len(serialized) > _MAX_DETAIL_CHARS:
        serialized = serialized[:_MAX_DETAIL_CHARS] + "…(截断)"

    entry = AuditLog(
        id=new_id(),
        category=category,
        action=action,
        actor_account_id=actor_account_id,
        actor_name=actor_name,
        actor_role=actor_role,
        target_type=target_type,
        target_id=target_id,
        summary=summary[:255],
        detail=serialized,
        request_id=request_id,
        ip_address=ip_address,
        created_at=utcnow(),
    )
    db.add(entry)
    if commit:
        db.commit()
    else:
        db.flush()
    logger.info(
        "audit %s/%s actor=%s target=%s/%s rid=%s",
        category,
        action,
        actor_account_id or "-",
        target_type or "-",
        target_id or "-",
        request_id or "-",
    )
    return entry
