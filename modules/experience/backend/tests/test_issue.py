"""T07 验收：统一问题实体、状态机、批量能力、矩阵命中预览。

测试夹具直接用 ORM 构造 Division / System / Project（v1.1：项目直挂系统），
不依赖其他任务模块（TASKS.md T07 prerequisite 之外的实现）。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.core.security import new_id
from app.models.flow import Division, Project
from app.models.issue import Issue, IssueTransition
from app.models.provider import ProviderJob
from app.models.scoring import ScoringScheme
from app.models.systems import System
from tests.conftest import PRIMARY


# --------------------------------------------------------------------------- 夹具


def _default_scheme_id(db: Session) -> str:
    scheme = (
        db.execute(
            select(ScoringScheme).where(
                ScoringScheme.is_default.is_(True), ScoringScheme.is_active.is_(True)
            )
        )
        .scalars()
        .first()
    )
    assert scheme is not None
    return scheme.id


@pytest.fixture()
def project(session_factory: sessionmaker[Session]) -> dict[str, str]:
    """构造一个含系统 / 事业部（v1.1）的项目。"""
    ids = {
        "division_id": new_id(),
        "system_id": new_id(),
        "project_id": new_id(),
    }
    with session_factory() as db:
        db.add(
            Division(
                id=ids["division_id"],
                code="DIV-ISSUE-001",
                name="产品事业部",
                owner_text="事业部负责人",
            )
        )
        db.add(
            System(
                id=ids["system_id"],
                code="SYS-ISSUE-001",
                name="会议协作系统",
                division_id=ids["division_id"],
                scheme_id=_default_scheme_id(db),
            )
        )
        db.add(
            Project(
                id=ids["project_id"],
                code="PRJ-ISSUE-001",
                name="会议一体机体验项目",
                system_id=ids["system_id"],
                version_code="V7.32",
                division_id=ids["division_id"],
                project_type="new_product",
                owner_text="项目负责人",
            )
        )
        db.commit()
    return ids


def _create_issue(client: TestClient, project: dict[str, str], **overrides) -> dict:
    payload = {
        "project_id": project["project_id"],
        "description": "会议预约页无法选择历史会议室",
        "business_level": "core",
        "severity": "normal",
        "module": "会议预约",
    }
    payload.update(overrides)
    resp = client.post("/api/v1/issues", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _transition(client: TestClient, issue_id: str, action: str, **body) -> tuple[int, dict]:
    resp = client.post(f"/api/v1/issues/{issue_id}/transition", json={"action": action, **body})
    return resp.status_code, resp.json()


def _to_reply_stage(client: TestClient, issue: dict) -> None:
    """提交 + 确认分类，推进到「待回复」。"""
    code, _ = _transition(client, issue["id"], "submit")
    assert code == 200
    code, _ = _transition(client, issue["id"], "confirm_classification", extra={"confirm": True})
    assert code == 200


# --------------------------------------------------------------------------- 生命周期


def test_issue_full_lifecycle_with_proxy_and_guards(
    client: TestClient, setup_primary: dict, project: dict[str, str]
) -> None:
    issue = _create_issue(client, project)

    # 编号形如 ISS-{项目code}-{4 位序号}，初始 draft，pre_* 同步初值
    assert issue["code"] == "ISS-PRJ-ISSUE-001-0001"
    assert issue["status"] == "draft"
    assert issue["pre_business_level"] == "core"
    assert issue["pre_severity"] == "normal"
    # 项目（直挂系统）自动带出事业部
    assert issue["division_id"] == project["division_id"]
    assert issue["division_name"] == "产品事业部"

    # 提交 → 待确认
    code, detail = _transition(client, issue["id"], "submit")
    assert code == 200
    assert detail["status"] == "pending_confirm"

    # 确认分类需要 confirm=true
    code, body = _transition(client, issue["id"], "confirm_classification")
    assert code == 422
    code, detail = _transition(client, issue["id"], "confirm_classification", extra={"confirm": True})
    assert code == 200
    assert detail["status"] == "pending_reply"
    assert detail["pre_business_level"] == "core"

    # 代录回复：缺实际提供人 → 422
    code, body = _transition(
        client, issue["id"], "record_reply", extra={"division_reply": "已排期 V7.33 修复"}
    )
    assert code == 422, body
    assert body["message"] == "代录必须提供实际提供人"
    assert any("actual_provider" in (fe["message"] or "") or "实际提供人" in fe["message"] for fe in body["field_errors"])

    code, detail = _transition(
        client, issue["id"], "record_reply", extra={"division_reply": "已排期 V7.33 修复", "actual_provider": "张伟"}
    )
    assert code == 200
    assert detail["status"] == "in_progress"
    assert detail["proxy_fields"]["division_reply"] is True
    assert detail["first_replied_at"] is not None

    # 登记解决方案（承诺版本为代录）
    code, detail = _transition(
        client,
        issue["id"],
        "record_solution",
        extra={"solution": "补充历史会议室搜索", "committed_version": "V7.33", "actual_provider": "张伟"},
    )
    assert code == 200
    assert detail["status"] == "pending_acceptance"
    assert detail["proxy_fields"]["solution"] is True
    assert detail["proxy_fields"]["committed_version"] is True

    # 验收缺证据 → 422
    code, _ = _transition(client, issue["id"], "accept")
    assert code == 422
    code, detail = _transition(client, issue["id"], "accept", extra={"evidence": "复测通过，附件截图 A1"})
    assert code == 200
    assert detail["status"] == "accepted"
    assert detail["acceptances"][0]["result"] == "accepted"

    # 缺最终分类时关闭 → 409
    code, body = _transition(client, issue["id"], "close")
    assert code == 409, body
    assert body["code"] == "precondition_failed"
    assert "final_classification" in body["failed_guards"]

    # PATCH 人工确认最终分类
    resp = client.patch(
        f"/api/v1/issues/{issue['id']}",
        json={"final_business_level": "non_core", "final_severity": "minor", "confirm_final": True},
    )
    assert resp.status_code == 200, resp.text
    detail = resp.json()
    assert detail["final_classified_at"] is not None
    assert detail["classification_diff"]["changed"] is True

    # 关闭成功
    code, detail = _transition(client, issue["id"], "close")
    assert code == 200
    assert detail["status"] == "closed"
    assert detail["closed_at"] is not None


def test_illegal_transition_returns_409_with_context(
    client: TestClient, setup_primary: dict, project: dict[str, str]
) -> None:
    issue = _create_issue(client, project)

    # draft 直接 accept：状态机中不存在
    code, body = _transition(client, issue["id"], "accept")
    assert code == 409
    assert body["code"] == "illegal_transition"
    assert body["machine"] == "issue"
    assert body["current"] == "draft"
    assert body["allowed_targets"] == ["pending_confirm"]
    assert body["reason"]

    # 需理由的退回缺 reason → 422
    code, body = _transition(client, issue["id"], "submit")
    assert code == 200
    code, body = _transition(client, issue["id"], "return")
    assert code == 422


def test_optimistic_lock_conflict(
    client: TestClient, setup_primary: dict, project: dict[str, str]
) -> None:
    issue = _create_issue(client, project)
    resp = client.patch(
        f"/api/v1/issues/{issue['id']}",
        json={"description": "修改描述", "expected_version": 999},
    )
    assert resp.status_code == 409
    assert resp.json()["code"] == "version_conflict"

    resp = client.patch(
        f"/api/v1/issues/{issue['id']}",
        json={"description": "修改描述", "expected_version": issue["row_version"]},
    )
    assert resp.status_code == 200, resp.text


# --------------------------------------------------------------------------- 引用与删除


def test_reference_count_and_delete_forbidden(
    client: TestClient, setup_primary: dict, project: dict[str, str]
) -> None:
    issue = _create_issue(client, project)

    first = client.post(
        f"/api/v1/issues/{issue['id']}/refs",
        json={"ref_type": "prototype", "ref_id": "art-1", "label": "原型体验报告 V1"},
    )
    assert first.status_code == 200, first.text
    assert first.json()["reference_count"] == 1

    second = client.post(
        f"/api/v1/issues/{issue['id']}/refs",
        json={"ref_type": "review", "ref_id": "rev-1", "label": "N13 评审"},
    )
    assert second.status_code == 200
    assert second.json()["reference_count"] == 2

    # 同一来源重复引用不重复计数
    again = client.post(
        f"/api/v1/issues/{issue['id']}/refs",
        json={"ref_type": "review", "ref_id": "rev-1", "label": "N13 评审"},
    )
    assert again.json()["reference_count"] == 2

    detail = client.get(f"/api/v1/issues/{issue['id']}").json()
    assert detail["reference_count"] == 2
    assert len(detail["source_refs"]) == 2
    assert set(detail["source_labels"]) == {"原型报告", "评审"}

    # 非法 ref_type → 422
    bad = client.post(
        f"/api/v1/issues/{issue['id']}/refs",
        json={"ref_type": "unknown", "ref_id": "x", "label": "x"},
    )
    assert bad.status_code == 422

    # DELETE 一律禁止
    deleted = client.delete(f"/api/v1/issues/{issue['id']}")
    assert deleted.status_code in (405, 409)
    assert deleted.status_code == 409
    assert "物理删除" in deleted.json()["message"]


# --------------------------------------------------------------------------- 矩阵命中预览


def test_matrix_preview_uses_system_bound_default_scheme(
    client: TestClient, setup_primary: dict, project: dict[str, str]
) -> None:
    core = _create_issue(client, project, business_level="core", severity="normal")
    preview = core["matrix_preview"]
    assert preview["cell_key"] == "core_normal"
    assert preview["deduction"] == "2.4"
    assert preview["deduction_display"] == "2.4"
    assert preview["scheme_business_ratio"] == "8:2"
    assert preview["scheme_problem_ratio"] == "7:5:3:1"
    # v1.1：项目所属系统绑定方案；夹具系统绑定的是默认方案
    assert preview["is_default"] is True
    assert preview["scheme_source"] == "system"
    assert preview["has_conflict"] is False

    non_core = _create_issue(client, project, business_level="non_core", severity="normal")
    preview = non_core["matrix_preview"]
    assert preview["cell_key"] == "non_core_normal"
    assert preview["deduction"] == "0.6"


def _scheme_id(db: Session, code: str) -> str:
    scheme = db.execute(select(ScoringScheme).where(ScoringScheme.code == code)).scalars().first()
    assert scheme is not None, code
    return scheme.id


def test_matrix_preview_prefers_system_scheme(
    client: TestClient,
    setup_primary: dict,
    project: dict[str, str],
    session_factory: sessionmaker[Session],
) -> None:
    # 系统绑定方案 9:1 / 6:3:2:1（核心-一般 = 1.8），优先于默认方案 2.4
    with session_factory() as db:
        system_id = new_id()
        project_id = new_id()
        db.add(
            System(
                id=system_id,
                code="SYS-ISSUE-002",
                name="会议协作系统（9:1 方案）",
                division_id=project["division_id"],
                scheme_id=_scheme_id(db, "9-1__6-3-2-1"),
                scheme_version=1,
            )
        )
        db.add(
            Project(
                id=project_id,
                code="PRJ-ISSUE-002",
                name="会议一体机体验项目（9:1 方案）",
                system_id=system_id,
                version_code="V7.32",
                division_id=project["division_id"],
                project_type="new_product",
            )
        )
        db.commit()

    issue = _create_issue(client, {"project_id": project_id}, business_level="core", severity="normal")
    preview = issue["matrix_preview"]
    assert preview["scheme_source"] == "system"
    assert preview["scheme_business_ratio"] == "9:1"
    assert preview["cell_key"] == "core_normal"
    assert preview["deduction"] == "1.8"
    assert preview["is_default"] is False
    assert preview["has_conflict"] is False


# --------------------------------------------------------------------------- 批量


def test_batch_set_level_scope_and_audit_trail(
    client: TestClient, setup_primary: dict, project: dict[str, str]
) -> None:
    a = _create_issue(client, project, description="问题 A")
    b = _create_issue(client, project, description="问题 B")
    c = _create_issue(client, project, description="问题 C")

    # 预演范围
    preview = client.post(
        "/api/v1/issues/batch",
        json={
            "all_filtered": {"project_id": project["project_id"]},
            "except_ids": [c["id"]],
            "action": "set_level",
            "payload": {"business_level": "non_core"},
            "dry_run": True,
        },
    )
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["affected"] == 0
    assert body["scope"] == {"current_page_n": 2, "total_n": 3, "excluded_n": 1}

    resp = client.post(
        "/api/v1/issues/batch",
        json={
            "issue_ids": [a["id"], b["id"]],
            "except_ids": [b["id"]],
            "action": "set_level",
            "payload": {"business_level": "non_core", "severity": "minor"},
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["affected"] == 1
    assert body["issue_ids"] == [a["id"]]
    assert body["scope"] == {"current_page_n": 1, "total_n": 2, "excluded_n": 1}

    # 每个问题写独立 IssueTransition 审计
    detail = client.get(f"/api/v1/issues/{a['id']}").json()
    assert detail["business_level"] == "non_core"
    assert detail["severity"] == "minor"
    assert any(t["action"] == "batch_set_level" for t in detail["timeline"])

    other = client.get(f"/api/v1/issues/{b['id']}").json()
    assert other["business_level"] == "core"  # 被排除，未受影响


def test_batch_sync_is_idempotent(
    client: TestClient, setup_primary: dict, project: dict[str, str], session_factory: sessionmaker[Session]
) -> None:
    issue = _create_issue(client, project)
    payload = {"issue_ids": [issue["id"]], "action": "sync", "payload": {}}
    first = client.post("/api/v1/issues/batch", json=payload).json()
    second = client.post("/api/v1/issues/batch", json=payload).json()
    assert first["affected"] == 1
    assert first["job_ids"] == second["job_ids"]
    assert first["idempotency_keys"] == [f"issue_sync:{issue['id']}"]

    with session_factory() as db:
        jobs = db.execute(select(ProviderJob)).scalars().all()
        assert len(jobs) == 1
        assert jobs[0].idempotency_key == f"issue_sync:{issue['id']}"
        assert jobs[0].mode == "mock"
        assert jobs[0].status == "queued"


def test_batch_accept_requires_evidence(
    client: TestClient, setup_primary: dict, project: dict[str, str]
) -> None:
    issue = _create_issue(client, project)
    _to_reply_stage(client, issue)
    _transition(
        client, issue["id"], "record_reply",
        extra={"division_reply": "已修复", "actual_provider": "张伟"},
    )
    _transition(
        client, issue["id"], "record_solution",
        extra={"solution": "方案", "committed_version": "V7.33", "actual_provider": "张伟"},
    )

    missing = client.post(
        "/api/v1/issues/batch",
        json={"issue_ids": [issue["id"]], "action": "accept", "payload": {}},
    )
    assert missing.status_code == 422

    ok = client.post(
        "/api/v1/issues/batch",
        json={"issue_ids": [issue["id"]], "action": "accept", "payload": {"evidence": "批量抽检通过"}},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["affected"] == 1
    assert client.get(f"/api/v1/issues/{issue['id']}").json()["status"] == "accepted"


# --------------------------------------------------------------------------- 列表 / 权限


def test_list_filters_and_default_order(
    client: TestClient, setup_primary: dict, project: dict[str, str]
) -> None:
    normal = _create_issue(client, project, description="一般问题", severity="normal")
    major = _create_issue(client, project, description="严重问题", severity="major")

    body = client.get("/api/v1/issues", params={"project_id": project["project_id"]}).json()
    assert body["total"] == 2
    assert body["page_size"] == 50
    assert {item["id"] for item in body["items"]} == {normal["id"], major["id"]}

    only_major = client.get("/api/v1/issues", params={"severity": "major"}).json()
    assert only_major["total"] == 1
    assert only_major["items"][0]["severity"] == "major"

    keyword = client.get("/api/v1/issues", params={"keyword": "严重"}).json()
    assert keyword["total"] == 1
    assert keyword["items"][0]["id"] == major["id"]


def test_issue_endpoints_require_login(client: TestClient) -> None:
    assert client.get("/api/v1/issues").status_code == 401


def test_issue_not_found_returns_404(
    client: TestClient, setup_primary: dict, project: dict[str, str]
) -> None:
    assert client.get("/api/v1/issues/not-exist").status_code == 404
    code, body = _transition(client, "not-exist", "submit")
    assert code == 404


# --------------------------------------------------------------------------- 直接落库校验


def test_issue_and_transition_persisted(
    client: TestClient, setup_primary: dict, project: dict[str, str], session_factory: sessionmaker[Session]
) -> None:
    issue = _create_issue(client, project)
    _transition(client, issue["id"], "submit")

    with session_factory() as db:
        row = db.get(Issue, issue["id"])
        assert row is not None
        assert row.code == issue["code"]
        assert row.status == "pending_confirm"
        transitions = (
            db.execute(select(IssueTransition).where(IssueTransition.issue_id == issue["id"])).scalars().all()
        )
        assert {t.action for t in transitions} >= {"create", "submit"}
        assert all(t.actor_name == PRIMARY["name"] for t in transitions)
