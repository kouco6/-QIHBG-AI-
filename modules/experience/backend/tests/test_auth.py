"""T03 验收：账号、首账号边界、会话与密码。

覆盖 ACCEPTANCE §启动与账号 与 T03 验收步骤：
- 首次启动只能初始化一个首账号，后续 /setup 不可再次创建；
- 未登录 401；账号启停；密码强度；登录不暴露账号存在性；
- 响应与日志不含密码字段。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import MEMBER, PRIMARY, login


def test_bootstrap_needs_setup_on_empty_db(client: TestClient) -> None:
    body = client.get("/api/v1/auth/bootstrap").json()
    assert body["needs_setup"] is True
    assert body["account_count"] == 0
    assert body["role_model"] == "single-experience-member"


def test_setup_creates_primary_and_auto_login(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/auth/setup",
        json={**PRIMARY, "confirm_password": PRIMARY["password"]},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["account"]["is_primary"] is True
    assert body["account"]["is_active"] is True
    assert body["account"]["account"] == PRIMARY["account"]
    assert body["account"]["role"] == "experience_member"
    assert body["expires_at"]

    # 自动登录：Cookie 生效，/me 可直接访问
    me = client.get("/api/v1/auth/me")
    assert me.status_code == 200
    assert me.json()["account"] == PRIMARY["account"]

    # 初始化入口关闭
    assert client.get("/api/v1/auth/bootstrap").json() == {
        "needs_setup": False,
        "account_count": 1,
        "role_model": "single-experience-member",
    }


def test_setup_cannot_run_twice(client: TestClient, setup_primary: dict) -> None:
    """T03：后续 /setup 不可再次创建首账号。"""
    resp = client.post(
        "/api/v1/auth/setup",
        json={"name": "冒名者", "account": "hacker", "password": "Hacker12345", "confirm_password": "Hacker12345"},
    )
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["code"] == "setup_closed"
    assert body["request_id"]


def test_setup_rejects_password_mismatch(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/auth/setup",
        json={**PRIMARY, "confirm_password": "AnotherPass123"},
    )
    assert resp.status_code == 422
    assert resp.json()["field_errors"][0]["field"] == "confirm_password"


def test_setup_rejects_weak_password(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/auth/setup",
        json={"name": "弱密码", "account": "weakpwd", "password": "12345678", "confirm_password": "12345678"},
    )
    assert resp.status_code == 422
    fields = {e["field"] for e in resp.json()["field_errors"]}
    assert "password" in fields


def test_login_does_not_leak_account_existence(client: TestClient, setup_primary: dict) -> None:
    """账号不存在与密码错误必须返回完全相同的错误形状。"""
    wrong_pwd = client.post(
        "/api/v1/auth/login", json={"account": PRIMARY["account"], "password": "WrongPass123"}
    )
    no_such = client.post(
        "/api/v1/auth/login", json={"account": "ghost-account", "password": "WrongPass123"}
    )
    assert wrong_pwd.status_code == no_such.status_code == 401
    assert wrong_pwd.json()["message"] == no_such.json()["message"]
    assert wrong_pwd.json()["code"] == no_such.json()["code"] == "unauthorized"


def test_login_and_logout_lifecycle(client: TestClient, setup_primary: dict) -> None:
    client.cookies.clear()
    assert client.get("/api/v1/auth/me").status_code == 401

    login(client, PRIMARY["account"], PRIMARY["password"])
    assert client.get("/api/v1/auth/me").status_code == 200

    out = client.post("/api/v1/auth/logout")
    assert out.status_code == 200
    assert client.get("/api/v1/auth/me").status_code == 401


def test_me_never_returns_password_fields(client: TestClient, setup_primary: dict) -> None:
    body = client.get("/api/v1/auth/me").json()
    assert "password" not in body and "password_hash" not in body
    assert set(body) == {"id", "account", "name", "role", "is_primary", "is_active", "last_login_at", "created_at"}


def test_last_login_updated(client: TestClient, setup_primary: dict) -> None:
    client.cookies.clear()
    login(client, PRIMARY["account"], PRIMARY["password"])
    assert client.get("/api/v1/auth/me").json()["last_login_at"]


def test_sessions_listing_marks_current(client: TestClient, setup_primary: dict) -> None:
    rows = client.get("/api/v1/auth/sessions").json()
    assert len(rows) == 1
    assert rows[0]["current"] is True
    assert rows[0]["expires_at"]


def test_password_change_revokes_other_sessions(
    client: TestClient, setup_primary: dict, new_client
) -> None:
    second = new_client()
    login(second, PRIMARY["account"], PRIMARY["password"])
    assert second.get("/api/v1/auth/me").status_code == 200

    resp = client.post(
        "/api/v1/auth/password",
        json={
            "current_password": PRIMARY["password"],
            "new_password": "RotatedPass2026",
            "confirm_password": "RotatedPass2026",
        },
    )
    assert resp.status_code == 200, resp.text

    # 其他会话被撤销，当前会话保留
    assert second.get("/api/v1/auth/me").status_code == 401
    assert client.get("/api/v1/auth/me").status_code == 200

    # 旧密码失效、新密码可登录
    client.cookies.clear()
    assert client.post(
        "/api/v1/auth/login", json={"account": PRIMARY["account"], "password": PRIMARY["password"]}
    ).status_code == 401
    login(client, PRIMARY["account"], "RotatedPass2026")


def test_password_change_requires_correct_current(client: TestClient, setup_primary: dict) -> None:
    resp = client.post(
        "/api/v1/auth/password",
        json={"current_password": "WrongCurrent1", "new_password": "NewPass2026", "confirm_password": "NewPass2026"},
    )
    assert resp.status_code == 422
    assert resp.json()["field_errors"][0]["field"] == "current_password"


def test_disabled_account_cannot_login_and_sessions_die(
    client: TestClient, setup_primary: dict, member_account: dict, new_client
) -> None:
    """账号启停：停用后不可登录，且既有会话立即失效。"""
    member_client = new_client()
    login(member_client, MEMBER["account"], MEMBER["password"])
    assert member_client.get("/api/v1/auth/me").status_code == 200

    disabled = client.patch(
        f"/api/v1/accounts/{member_account['id']}/status", json={"is_active": False}
    )
    assert disabled.status_code == 200, disabled.text
    assert disabled.json()["is_active"] is False

    # 既有会话立即失效
    assert member_client.get("/api/v1/auth/me").status_code == 401
    # 不可再登录
    resp = member_client.post(
        "/api/v1/auth/login", json={"account": MEMBER["account"], "password": MEMBER["password"]}
    )
    assert resp.status_code == 401
    assert resp.json()["code"] == "account_disabled"


def test_bearer_token_accepted_as_alternative(client: TestClient, setup_primary: dict, new_client) -> None:
    """非浏览器客户端可用 Authorization: Bearer <token> 访问。"""
    raw = new_client()
    resp = raw.post(
        "/api/v1/auth/login", json={"account": PRIMARY["account"], "password": PRIMARY["password"]}
    )
    token = raw.cookies.get("uei_session")
    assert token, resp.text
    raw.cookies.clear()  # 纯 Bearer 场景，排除 Cookie 干扰
    resp2 = raw.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert resp2.status_code == 200
