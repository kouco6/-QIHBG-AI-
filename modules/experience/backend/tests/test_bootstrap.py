"""T02 验收测试：工程骨架、健康检查、迁移与错误壳。

- 健康接口成功
- REST 前缀 /api/v1 可用
- 未知路径返回统一错误形状（code/message/field_errors/request_id）
- 校验失败返回 422 且含字段级错误
- 请求 ID 回显
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.errors import REQUEST_ID_HEADER
from app.main import app


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


def test_health_ok(client: TestClient) -> None:
    resp = client.get("/api/health")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "ok"
    assert body["database"]["ok"] is True
    assert "sqlite" in body["database"]["detail"]
    assert body["provider"]["effective_mode"] == "mock"


def test_health_reports_wal(client: TestClient) -> None:
    """SQLite 必须启用 WAL。"""
    body = client.get("/api/health").json()
    assert "wal" in body["database"]["detail"].lower()


def test_v1_prefix_available(client: TestClient) -> None:
    resp = client.get("/api/v1/ping")
    assert resp.status_code == 200
    assert resp.json()["api_prefix"] == "/api/v1"


def test_meta_frozen_baselines(client: TestClient) -> None:
    body = client.get("/api/v1/meta").json()
    fb = body["frozen_baselines"]
    assert fb["workflow_nodes"] == 13
    assert fb["scoring_schemes"] == 20
    assert fb["scoring_matrix_cells"] == 160
    assert fb["dictionary"]["software_check_items"] == 114
    assert fb["dictionary"]["hardware_single_unit_rows"] == 224


def test_404_uses_unified_error_shape(client: TestClient) -> None:
    resp = client.get("/api/v1/does-not-exist")
    assert resp.status_code == 404
    body = resp.json()
    assert set(["code", "message", "field_errors", "request_id"]).issubset(body.keys())
    assert body["code"] == "not_found"


def test_request_id_echoed(client: TestClient) -> None:
    resp = client.get("/api/v1/ping", headers={REQUEST_ID_HEADER: "rid-test-123"})
    assert resp.headers.get(REQUEST_ID_HEADER) == "rid-test-123"
    assert resp.headers.get(REQUEST_ID_HEADER)


def test_error_has_request_id(client: TestClient) -> None:
    resp = client.get("/api/v1/does-not-exist")
    assert resp.json()["request_id"]
