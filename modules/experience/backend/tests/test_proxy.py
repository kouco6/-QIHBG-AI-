"""T07 验收：代录强制留痕、服务端生成代录人与时间、自填与代录区分。"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.core.security import new_id
from app.models.flow import Division, Project
from app.models.issue import PROXY_TARGET_ISSUE_COMMITMENT, PROXY_TARGET_ISSUE_REPLY, ProxyRecord
from app.models.review import ReviewSignature
from app.models.scoring import ScoringScheme
from app.models.systems import System
from tests.conftest import PRIMARY

SPOOFED_PROXY_BY = "attacker-account-id"
SPOOFED_PROXY_AT = "2000-01-01T00:00:00"


@pytest.fixture()
def project(session_factory: sessionmaker[Session]) -> dict[str, str]:
    ids = {
        "division_id": new_id(),
        "system_id": new_id(),
        "project_id": new_id(),
    }
    with session_factory() as db:
        scheme = (
            db.query(ScoringScheme)
            .filter(ScoringScheme.is_default.is_(True), ScoringScheme.is_active.is_(True))
            .first()
        )
        assert scheme is not None
        db.add(Division(id=ids["division_id"], code="DIV-PXY-001", name="产品事业部"))
        db.add(
            System(
                id=ids["system_id"],
                code="SYS-PXY-001",
                name="会议协作系统",
                division_id=ids["division_id"],
                scheme_id=scheme.id,
            )
        )
        db.add(
            Project(
                id=ids["project_id"],
                code="PRJ-PXY-001",
                name="会议一体机体验项目",
                system_id=ids["system_id"],
                version_code="V7.32",
                division_id=ids["division_id"],
                project_type="new_product",
            )
        )
        db.commit()
    return ids


def _create_issue(client: TestClient, project: dict[str, str]) -> dict:
    resp = client.post(
        "/api/v1/issues",
        json={
            "project_id": project["project_id"],
            "description": "代录跟踪问题",
            "business_level": "core",
            "severity": "normal",
            "module": "会议预约",
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _advance_to_reply(client: TestClient, issue: dict) -> None:
    assert client.post(f"/api/v1/issues/{issue['id']}/transition", json={"action": "submit"}).status_code == 200
    assert (
        client.post(
            f"/api/v1/issues/{issue['id']}/transition",
            json={"action": "confirm_classification", "extra": {"confirm": True}},
        ).status_code
        == 200
    )


def _audit_items(client: TestClient, category: str = "business") -> list[dict]:
    return client.get("/api/v1/audit-logs", params={"category": category}).json()["items"]


# --------------------------------------------------------------------------- 落库与生成


def test_proxy_record_fields_and_server_generated_identity(
    client: TestClient,
    setup_primary: dict,
    project: dict[str, str],
    session_factory: sessionmaker[Session],
) -> None:
    account_id = setup_primary["account"]["id"]
    issue = _create_issue(client, project)
    _advance_to_reply(client, issue)

    # 客户端传入 proxy_by / proxy_at 一律忽略
    resp = client.post(
        f"/api/v1/issues/{issue['id']}/transition",
        json={
            "action": "record_reply",
            "extra": {
                "division_reply": "已排期 V7.33 修复",
                "actual_provider": "李工",
                "proxy_by": SPOOFED_PROXY_BY,
                "proxy_at": SPOOFED_PROXY_AT,
            },
        },
    )
    assert resp.status_code == 200, resp.text
    detail = resp.json()
    proxy = detail["proxy_records"][0]

    assert proxy["actual_provider"] == "李工"
    assert proxy["target_type"] == PROXY_TARGET_ISSUE_REPLY
    assert proxy["target_type_label"] == "事业部回复"
    assert proxy["is_proxy"] is True
    # 服务端生成：代录人 = 当前会话账号，代录时间 = 服务器时间
    assert proxy["proxy_by"] == account_id
    assert proxy["proxy_by"] != SPOOFED_PROXY_BY
    assert proxy["proxy_by_name"] == PRIMARY["name"]
    assert proxy["proxy_at"] is not None
    assert not proxy["proxy_at"].startswith("2000-01-01")

    # 直接查库核对
    with session_factory() as db:
        rows = (
            db.execute(
                select(ProxyRecord).where(
                    ProxyRecord.issue_id == issue["id"], ProxyRecord.target_type == PROXY_TARGET_ISSUE_REPLY
                )
            )
            .scalars()
            .all()
        )
        assert len(rows) == 1
        record = rows[0]
        assert record.actual_provider == "李工"
        assert record.proxy_by == account_id
        assert record.proxy_by_name == PRIMARY["name"]
        assert record.proxy_at is not None
        assert record.field_key == "division_reply"
        assert record.proxy_at.year >= 2026


def test_solution_and_commitment_proxy_records(
    client: TestClient, setup_primary: dict, project: dict[str, str]
) -> None:
    issue = _create_issue(client, project)
    _advance_to_reply(client, issue)
    client.post(
        f"/api/v1/issues/{issue['id']}/transition",
        json={
            "action": "record_reply",
            "extra": {"division_reply": "已排期", "actual_provider": "李工"},
        },
    )
    resp = client.post(
        f"/api/v1/issues/{issue['id']}/transition",
        json={
            "action": "record_solution",
            "extra": {
                "solution": "补充历史会议室搜索",
                "committed_version": "V7.33",
                "actual_provider": "李工",
            },
        },
    )
    assert resp.status_code == 200, resp.text
    types = {p["target_type"] for p in resp.json()["proxy_records"]}
    assert PROXY_TARGET_ISSUE_REPLY in types
    assert PROXY_TARGET_ISSUE_COMMITMENT in types
    assert resp.json()["proxy_fields"] == {
        "division_reply": True,
        "solution": True,
        "committed_version": True,
    }


def test_review_signature_proxy_record_created(
    client: TestClient,
    setup_primary: dict,
    project: dict[str, str],
    session_factory: sessionmaker[Session],
) -> None:
    account_id = setup_primary["account"]["id"]
    review_resp = client.post(
        "/api/v1/reviews",
        json={"project_id": project["project_id"], "review_kind": "release", "title": "N13 发布体验评审"},
    )
    assert review_resp.status_code == 201, review_resp.text
    review_id = review_resp.json()["id"]

    sign = client.put(
        f"/api/v1/reviews/{review_id}/signatures",
        json={"department": "品管部", "actual_provider": "王主管", "proxy_by": SPOOFED_PROXY_BY},
    )
    assert sign.status_code == 200, sign.text

    with session_factory() as db:
        signature = (
            db.execute(
                select(ReviewSignature).where(
                    ReviewSignature.review_id == review_id, ReviewSignature.department == "品管部"
                )
            )
            .scalars()
            .first()
        )
        assert signature is not None
        assert signature.actual_provider == "王主管"
        assert signature.proxy_by == account_id
        assert signature.proxy_by_name == PRIMARY["name"]
        assert signature.proxy_at is not None

        proxy = (
            db.execute(
                select(ProxyRecord).where(
                    ProxyRecord.target_type == "review_signature", ProxyRecord.target_id == signature.id
                )
            )
            .scalars()
            .first()
        )
        assert proxy is not None
        assert proxy.actual_provider == "王主管"
        assert proxy.proxy_by == account_id
        assert proxy.provider_department == "品管部"


# --------------------------------------------------------------------------- 自填 vs 代录


def test_self_filled_and_proxy_are_distinguishable(
    client: TestClient, setup_primary: dict, project: dict[str, str]
) -> None:
    # 纯自填问题：无任何代录
    self_filled = _create_issue(client, project)
    detail = client.get(f"/api/v1/issues/{self_filled['id']}").json()
    assert detail["is_proxy"] is False
    assert detail["proxy_records"] == []
    assert detail["proxy_fields"] == {
        "division_reply": False,
        "solution": False,
        "committed_version": False,
    }

    # 代录问题：区分字段与记录
    proxied = _create_issue(client, project)
    _advance_to_reply(client, proxied)
    client.post(
        f"/api/v1/issues/{proxied['id']}/transition",
        json={"action": "record_reply", "extra": {"division_reply": "已修复", "actual_provider": "李工"}},
    )
    # 体验人员自填备注（非代录字段）
    patched = client.patch(f"/api/v1/issues/{proxied['id']}", json={"note": "体验人员自填备注"})
    assert patched.status_code == 200
    detail = patched.json()
    assert detail["is_proxy"] is True
    assert detail["note"] == "体验人员自填备注"
    assert detail["proxy_fields"] == {
        "division_reply": True,
        "solution": False,
        "committed_version": False,
    }
    assert all(p["is_proxy"] is True for p in detail["proxy_records"])


# --------------------------------------------------------------------------- 审计


def test_proxy_audit_detail_has_no_sensitive_fields(
    client: TestClient, setup_primary: dict, project: dict[str, str]
) -> None:
    issue = _create_issue(client, project)
    _advance_to_reply(client, issue)
    client.post(
        f"/api/v1/issues/{issue['id']}/transition",
        json={
            "action": "record_reply",
            "extra": {"division_reply": "已排期", "actual_provider": "李工"},
        },
    )

    items = [i for i in _audit_items(client) if i["action"] == "issue_proxy_recorded"]
    assert items, "代录必须写业务审计"
    entry = items[0]
    detail = json.loads(entry["detail"])
    assert detail["actual_provider"] == "李工"
    assert detail["proxy_by"]
    assert detail["is_proxy"] is True

    blob = json.dumps(items, ensure_ascii=False).lower()
    for banned in ("password", "passwd", "secret", "token", "api_key", "hash"):
        assert banned not in blob, f"审计泄漏敏感字段：{banned}"
    assert PRIMARY["password"].lower() not in blob
