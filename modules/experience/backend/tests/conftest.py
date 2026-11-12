"""测试夹具（T03+）。

每个测试使用**独立的临时 SQLite 数据库**（内存库 + StaticPool），通过覆盖
``get_db`` 依赖注入，不触碰 ``data/uei.db`` 生产数据，也不修改任何契约文件。

为什么用内存库而不是 ``tmp_path`` 文件库：
1. 沙箱文件系统代理下，50 张表 + 索引的文件级 DDL 约需 8 秒/次，内存库约 1.2 秒；
2. ``tmp_path`` 会在退出时触发批量目录清理，被沙箱安全删除保护拦截并中断测试进程。
内存库与文件库在 SQLAlchemy 层面行为一致（同一方言、同一 DDL），且隔离性更强。
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.db import get_db
from app.main import app
from app.models import Base  # 触发全部模型注册


@pytest.fixture()
def db_engine() -> Iterator[Engine]:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        future=True,
    )

    @event.listens_for(engine, "connect")
    def _pragmas(dbapi_connection, _record):  # noqa: ANN001
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(engine)

    # 与迁移对齐：空库补齐系统设置、20 套评分方案（160 单元）、产物模板与 BEI 阈值 v1
    from app.seeds import seed_all

    bootstrap = sessionmaker(bind=engine, autoflush=False, future=True, expire_on_commit=False)
    with bootstrap() as seed_db:
        seed_all(seed_db)

    try:
        yield engine
    finally:
        engine.dispose()


@pytest.fixture()
def session_factory(db_engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=db_engine, autoflush=False, autocommit=False, future=True, expire_on_commit=False)


@pytest.fixture()
def client(session_factory: sessionmaker[Session]) -> Iterator[TestClient]:
    def _override_get_db() -> Iterator[Session]:
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture()
def new_client(session_factory: sessionmaker[Session]) -> Iterator[callable]:
    """生成**独立 Cookie** 的客户端（共享同一测试数据库）。

    用于同时扮演「首账号」与「普通账号」两个会话。
    """

    def _override_get_db() -> Iterator[Session]:
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _override_get_db
    opened: list[TestClient] = []

    def _make() -> TestClient:
        test_client = TestClient(app)
        test_client.__enter__()
        opened.append(test_client)
        return test_client

    try:
        yield _make
    finally:
        for test_client in opened:
            test_client.__exit__(None, None, None)
        app.dependency_overrides.clear()


# --- 常用测试数据 ---

PRIMARY = {"name": "龙斌", "account": "longbin", "password": "UeiWorkbench2026"}
MEMBER = {"name": "体验同事", "account": "member01", "password": "MemberPass2026"}


@pytest.fixture()
def setup_primary(client: TestClient) -> dict[str, object]:
    """创建首账号并返回创建结果（已自动登录，Cookie 保留在 client 中）。"""
    resp = client.post(
        "/api/v1/auth/setup",
        json={**PRIMARY, "confirm_password": PRIMARY["password"]},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


@pytest.fixture()
def member_account(client: TestClient, setup_primary: dict[str, object]) -> dict[str, object]:
    """由首账号创建一名普通体验人员账号，随后**切回首账号会话之外**的独立客户端不可得，
    因此该夹具只负责建号，登录动作由测试自行发起。"""
    resp = client.post(
        "/api/v1/accounts",
        json={"name": MEMBER["name"], "account": MEMBER["account"], "password": MEMBER["password"]},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def login(client: TestClient, account: str, password: str) -> None:
    resp = client.post("/api/v1/auth/login", json={"account": account, "password": password})
    assert resp.status_code == 200, resp.text
