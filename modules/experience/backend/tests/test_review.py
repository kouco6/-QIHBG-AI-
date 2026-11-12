"""T07 验收：三段式评审工作区、争议决策、归档前置条件与部门签署代录。

v1.1：产品 / 产品版本已合并为「系统 + 项目」，版本号在 ``project.version_code`` 上。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.core.security import new_id
from app.core.timeutil import utcnow
from app.domain.templates import REVIEW_SIGN_DEPARTMENTS
from app.models.flow import Division, Project
from app.models.issue import Issue
from app.models.review import ReviewSignature
from app.models.scoring import ProjectScoreSnapshot, ScoringScheme
from app.models.systems import System


# --------------------------------------------------------------------------- 夹具


@pytest.fixture()
def project(session_factory: sessionmaker[Session]) -> dict[str, str]:
    ids = {
        "division_id": new_id(),
        "system_id": new_id(),
        "project_id": new_id(),
        "issue_id": new_id(),
    }
    with session_factory() as db:
        scheme = (
            db.execute(select(ScoringScheme).where(ScoringScheme.is_default.is_(True))).scalars().first()
        )
        assert scheme is not None
        db.add(Division(id=ids["division_id"], code="DIV-REV-001", name="产品事业部"))
        db.add(
            System(
                id=ids["system_id"],
                code="SYS-REV-001",
                name="会议协作系统",
                scheme_id=scheme.id,
                division_id=ids["division_id"],
            )
        )
        db.add(
            Project(
                id=ids["project_id"],
                code="PRJ-REV-001",
                name="会议一体机体验项目",
                system_id=ids["system_id"],
                division_id=ids["division_id"],
                version_code="V7.32",
                project_type="new_product",
            )
        )
        db.add(
            Issue(
                id=ids["issue_id"],
                code="ISS-PRJ-REV-001-0001",
                project_id=ids["project_id"],
                system_id=ids["system_id"],
                division_id=ids["division_id"],
                module="会议预约",
                description="评审前汇总的体验问题",
                business_level="core",
                severity="major",
                pre_business_level="core",
                pre_severity="major",
                status="pending_reply",
            )
        )
        db.commit()
    return ids


TITLE = "N13 发布体验评审"


def _create_review(client: TestClient, project: dict[str, str], title: str = TITLE) -> dict:
    resp = client.post(
        "/api/v1/reviews",
        json={"project_id": project["project_id"], "review_kind": "release", "title": title},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _transition(client: TestClient, review_id: str, action: str, **body) -> tuple[int, dict]:
    resp = client.post(f"/api/v1/reviews/{review_id}/transition", json={"action": action, **body})
    return resp.status_code, resp.json()


def _start(client: TestClient, review: dict) -> None:
    code, body = _transition(
        client, review["id"], "start", scope={"filters": {"project_id": review["project_id"]}}
    )
    assert code == 200, body


def _finish(client: TestClient, review: dict, *, with_decision: bool = False) -> None:
    if with_decision:
        created = client.post(
            f"/api/v1/reviews/{review['id']}/decisions",
            json={"dispute": "严重等级是否应降为一般", "issue_id": None},
        ).json()
        decision_id = created["decision"]["id"]
        patched = client.patch(
            f"/api/v1/reviews/{review['id']}/decisions/{decision_id}",
            json={"status": "decided", "decision": "维持严重等级"},
        )
        assert patched.status_code == 200, patched.text
    code, body = _transition(client, review["id"], "finish")
    assert code == 200, body


def _fill_signatures(client: TestClient, review_id: str) -> None:
    for department in REVIEW_SIGN_DEPARTMENTS:
        resp = client.put(
            f"/api/v1/reviews/{review_id}/signatures",
            json={"department": department, "actual_provider": f"{department}负责人", "is_approved": True},
        )
        assert resp.status_code == 200, resp.text


def _make_snapshot(session_factory: sessionmaker[Session], project: dict[str, str]) -> str:
    with session_factory() as db:
        scheme = (
            db.execute(
                select(ScoringScheme).where(
                    ScoringScheme.is_default.is_(True), ScoringScheme.is_active.is_(True)
                )
            )
            .scalars()
            .first()
        )
        snapshot = ProjectScoreSnapshot(
            id=new_id(),
            scope="project",
            project_id=project["project_id"],
            project_name="会议一体机体验项目",
            version_code="V7.32",
            division_id=project["division_id"],
            scheme_id=scheme.id,
            scheme_code=scheme.code,
            scheme_business_ratio=scheme.business_ratio,
            scheme_problem_ratio=scheme.problem_ratio,
            issue_count=1,
            raw_uei="39.4",
            display_uei="39.4",
            snapshot_at=utcnow(),
            created_by="tester",
            created_by_name="测试",
        )
        db.add(snapshot)
        db.commit()
        return snapshot.id


# --------------------------------------------------------------------------- 创建


def test_create_review_presets_six_departments(
    client: TestClient, setup_primary: dict, project: dict[str, str]
) -> None:
    review = _create_review(client, project)

    assert review["code"] == "REV-PRJ-REV-001-001"
    assert review["stage"] == "before"
    signatures = review["signatures"]
    assert signatures["total"] == 6
    assert signatures["filled"] == 0
    assert signatures["complete"] is False
    assert [item["department"] for item in signatures["items"]] == list(REVIEW_SIGN_DEPARTMENTS)
    assert all(item["is_proxy"] is True for item in signatures["items"])
    assert all(item["actual_provider"] == "" for item in signatures["items"])
    # 签署行确实落库
    detail = client.get(f"/api/v1/reviews/{review['id']}").json()
    assert len(detail["signatures"]["items"]) == 6


def test_review_kind_and_login_validation(client: TestClient, setup_primary: dict, project: dict[str, str]) -> None:
    bad = client.post(
        "/api/v1/reviews",
        json={"project_id": project["project_id"], "review_kind": "unknown", "title": "x"},
    )
    assert bad.status_code == 422

    not_found = client.post(
        "/api/v1/reviews",
        json={"project_id": "missing", "review_kind": "release", "title": "x"},
    )
    assert not_found.status_code == 404


# --------------------------------------------------------------------------- 争议与阶段


def test_open_dispute_blocks_during_to_after(
    client: TestClient, setup_primary: dict, project: dict[str, str]
) -> None:
    review = _create_review(client, project)
    _start(client, review)

    created = client.post(
        f"/api/v1/reviews/{review['id']}/decisions",
        json={"dispute": "该问题是否为核心业务"},
    )
    assert created.status_code == 201, created.text
    decision_id = created.json()["decision"]["id"]

    code, body = _transition(client, review["id"], "finish")
    assert code == 409, body
    assert body["code"] == "precondition_failed"
    assert "disputes_decided" in body["failed_guards"]

    # open → decided 必须有决策内容
    no_decision = client.patch(
        f"/api/v1/reviews/{review['id']}/decisions/{decision_id}",
        json={"status": "decided"},
    )
    assert no_decision.status_code == 422

    ok = client.patch(
        f"/api/v1/reviews/{review['id']}/decisions/{decision_id}",
        json={"status": "decided", "decision": "维持核心业务分类", "committed_version": "V7.33"},
    )
    assert ok.status_code == 200, ok.text

    code, body = _transition(client, review["id"], "finish")
    assert code == 200, body
    assert body["stage"] == "after"


def test_decision_dispute_required(client: TestClient, setup_primary: dict, project: dict[str, str]) -> None:
    review = _create_review(client, project)
    _start(client, review)
    resp = client.post(f"/api/v1/reviews/{review['id']}/decisions", json={"dispute": ""})
    assert resp.status_code == 422


def test_illegal_review_transition(client: TestClient, setup_primary: dict, project: dict[str, str]) -> None:
    review = _create_review(client, project)
    code, body = _transition(client, review["id"], "archive", confirm_text=TITLE)
    assert code == 409
    assert body["code"] == "illegal_transition"
    assert body["current"] == "before"
    assert body["allowed_targets"] == ["during"]

    _start(client, review)
    # 退回需理由
    code, _ = _transition(client, review["id"], "return")
    assert code == 422
    code, body = _transition(client, review["id"], "return", reason="资料不全")
    assert code == 200
    assert body["stage"] == "before"


# --------------------------------------------------------------------------- 归档前置条件


def test_archive_requires_confirm_text(
    client: TestClient, setup_primary: dict, project: dict[str, str]
) -> None:
    review = _create_review(client, project)
    _start(client, review)
    _finish(client, review)

    code, body = _transition(client, review["id"], "archive", confirm_text="错误的标题")
    assert code == 422
    assert body["code"] == "validation_error"


def test_archive_preconditions_each_block(
    client: TestClient, setup_primary: dict, project: dict[str, str], session_factory: sessionmaker[Session]
) -> None:
    review = _create_review(client, project)
    _start(client, review)
    _finish(client, review)

    # 1) 缺签署实际提供人 → proxy_complete 409
    code, body = _transition(client, review["id"], "archive", confirm_text=TITLE)
    assert code == 409, body
    assert "proxy_complete" in body["failed_guards"]

    # 2) 缺最终分类 → final_classification 409
    _fill_signatures(client, review["id"])
    code, body = _transition(client, review["id"], "archive", confirm_text=TITLE)
    assert code == 409, body
    assert "final_classification" in body["failed_guards"]

    # 确认问题最终分类
    patched = client.patch(
        f"/api/v1/issues/{project['issue_id']}",
        json={"final_business_level": "core", "final_severity": "normal", "confirm_final": True},
    )
    assert patched.status_code == 200, patched.text

    # 3) 缺 L1 快照 → l1_snapshot_ready 409
    code, body = _transition(client, review["id"], "archive", confirm_text=TITLE)
    assert code == 409, body
    assert "l1_snapshot_ready" in body["failed_guards"]

    # 4) 全部满足 → 归档成功
    snapshot_id = _make_snapshot(session_factory, project)
    code, body = _transition(client, review["id"], "archive", confirm_text=TITLE, snapshot_id=snapshot_id)
    assert code == 200, body
    assert body["stage"] == "archived"
    assert body["archived_at"] is not None
    assert body["final_snapshot_id"] == snapshot_id
    assert body["archive_confirm_text"] == TITLE


def test_archive_unknown_snapshot_returns_404(
    client: TestClient, setup_primary: dict, project: dict[str, str]
) -> None:
    review = _create_review(client, project)
    _start(client, review)
    _finish(client, review, with_decision=False)
    _fill_signatures(client, review["id"])
    client.patch(
        f"/api/v1/issues/{project['issue_id']}",
        json={"final_business_level": "core", "final_severity": "normal", "confirm_final": True},
    )
    code, body = _transition(client, review["id"], "archive", confirm_text=TITLE, snapshot_id="missing")
    assert code == 404


def test_scope_locked_requires_scope(
    client: TestClient, setup_primary: dict, project: dict[str, str]
) -> None:
    review = _create_review(client, project)
    code, body = _transition(client, review["id"], "start")
    assert code == 422
    assert body["code"] == "validation_error"

    code, body = _transition(
        client, review["id"], "start", scope={"issue_ids": [project["issue_id"]]}
    )
    assert code == 200
    assert body["scope_locked_at"] is not None
    assert body["tabs"]["before"]["issue_summary"]["total"] == 1


# --------------------------------------------------------------------------- 签署


def test_signature_proxy_enforced(
    client: TestClient, setup_primary: dict, project: dict[str, str]
) -> None:
    review = _create_review(client, project)

    missing = client.put(
        f"/api/v1/reviews/{review['id']}/signatures",
        json={"department": "研发部门"},
    )
    assert missing.status_code == 422
    assert "实际提供人" in missing.json()["message"]

    invalid = client.put(
        f"/api/v1/reviews/{review['id']}/signatures",
        json={"department": "不存在的部门", "actual_provider": "张三"},
    )
    assert invalid.status_code == 422

    ok = client.put(
        f"/api/v1/reviews/{review['id']}/signatures",
        json={"department": "研发部门", "actual_provider": "李工", "principal": "李工", "opinion": "同意"},
    )
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["completeness"]["filled"] == 1
    assert body["completeness"]["total"] == 6
    assert body["completeness"]["complete"] is False
    assert body["signature"]["is_proxy"] is True
    assert body["signature"]["actual_provider"] == "李工"

    # 全部签署后 complete
    _fill_signatures(client, review["id"])
    detail = client.get(f"/api/v1/reviews/{review['id']}").json()
    assert detail["signatures"]["filled"] == 6
    assert detail["signatures"]["complete"] is True


def test_review_list_and_requires_login(
    client: TestClient, setup_primary: dict, project: dict[str, str]
) -> None:
    _create_review(client, project)
    body = client.get("/api/v1/reviews", params={"project_id": project["project_id"]}).json()
    assert body["total"] == 1
    assert body["items"][0]["review_kind"] == "release"
    assert body["items"][0]["stage_label"] == "评审前"
    assert body["items"][0]["version_code"] == "V7.32"
    assert body["items"][0]["project_name"] == "会议一体机体验项目"

    assert client.get("/api/v1/reviews/not-exist").status_code == 404


def test_reviews_requires_login(client: TestClient) -> None:
    assert client.get("/api/v1/reviews").status_code == 401


def test_signature_rows_persisted(
    client: TestClient, setup_primary: dict, project: dict[str, str], session_factory: sessionmaker[Session]
) -> None:
    review = _create_review(client, project)
    with session_factory() as db:
        rows = (
            db.execute(select(ReviewSignature).where(ReviewSignature.review_id == review["id"])).scalars().all()
        )
        assert len(rows) == 6
        assert {r.department for r in rows} == set(REVIEW_SIGN_DEPARTMENTS)
