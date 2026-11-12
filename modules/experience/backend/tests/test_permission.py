"""T03 验收：权限边界与首账号设置写权限。

覆盖 ACCEPTANCE：
- 未登录业务接口返回 401；
- 普通账号写系统设置返回 403；
- 不存在实体返回 404；
- 普通体验人员与首账号拥有**相同**业务可见范围，只有首账号可写系统设置。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import MEMBER, PRIMARY, login

# 未登录时应返回 401 的端点（业务只读 + 设置）
PROTECTED_READS = [
    "/api/v1/auth/me",
    "/api/v1/auth/sessions",
    "/api/v1/accounts",
    "/api/v1/settings",
    "/api/v1/audit-logs",
]


def test_unauthenticated_business_endpoints_return_401(client: TestClient, setup_primary: dict) -> None:
    client.cookies.clear()
    for path in PROTECTED_READS:
        resp = client.get(path)
        assert resp.status_code == 401, f"{path} -> {resp.status_code}"
        assert resp.json()["code"] == "unauthorized"
        assert resp.json()["request_id"]


def test_unauthenticated_write_returns_401(client: TestClient, setup_primary: dict) -> None:
    client.cookies.clear()
    resp = client.patch("/api/v1/settings/uei.clamp_zero", json={"value": "true"})
    assert resp.status_code == 401


def test_member_cannot_write_settings(client: TestClient, setup_primary: dict, member_account: dict, new_client) -> None:
    """ACCEPTANCE：普通账号写系统设置返回 403。"""
    member = new_client()
    login(member, MEMBER["account"], MEMBER["password"])

    before = member.get("/api/v1/settings").json()
    resp = member.patch("/api/v1/settings/uei.clamp_zero", json={"value": "true"})
    assert resp.status_code == 403, resp.text
    body = resp.json()
    assert body["code"] == "forbidden"
    assert body["required_role"] == "primary_account"

    # 值未被修改
    after = member.get("/api/v1/settings").json()
    assert after == before


def test_member_cannot_manage_accounts(client: TestClient, setup_primary: dict, member_account: dict, new_client) -> None:
    member = new_client()
    login(member, MEMBER["account"], MEMBER["password"])

    create = member.post(
        "/api/v1/accounts", json={"name": "偷偷建号", "account": "sneaky", "password": "Sneaky2026x"}
    )
    assert create.status_code == 403

    status = member.patch(f"/api/v1/accounts/{member_account['id']}/status", json={"is_active": False})
    assert status.status_code == 403


def test_primary_can_write_settings(client: TestClient, setup_primary: dict) -> None:
    resp = client.patch("/api/v1/settings/uei.clamp_zero", json={"value": "true"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["value"] == "true"
    assert body["updated_by"] == PRIMARY["account"]

    # 恢复默认，避免影响其他断言
    assert client.patch("/api/v1/settings/uei.clamp_zero", json={"value": "false"}).status_code == 200


def test_member_and_primary_share_business_visibility(
    client: TestClient, setup_primary: dict, member_account: dict, new_client
) -> None:
    """ACCEPTANCE：普通体验人员和首账号拥有相同业务可见范围。"""
    member = new_client()
    login(member, MEMBER["account"], MEMBER["password"])

    for path in ("/api/v1/settings", "/api/v1/accounts", "/api/v1/audit-logs"):
        primary_resp = client.get(path)
        member_resp = member.get(path)
        assert primary_resp.status_code == member_resp.status_code == 200, path
        assert primary_resp.json() == member_resp.json(), f"可见范围不一致：{path}"


def test_nonexistent_entities_return_404(client: TestClient, setup_primary: dict) -> None:
    assert client.patch("/api/v1/settings/no.such.key", json={"value": "x"}).status_code == 404
    assert client.patch("/api/v1/accounts/not-a-real-id/status", json={"is_active": False}).status_code == 404

    body = client.patch("/api/v1/settings/no.such.key", json={"value": "x"}).json()
    assert body["code"] == "not_found"


def test_primary_cannot_disable_self(client: TestClient, setup_primary: dict) -> None:
    me = client.get("/api/v1/auth/me").json()
    resp = client.patch(f"/api/v1/accounts/{me['id']}/status", json={"is_active": False})
    assert resp.status_code == 409
    assert resp.json()["code"] == "self_disable_forbidden"


def test_setting_write_validates_body(client: TestClient, setup_primary: dict) -> None:
    resp = client.patch("/api/v1/settings/uei.clamp_zero", json={})
    assert resp.status_code == 422
    assert resp.json()["field_errors"][0]["field"] == "value"
