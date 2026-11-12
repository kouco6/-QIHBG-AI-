"""T13 验收：AI 会话持久化、上下文范围校验、Mock 助手摘要与重试。"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.core.security import new_id
from app.models.flow import Division, Project
from app.models.issue import Issue
from app.models.systems import System


# --------------------------------------------------------------------------- 夹具


def _make_project(db: Session, *, code: str, issue_count: int) -> dict[str, object]:
    ids: dict[str, object] = {
        "division_id": new_id(),
        "system_id": new_id(),
        "project_id": new_id(),
        "issue_ids": [],
    }
    db.add(Division(id=ids["division_id"], code=f"DIV-{code}", name="会议事业部"))
    db.add(
        System(
            id=ids["system_id"],
            code=f"SYS-{code}",
            name="会议协作系统",
            division_id=ids["division_id"],
            scheme_id="scheme-default",
        )
    )
    db.add(
        Project(
            id=ids["project_id"],
            code=f"PRJ-{code}",
            name=f"体验项目 {code}",
            system_id=ids["system_id"],
            version_code="V7.32",
            division_id=ids["division_id"],
            project_type="new_product",
        )
    )
    for idx in range(1, issue_count + 1):
        issue_id = new_id()
        ids["issue_ids"].append(issue_id)  # type: ignore[union-attr]
        db.add(
            Issue(
                id=issue_id,
                code=f"ISS-{code}-{idx:04d}",
                project_id=ids["project_id"],
                system_id=ids["system_id"],
                division_id=ids["division_id"],
                module="会议预约" if idx % 2 else "白板协作",
                business_level="core",
                severity="major",
                metric_l1="易用性",
                status="in_progress" if idx % 2 else "closed",
                description=f"分析用问题 {idx}",
            )
        )
    return ids


@pytest.fixture()
def projects(session_factory: sessionmaker[Session]) -> dict[str, dict[str, object]]:
    with session_factory() as db:
        main = _make_project(db, code="AI-001", issue_count=4)
        other = _make_project(db, code="AI-002", issue_count=2)
        db.commit()
    return {"main": main, "other": other}


def _create_conversation(client: TestClient, project: dict[str, object], **overrides) -> tuple[int, dict]:
    body = {
        "project_id": project["project_id"],
        "title": "体验问题汇总分析",
        "scope_type": "project",
        "scope": {},
        **overrides,
    }
    resp = client.post("/api/v1/ai-conversations", json=body)
    return resp.status_code, resp.json()


# --------------------------------------------------------------------------- 用例


def test_create_conversation_is_persisted_with_mock_mode(
    client: TestClient, setup_primary: dict, projects: dict[str, dict[str, object]]
) -> None:
    code, conv = _create_conversation(client, projects["main"])
    assert code == 201, conv
    assert conv["mode"] == "mock"
    assert conv["is_mock"] is True
    assert conv["scope_type"] == "project"
    assert conv["messages"] == []

    listing = client.get("/api/v1/ai-conversations", params={"project_id": projects["main"]["project_id"]}).json()
    assert listing["total"] == 1
    assert listing["items"][0]["mode"] == "mock"


def test_send_message_returns_mock_assistant_summary_and_persists(
    client: TestClient, setup_primary: dict, projects: dict[str, dict[str, object]]
) -> None:
    _code, conv = _create_conversation(client, projects["main"])
    resp = client.post(
        f"/api/v1/ai-conversations/{conv['id']}/messages",
        json={"content": "请汇总本项目体验问题"},
    )
    assert resp.status_code == 201, resp.text
    payload = resp.json()
    assert payload["user_message"]["role"] == "user"
    assert payload["assistant_message"]["role"] == "assistant"
    assert payload["assistant_message"]["is_mock"] is True
    assert "本地模拟分析" in payload["assistant_message"]["content"]
    # N 来自实际数据（本项目 4 条问题），不得编造
    assert "4 条问题" in payload["assistant_message"]["content"]
    assert payload["job"]["mode"] == "mock"
    assert payload["job"]["is_mock"] is True
    assert payload["job"]["receipt"]["external_id"].startswith("mock_ai_")

    # 刷新 / 重开：重新请求会话详情，消息仍在（全部来自数据库）
    detail = client.get(f"/api/v1/ai-conversations/{conv['id']}").json()
    assert len(detail["messages"]) == 2
    assert detail["messages"][0]["content"] == "请汇总本项目体验问题"
    assert detail["messages"][1]["job_id"] == payload["job"]["id"]


def test_scope_with_foreign_entity_id_is_rejected(
    client: TestClient, setup_primary: dict, projects: dict[str, dict[str, object]]
) -> None:
    foreign_issue = str(projects["other"]["issue_ids"][0])  # type: ignore[index]
    code, payload = _create_conversation(
        client,
        projects["main"],
        scope_type="issues",
        scope={"issue_ids": [foreign_issue]},
    )
    assert code == 422, payload
    assert any("不属于项目" in err["message"] for err in payload["field_errors"])

    # 本项目的实体 ID 可以正常使用
    own_issue = str(projects["main"]["issue_ids"][0])  # type: ignore[index]
    ok_code, ok_payload = _create_conversation(
        client,
        projects["main"],
        scope_type="issues",
        scope={"issue_ids": [own_issue]},
    )
    assert ok_code == 201, ok_payload


def test_invalid_scope_type_rejected(client: TestClient, setup_primary: dict, projects: dict[str, dict[str, object]]) -> None:
    code, payload = _create_conversation(client, projects["main"], scope_type="unknown")
    assert code == 422, payload


def test_retry_creates_new_job(
    client: TestClient, setup_primary: dict, projects: dict[str, dict[str, object]]
) -> None:
    _code, conv = _create_conversation(client, projects["main"])
    first = client.post(
        f"/api/v1/ai-conversations/{conv['id']}/messages", json={"content": "先做一次分析"}
    ).json()
    first_job_id = first["job"]["id"]

    retry = client.post(f"/api/v1/ai-conversations/{conv['id']}/retry")
    assert retry.status_code == 200, retry.text
    retried = retry.json()
    assert retried["job"]["id"] != first_job_id
    assert retried["retried_from"] == first["assistant_message"]["id"]
    assert retried["assistant_message"]["is_mock"] is True

    detail = client.get(f"/api/v1/ai-conversations/{conv['id']}").json()
    assert len(detail["messages"]) == 3  # user + assistant + retry assistant


def test_blank_message_rejected(client: TestClient, setup_primary: dict, projects: dict[str, dict[str, object]]) -> None:
    _code, conv = _create_conversation(client, projects["main"])
    resp = client.post(f"/api/v1/ai-conversations/{conv['id']}/messages", json={"content": "   "})
    assert resp.status_code == 422, resp.text


def test_context_summary_aggregates_from_real_data(
    client: TestClient, setup_primary: dict, projects: dict[str, dict[str, object]]
) -> None:
    _code, conv = _create_conversation(client, projects["main"])
    summary = client.get(f"/api/v1/ai-conversations/{conv['id']}/context-summary").json()
    assert summary["issue_total"] == 4
    assert summary["is_mock"] is True
    assert summary["mode"] == "mock"
    assert summary["by_module"] == {"会议预约": 2, "白板协作": 2}
    assert summary["by_business_level"] == {"core": 4}
    assert "本地统计" in summary["generated_from"]

    # 筛选问题集范围只统计被选中的问题
    own_issue = str(projects["main"]["issue_ids"][0])  # type: ignore[index]
    _c2, conv2 = _create_conversation(
        client, projects["main"], scope_type="issues", scope={"issue_ids": [own_issue]}
    )
    summary2 = client.get(f"/api/v1/ai-conversations/{conv2['id']}/context-summary").json()
    assert summary2["issue_total"] == 1


def test_ai_endpoints_require_login(client: TestClient) -> None:
    assert client.get("/api/v1/ai-conversations").status_code == 401
    assert client.post("/api/v1/ai-conversations", json={"project_id": new_id()}).status_code == 401


def test_unknown_conversation_returns_404(client: TestClient, setup_primary: dict) -> None:
    assert client.get(f"/api/v1/ai-conversations/{new_id()}").status_code == 404
