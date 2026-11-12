"""应用配置。

密钥一律来自环境变量，禁止硬编码；数据库仅保存 Provider 是否配置、模式与非敏感端点标识。
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/ 目录
BACKEND_DIR = Path(__file__).resolve().parents[2]
# 仓库根目录
ROOT_DIR = BACKEND_DIR.parent
DATA_DIR = ROOT_DIR / "data"
LOG_DIR = ROOT_DIR / "logs"


class Settings(BaseSettings):
    """从环境变量读取的运行期配置。"""

    model_config = SettingsConfigDict(
        env_file=str(ROOT_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- 应用 ---
    app_name: str = "体验工作台"
    app_env: str = "local"
    debug: bool = False

    # --- 服务端口 ---
    api_host: str = "127.0.0.1"
    api_port: int = 8000
    web_host: str = "127.0.0.1"
    web_port: int = 5173

    # --- 数据库（SQLite + WAL） ---
    database_url: str = f"sqlite:///{(DATA_DIR / 'uei.db').as_posix()}"

    # --- 会话 ---
    secret_key: str = "change-me-in-env"
    session_cookie_name: str = "uei_session"
    session_max_age_seconds: int = 12 * 3600
    session_https_only: bool = False

    # --- CORS ---
    cors_origins: str = "http://127.0.0.1:5173,http://localhost:5173"

    # --- 业务开关默认值 ---
    # UEI 封0（默认关闭，见 DESIGN §7 / PRD §8）
    uei_clamp_zero_default: bool = False

    # --- Provider（默认 Mock；密钥仅从环境读取，不入库） ---
    provider_mode: str = "mock"
    feishu_app_id: str = ""
    feishu_app_secret: str = ""
    ai_api_key: str = ""
    ai_endpoint: str = ""

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def feishu_configured(self) -> bool:
        return bool(self.feishu_app_id and self.feishu_app_secret)

    @property
    def ai_configured(self) -> bool:
        return bool(self.ai_api_key and self.ai_endpoint)

    @property
    def effective_provider_mode(self) -> str:
        """未配置外部凭证时自动降级为 Mock（见 T13 验收）。"""
        if self.provider_mode == "mock":
            return "mock"
        if self.provider_mode == "feishu" and not self.feishu_configured:
            return "mock"
        if self.provider_mode == "ai" and not self.ai_configured:
            return "mock"
        return self.provider_mode

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
