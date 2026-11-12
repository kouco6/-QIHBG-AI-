"""统一时间口径：全部使用 **naive UTC**。

SQLite 不支持真正带时区的 DATETIME；为避免 aware/naive 混用导致比较报错，
全库统一以 UTC 的无时区 ``datetime`` 存储与比较，对外输出时再补 ``Z`` 后缀。
"""

from __future__ import annotations

import datetime as _dt


def utcnow() -> _dt.datetime:
    """当前 UTC 时间（naive）。"""
    return _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)


def to_naive_utc(value: _dt.datetime | None) -> _dt.datetime | None:
    """将可能带时区的时间归一为 naive UTC。"""
    if value is None:
        return None
    if value.tzinfo is None:
        return value
    return value.astimezone(_dt.timezone.utc).replace(tzinfo=None)


def iso_z(value: _dt.datetime | None) -> str | None:
    """序列化为带 ``Z`` 的 ISO 字符串，便于前端按本地时区展示。"""
    normalized = to_naive_utc(value)
    if normalized is None:
        return None
    return normalized.isoformat(timespec="seconds") + "Z"
