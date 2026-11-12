"""T03 验收：审计留痕与脱敏。

覆盖 T03 acceptance：记录业务与设置审计；过滤密码与密钥；日志不含密码。
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app.core.audit import REDACTED, assert_no_secrets, redact
from tests.conftest import MEMBER, PRIMARY, login


def _audit_items(client: TestClient, category: str | None = None) -> list[dict]:
    params = {"category": category} if category else {}
    body = client.get("/api/v1/audit-logs", params=params).json()
    return body["items"]


def _actions(client: TestClient, category: str | None = None) -> list[str]:
    return [item["action"] for item in _audit_items(client, category)]


def test_setup_and_login_are_audited(client: TestClient, setup_primary: dict) -> None:
    actions = _actions(client, "auth")
    assert "primary_account_created" in actions
    assert "login_succeeded" not in actions  # setup 不产生登录审计

    client.cookies.clear()
    login(client, PRIMARY["account"], PRIMARY["password"])
    actions = _actions(client, "auth")
    assert "login_succeeded" in actions


def test_failed_login_is_audited_without_password(client: TestClient, setup_primary: dict) -> None:
    client.cookies.clear()
    client.post("/api/v1/auth/login", json={"account": PRIMARY["account"], "password": "WrongPass123"})

    login(client, PRIMARY["account"], PRIMARY["password"])
    items = _audit_items(client, "auth")
    failures = [i for i in items if i["action"] == "login_failed"]
    assert failures, items
    assert "WrongPass123" not in json.dumps(failures, ensure_ascii=False)
    assert failures[0]["target_id"] == PRIMARY["account"]


def test_logout_is_audited(client: TestClient, setup_primary: dict) -> None:
    client.post("/api/v1/auth/logout")
    login(client, PRIMARY["account"], PRIMARY["password"])
    assert "logout" in _actions(client, "auth")


def test_setting_change_audit_records_before_after(client: TestClient, setup_primary: dict) -> None:
    resp = client.patch("/api/v1/settings/uei.clamp_zero", json={"value": "true"})
    assert resp.status_code == 200

    items = _audit_items(client, "setting")
    assert items, "设置变更必须留审计"
    entry = items[0]
    assert entry["action"] == "setting_updated"
    assert entry["target_id"] == "uei.clamp_zero"
    detail = json.loads(entry["detail"])
    assert detail["before"] == "false" and detail["after"] == "true"
    assert entry["actor_name"] == PRIMARY["name"]

    client.patch("/api/v1/settings/uei.clamp_zero", json={"value": "false"})


def test_account_created_and_status_audited(
    client: TestClient, setup_primary: dict, member_account: dict
) -> None:
    actions = _actions(client, "setting")
    assert "account_created" in actions

    client.patch(f"/api/v1/accounts/{member_account['id']}/status", json={"is_active": False})
    assert "account_status_changed" in _actions(client, "setting")


def test_audit_never_contains_plaintext_credentials(
    client: TestClient, setup_primary: dict, member_account: dict
) -> None:
    """核心断言：全部审计明细不得出现任何明文密码。"""
    client.post("/api/v1/auth/logout")
    client.post("/api/v1/auth/login", json={"account": PRIMARY["account"], "password": "WrongPass123"})
    login(client, PRIMARY["account"], PRIMARY["password"])
    client.patch("/api/v1/settings/uei.clamp_zero", json={"value": "true"})
    client.patch("/api/v1/settings/uei.clamp_zero", json={"value": "false"})

    blob = json.dumps(_audit_items(client), ensure_ascii=False)
    for secret in (PRIMARY["password"], MEMBER["password"], "WrongPass123"):
        assert secret not in blob, f"审计泄漏明文密码：{secret}"
    for banned in ("password_hash", "bcrypt_sha256$", "token_hash"):
        assert banned not in blob, f"审计泄漏敏感哈希字段：{banned}"


def test_audit_records_request_id_and_actor(client: TestClient, setup_primary: dict) -> None:
    client.patch(
        "/api/v1/settings/uei.clamp_zero",
        json={"value": "true"},
        headers={"X-Request-Id": "rid-audit-t03"},
    )
    entry = _audit_items(client, "setting")[0]
    assert entry["request_id"] == "rid-audit-t03"
    assert entry["actor_name"] == PRIMARY["name"]
    assert entry["actor_role"] == "experience_member"
    client.patch("/api/v1/settings/uei.clamp_zero", json={"value": "false"})


def test_audit_pagination(client: TestClient, setup_primary: dict) -> None:
    client.post("/api/v1/auth/logout")
    login(client, PRIMARY["account"], PRIMARY["password"])

    body = client.get("/api/v1/audit-logs", params={"page": 1, "page_size": 1}).json()
    assert body["page"] == 1 and body["page_size"] == 1
    assert len(body["items"]) == 1
    assert body["total"] >= 2


def test_audit_requires_login(client: TestClient, setup_primary: dict) -> None:
    client.cookies.clear()
    assert client.get("/api/v1/audit-logs").status_code == 401


# --- 脱敏工具单元测试 ---


def test_redact_masks_sensitive_keys_recursively() -> None:
    payload = {
        "account": "longbin",
        "password": "SuperSecret123",
        "nested": {"api_key": "sk-abcdef", "token": "abc.def", "keep": "ok"},
        "list": [{"passwd": "x"}, "plain"],
    }
    safe = redact(payload)
    assert safe["password"] == REDACTED
    assert safe["nested"]["api_key"] == REDACTED
    assert safe["nested"]["token"] == REDACTED
    assert safe["nested"]["keep"] == "ok"
    assert safe["list"][0]["passwd"] == REDACTED
    assert "SuperSecret123" not in json.dumps(safe, ensure_ascii=False)


def test_assert_no_secrets_detects_unmasked_password() -> None:
    assert_no_secrets({"password": REDACTED, "account": "x"})  # 已脱敏 → 通过
    try:
        assert_no_secrets({"password": "plaintext-leak"})
    except AssertionError:
        pass
    else:  # pragma: no cover - 自检必须能发现泄漏
        raise AssertionError("assert_no_secrets 未能识别未脱敏内容")
