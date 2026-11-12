"""T13 验收：协作空间讨论串、消息校验、代录与关闭语义。"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.core.security import new_id
from app.models.flow import Division, Project
from app.models.issue import Issue
from app.models.systems import System


# --------------------------------------------------------------------------- 夹具


@pytest.fixture()
def project(session_factory: sessionmaker[Session]) -> dict[str, object]:
    ids: dict[str, object] = {
        "division_id": new_id(),
        "system_id": new_id(),
        "project_id": new_id(),
        "issue_id": new_id(),
    }
    with session_factory() as db:
        db.add(Division(id=ids["division_id"], code="DIV-COL-001", name="会议事业部"))
        db.add(
            System(
                id=ids["system_id"],
                code="SYS-COL-001",
                name="会议协作系统",
                division_id=ids["division_id"],
                scheme_id="scheme-default",
            )
        )
        db.add(
            Project(
                id=ids["project_id"],
                code="PRJ-COL-001",
                name="会议一体机体验项目",
                system_id=ids["system_id"],
                version_code="V7.32",
                division_id=ids["division_id"],
                project_type="new_product",
            )
        )
        db.add(
            Issue(
                id=ids["issue_id"],
                code="ISS-COL-001-0001",
                project_id=ids["project_id"],
                module="会议预约",
                description="讨论引用问题",
            )
        )
        db.commit()
    return ids


def _create_thread(client: TestClient, project: dict[str, object], title: str = "关于会议预约入口的讨论") -> dict:
    resp = client.post(
        "/api/v1/collaboration/threads",
        json={"project_id": project["project_id"], "title": title, "node_code": "N07"},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _post(client: TestClient, thread_id: str, **body) -> tuple[int, dict]:
    resp = client.post(f"/api/v1/collaboration/threads/{thread_id}/messages", json=body)
    return resp.status_code, resp.json()


# --------------------------------------------------------------------------- 用例


def test_thread_and_message_flow_updates_reply_count(
    client: TestClient, setup_primary: dict, project: dict[str, object]
) -> None:
    thread = _create_thread(client, project)
    assert thread["status"] == "open"
    assert thread["reply_count"] == 0
    assert thread["last_reply_at"] is None

    code, payload = _post(
        client,
        thread["id"],
        body="  首条讨论内容  ",
        ref_type="issue",
        ref_id=str(project["issue_id"]),
    )
    assert code == 201, payload
    assert payload["message"]["body"] == "首条讨论内容"  # 去纯空白
    assert payload["message"]["ref_label"] == "ISS-COL-001-0001"
    assert payload["thread"]["reply_count"] == 1
    assert payload["thread"]["last_reply_at"] is not None

    code2, _ = _post(client, thread["id"], body="第二条回复")
    assert code2 == 201

    detail = client.get(f"/api/v1/collaboration/threads/{thread['id']}").json()
    assert detail["reply_count"] == 2
    assert len(detail["messages"]) == 2
    assert detail["messages"][0]["author_name"] == setup_primary["account"]["name"]


def test_thread_list_filters_by_project(client: TestClient, setup_primary: dict, project: dict[str, object]) -> None:
    _create_thread(client, project, "线程 A")
    _create_thread(client, project, "线程 B")
    listing = client.get("/api/v1/collaboration/threads", params={"project_id": project["project_id"]}).json()
    assert listing["total"] == 2
    assert {item["title"] for item in listing["items"]} == {"线程 A", "线程 B"}


def test_blank_body_rejected(client: TestClient, setup_primary: dict, project: dict[str, object]) -> None:
    thread = _create_thread(client, project)
    code, payload = _post(client, thread["id"], body="   \n\t  ")
    assert code == 422, payload
    assert payload["code"] == "validation_error"
    assert any(err["field"] == "body" for err in payload["field_errors"])


def test_overlong_body_rejected(client: TestClient, setup_primary: dict, project: dict[str, object]) -> None:
    thread = _create_thread(client, project)
    code, payload = _post(client, thread["id"], body="长" * 4001)
    assert code == 422, payload
    assert any("4000" in err["message"] for err in payload["field_errors"])


def test_proxy_message_requires_actual_provider(
    client: TestClient, setup_primary: dict, project: dict[str, object]
) -> None:
    thread = _create_thread(client, project)
    code, payload = _post(client, thread["id"], body="事业部口头意见", is_proxy=True)
    assert code == 422, payload
    assert any(err["field"] == "actual_provider" for err in payload["field_errors"])

    ok_code, ok_payload = _post(
        client, thread["id"], body="事业部口头意见", is_proxy=True, actual_provider="张工"
    )
    assert ok_code == 201, ok_payload
    assert ok_payload["message"]["is_proxy"] is True
    assert ok_payload["message"]["actual_provider"] == "张工"


def test_closed_thread_rejects_new_messages(
    client: TestClient, setup_primary: dict, project: dict[str, object]
) -> None:
    thread = _create_thread(client, project)
    close = client.post(f"/api/v1/collaboration/threads/{thread['id']}/close")
    assert close.status_code == 200, close.text
    assert close.json()["status"] == "closed"

    code, payload = _post(client, thread["id"], body="关闭后仍想发言")
    assert code == 409, payload
    assert payload["code"] == "thread_closed"

    # 关闭后仍可读
    assert client.get(f"/api/v1/collaboration/threads/{thread['id']}").status_code == 200


def test_thread_title_required(client: TestClient, setup_primary: dict, project: dict[str, object]) -> None:
    resp = client.post(
        "/api/v1/collaboration/threads",
        json={"project_id": project["project_id"], "title": ""},
    )
    assert resp.status_code == 422, resp.text


def test_thread_project_must_exist(client: TestClient, setup_primary: dict) -> None:
    resp = client.post(
        "/api/v1/collaboration/threads",
        json={"project_id": new_id(), "title": "孤儿讨论"},
    )
    assert resp.status_code == 404, resp.text


def test_collaboration_requires_login(client: TestClient, project: dict[str, object]) -> None:
    assert client.get("/api/v1/collaboration/threads").status_code == 401
    assert (
        client.post(
            "/api/v1/collaboration/threads",
            json={"project_id": project["project_id"], "title": "x"},
        ).status_code
        == 401
    )


def test_unknown_thread_returns_404(client: TestClient, setup_primary: dict) -> None:
    assert client.get(f"/api/v1/collaboration/threads/{new_id()}").status_code == 404
