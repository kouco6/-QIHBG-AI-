"""系统级配置（键值）。

仅保存非敏感配置；密钥一律只从环境变量读取，禁止入库（DESIGN §7-6）。
"""

from __future__ import annotations

from sqlalchemy import String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base, TimestampMixin


class SystemSetting(Base, TimestampMixin):
    __tablename__ = "system_setting"

    key: Mapped[str] = mapped_column(String(120), primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False, default="")
    value_type: Mapped[str] = mapped_column(String(20), nullable=False, default="string")
    description: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    updated_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
