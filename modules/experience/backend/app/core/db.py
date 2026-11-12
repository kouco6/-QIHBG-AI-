"""数据库会话与引擎。

SQLite 启用 WAL、外键约束与合理超时；仓储层隔离数据库方言（DESIGN §9）。
"""

from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import DATA_DIR, settings


def _build_engine() -> Engine:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    connect_args: dict[str, object] = {}
    if settings.is_sqlite:
        # 允许跨线程使用同一连接池（FastAPI 线程池）
        connect_args = {"check_same_thread": False, "timeout": 30}
    engine = create_engine(
        settings.database_url,
        echo=False,
        future=True,
        pool_pre_ping=True,
        connect_args=connect_args,
    )
    if settings.is_sqlite:
        _register_sqlite_pragmas(engine)
    return engine


def _register_sqlite_pragmas(engine: Engine) -> None:
    @event.listens_for(engine, "connect")
    def _set_pragmas(dbapi_connection, _connection_record):  # noqa: ANN001
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.close()


engine: Engine = _build_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    """FastAPI 依赖：每请求一个会话，短事务。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def check_database() -> tuple[bool, str]:
    """健康检查：连通性与方言。"""
    try:
        from sqlalchemy import text

        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        dialect = engine.dialect.name
        journal = ""
        if settings.is_sqlite:
            with engine.connect() as conn:
                journal = str(conn.execute(text("PRAGMA journal_mode")).scalar() or "")
        return True, f"{dialect}" + (f"/{journal}" if journal else "")
    except Exception as exc:  # pragma: no cover - 健康检查兜底
        return False, str(exc)
