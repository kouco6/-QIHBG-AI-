"""T05 验收：结构化产物、模板、版本与差异。

覆盖 ACCEPTANCE / TASKS T05 的验收点：

1. 模板接口返回 21 个模板，且每个模板首次必填 ≤ 8；
2. 创建产物 → 自动保存草稿 → payload 落库 → 未冻结时仍为同一版本号；
3. 提交缺必填字段 422 且 ``field_errors`` 指明字段 key，补齐后可提交；
4. 提交后（``is_frozen``）再次自动保存会派生新版本，旧版本 payload 不变；
5. 已确认产物不可原位覆盖：确认后自动保存产生新版本，``diff`` 可显示差异；
6. 退回需原因、退回恢复需恢复原因、已确认重开需变更原因（否则 422）；
7. 标记不适用需原因，模板 ``allow_not_applicable=false`` 时 409；
8. 表格字段的行级差异（新增 / 修改）体现在 ``row_changes``；
9. 未登录 401、实体不存在 404、非法迁移 409（含 current / target / allowed_targets）；
10. 自动保存记录 ``last_saved_at`` 非空。

测试夹具不依赖同事的 T04 ``flow`` 服务：直接用 ORM 构造
Division / System / Project / WorkflowNode（v1.1：项目直挂系统）。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.core.security import new_id
from app.domain.nodes import NODE_SPECS
from app.models.flow import Division, Project, WorkflowNode
from app.models.issue import Issue
from app.models.scoring import ScoringScheme
from app.models.systems import System
from tests.conftest import PRIMARY, login

BASE = "/api/v1/artifacts"


# ============================================================================= 夹具


@pytest.fixture()
def flow(session_factory: sessionmaker[Session]) -> dict[str, object]:
    """ORM 直接构造一条「事业部 → 系统 → 项目 → 13 节点」链路（v1.1）。"""
    with session_factory() as db:
        division = Division(id=new_id(), code=f"DIV-{new_id()[:8]}", name="测试事业部")
        db.add(division)
        db.flush()

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

        system = System(
            id=new_id(),
            code=f"SYS-{new_id()[:8]}",
            name="测试系统",
            division_id=division.id,
            scheme_id=scheme.id,
        )
        db.add(system)
        db.flush()

        project = Project(
            id=new_id(),
            code=f"PRJ-{new_id()[:8]}",
            name="测试项目",
            system_id=system.id,
            version_code="V1.0",
            division_id=division.id,
            project_type="new_product",
            owner_text="龙斌",
        )
        db.add(project)
        db.flush()

        node_ids: dict[str, str] = {}
        for spec in NODE_SPECS:
            node = WorkflowNode(
                id=new_id(),
                project_id=project.id,
                code=spec.code,
                node_order=spec.order,
                stage_code=spec.stage_code,
                name=spec.name,
                scope=spec.scope,
                duration_days=spec.duration_days,
                outputs_text=spec.outputs,
                allow_not_applicable=spec.allow_not_applicable,
                iteration_only=spec.iteration_only,
            )
            db.add(node)
            db.flush()
            node_ids[spec.code] = node.id

        db.commit()
        return {"project_id": project.id, "node_ids": node_ids, "system_id": system.id}


# ============================================================================= 工具


def _scene_payload(**over: object) -> dict:
    """场景调研报告（N01）的必填字段全量 payload。"""
    data = {
        "keywords_scene": "会议室",
        "keywords_role": "讲解员",
        "table_a": [{"地点": "会议室A", "场景": "日常会议"}],
        "table_b": [{"功能场景": "预约", "解释": "在线预约"}],
        "table_c": [{"角色": "讲解员", "关注点": "易用"}],
        "conclusion": "覆盖会议室预约场景与讲解员角色。",
    }
    data.update(over)
    return data


def _create(client: TestClient, flow: dict, **over: object):
    body = {
        "project_id": flow["project_id"],
        "node_code": "N01",
        "kind": "scene_research",
        "title": "场景调研报告",
    }
    body.update(over)
    return client.post(BASE, json=body)


def _new_artifact(client: TestClient, flow: dict, **over: object) -> str:
    resp = _create(client, flow, **over)
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


# ============================================================================= 1. 模板


def test_templates_list_has_21_and_required_max_8(
    client: TestClient, setup_primary: dict
) -> None:
    resp = client.get(f"{BASE}/templates")
    assert resp.status_code == 200, resp.text
    items = resp.json()
    assert len(items) == 21
    for item in items:
        assert item["fields"], item["kind"]
        assert item["required_count"] <= 8, f"{item['kind']} 首次必填超过 8 项"

    # 按节点过滤
    n01 = client.get(f"{BASE}/templates", params={"node_code": "N01"}).json()
    assert {t["kind"] for t in n01} == {
        "scene_research",
        "industry_analysis",
        "competitor_report",
        "persona_draft",
    }

    # 单模板详情 + 不存在 404
    one = client.get(f"{BASE}/templates/scene_research")
    assert one.status_code == 200
    assert one.json()["kind"] == "scene_research"
    assert one.json()["allow_not_applicable"] is True
    assert client.get(f"{BASE}/templates/not_a_kind").status_code == 404


# ============================================================================= 2. 创建 + 自动保存


def test_create_then_autosave_keeps_same_version(
    client: TestClient, setup_primary: dict, flow: dict
) -> None:
    detail = _create(client, flow)
    assert detail.status_code == 201, detail.text
    body = detail.json()
    artifact_id = body["id"]
    assert body["status"] == "draft"
    assert body["current_version_no"] == 1
    assert {a["action"] for a in body["allowed_actions"]} == {"submit", "mark_na"}

    save = client.put(f"{BASE}/{artifact_id}/draft", json={"payload": _scene_payload()})
    assert save.status_code == 200, save.text
    assert save.json()["version_no"] == 1

    after = client.get(f"{BASE}/{artifact_id}").json()
    assert after["current_version"]["payload"]["keywords_scene"] == "会议室"
    # 10 验收点：自动保存记录 last_saved_at
    assert after["last_saved_at"]

    again = client.post(
        f"{BASE}/{artifact_id}/draft",
        json={"payload": {"conclusion": "更新后的结论"}, "autosave": True},
    )
    assert again.json()["version_no"] == 1
    merged = client.get(f"{BASE}/{artifact_id}").json()["current_version"]["payload"]
    assert merged["conclusion"] == "更新后的结论"
    assert merged["keywords_scene"] == "会议室"

    versions = client.get(f"{BASE}/{artifact_id}/versions").json()
    assert [v["version_no"] for v in versions] == [1]


# ============================================================================= 3. 提交校验


def test_submit_requires_required_fields(
    client: TestClient, setup_primary: dict, flow: dict
) -> None:
    artifact_id = _new_artifact(client, flow)
    client.put(f"{BASE}/{artifact_id}/draft", json={"payload": {"keywords_scene": "会议室"}})

    bad = client.post(f"{BASE}/{artifact_id}/submit", json={})
    assert bad.status_code == 422, bad.text
    keys = {e["field"] for e in bad.json()["field_errors"]}
    assert {"keywords_role", "table_a", "table_b", "table_c", "conclusion"} <= keys

    ok = client.post(f"{BASE}/{artifact_id}/submit", json={"payload": _scene_payload()})
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["status"] == "submitted"
    assert body["current_version"]["is_frozen"] is True
    assert body["submitted_at"]


# ============================================================================= 4. 冻结版本不可原位覆盖


def test_submit_then_autosave_creates_new_version(
    client: TestClient, setup_primary: dict, flow: dict
) -> None:
    artifact_id = _new_artifact(client, flow)
    client.put(f"{BASE}/{artifact_id}/draft", json={"payload": _scene_payload()})
    assert client.post(f"{BASE}/{artifact_id}/submit", json={}).status_code == 200

    v1 = client.get(f"{BASE}/{artifact_id}/versions/1").json()
    assert v1["is_frozen"] is True

    save = client.put(
        f"{BASE}/{artifact_id}/draft", json={"payload": {"conclusion": "提交后修订"}}
    )
    assert save.status_code == 200, save.text
    assert save.json()["version_no"] == 2

    v1_after = client.get(f"{BASE}/{artifact_id}/versions/1").json()
    assert v1_after["payload"]["conclusion"] == "覆盖会议室预约场景与讲解员角色。"
    assert v1_after["is_frozen"] is True

    v2 = client.get(f"{BASE}/{artifact_id}/versions/2").json()
    assert v2["payload"]["conclusion"] == "提交后修订"
    assert v2["source_version_no"] == 1
    assert v2["is_frozen"] is False


# ============================================================================= 5. 已确认不可原位覆盖 + diff


def test_confirmed_artifact_not_overwritten_and_diff(
    client: TestClient, setup_primary: dict, flow: dict
) -> None:
    artifact_id = _new_artifact(client, flow)
    client.put(f"{BASE}/{artifact_id}/draft", json={"payload": _scene_payload()})
    client.post(f"{BASE}/{artifact_id}/submit", json={})
    confirmed = client.post(f"{BASE}/{artifact_id}/confirm", json={})
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["status"] == "confirmed"
    assert confirmed.json()["confirmed_at"]

    save = client.put(
        f"{BASE}/{artifact_id}/draft", json={"payload": {"conclusion": "确认后再次编辑"}}
    )
    assert save.status_code == 200
    assert save.json()["version_no"] == 2

    diff = client.get(f"{BASE}/{artifact_id}/diff", params={"from": 1, "to": 2})
    assert diff.status_code == 200, diff.text
    fields = {item["field"]: item for item in diff.json()}
    assert fields["conclusion"]["change"] == "modified"
    assert fields["conclusion"]["from_value"] == "覆盖会议室预约场景与讲解员角色。"
    assert fields["conclusion"]["to_value"] == "确认后再次编辑"
    assert fields["keywords_scene"]["change"] == "unchanged"
    assert set(fields["conclusion"]) >= {
        "field",
        "label",
        "type",
        "from_value",
        "to_value",
        "change",
    }


# ============================================================================= 6. 退回 / 恢复 / 重开


def test_return_and_resume_reason_rules(
    client: TestClient, setup_primary: dict, flow: dict
) -> None:
    artifact_id = _new_artifact(client, flow)
    client.put(f"{BASE}/{artifact_id}/draft", json={"payload": _scene_payload()})
    client.post(f"{BASE}/{artifact_id}/submit", json={})

    # 退回原因必填
    assert client.post(f"{BASE}/{artifact_id}/return", json={}).status_code == 422
    returned = client.post(f"{BASE}/{artifact_id}/return", json={"reason": "字段口径需复核"})
    assert returned.status_code == 200, returned.text
    assert returned.json()["status"] == "returned"

    # 退回恢复需填写恢复原因
    no_reason = client.post(f"{BASE}/{artifact_id}/resume", json={})
    assert no_reason.status_code == 422
    assert no_reason.json()["field_errors"][0]["field"] == "reason"
    resumed = client.post(f"{BASE}/{artifact_id}/resume", json={"reason": "已补充材料"})
    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["status"] == "draft"
    assert resumed.json()["current_version"]["is_frozen"] is False

    # 再次提交并确认
    assert client.post(f"{BASE}/{artifact_id}/submit", json={}).status_code == 200
    assert client.post(f"{BASE}/{artifact_id}/confirm", json={}).status_code == 200

    # 已确认重开必须填写变更原因
    missing_note = client.post(f"{BASE}/{artifact_id}/resume", json={"reason": "无变更原因"})
    assert missing_note.status_code == 422
    assert missing_note.json()["field_errors"][0]["field"] == "change_note"
    reopened = client.post(
        f"{BASE}/{artifact_id}/resume", json={"change_note": "确认后需要修订结论"}
    )
    assert reopened.status_code == 200, reopened.text
    body = reopened.json()
    assert body["status"] == "draft"
    assert body["current_version_no"] == 2
    assert body["current_version"]["source_version_no"] == 1
    assert client.get(f"{BASE}/{artifact_id}/versions/1").json()["is_frozen"] is True


# ============================================================================= 7. 不适用


def test_mark_not_applicable_rules(client: TestClient, setup_primary: dict, flow: dict) -> None:
    # 模板 allow_not_applicable=false → 409
    journey_id = _new_artifact(
        client, flow, kind="user_journey", node_code="N02", title="用户体验地图"
    )
    assert client.post(f"{BASE}/{journey_id}/mark-na", json={}).status_code == 422
    denied = client.post(f"{BASE}/{journey_id}/mark-na", json={"reason": "本次不适用"})
    assert denied.status_code == 409, denied.text
    assert denied.json()["code"] == "template_na_forbidden"

    # 模板允许 + 理由非空 → 成功
    scene_id = _new_artifact(client, flow)
    assert client.post(f"{BASE}/{scene_id}/mark-na", json={}).status_code == 422
    ok = client.post(f"{BASE}/{scene_id}/mark-na", json={"reason": "新产品不做该环节"})
    assert ok.status_code == 200, ok.text
    assert ok.json()["status"] == "not_applicable"
    assert ok.json()["not_applicable_reason"] == "新产品不做该环节"


# ============================================================================= 8. 行级差异


def test_table_row_level_diff(client: TestClient, setup_primary: dict, flow: dict) -> None:
    artifact_id = _new_artifact(client, flow)
    client.put(
        f"{BASE}/{artifact_id}/draft",
        json={"payload": _scene_payload(table_a=[{"地点": "会议室A", "场景": "日常会议"}])},
    )
    client.post(f"{BASE}/{artifact_id}/submit", json={})
    client.put(
        f"{BASE}/{artifact_id}/draft",
        json={
            "payload": _scene_payload(
                table_a=[
                    {"地点": "会议室A", "场景": "临时会议"},  # 修改
                    {"地点": "展厅B", "场景": "接待演示"},  # 新增
                ]
            )
        },
    )

    diff = client.get(f"{BASE}/{artifact_id}/diff", params={"from": 1, "to": 2}).json()
    table_a = next(item for item in diff if item["field"] == "table_a")
    assert table_a["change"] == "modified"
    changes = {row["row_key"]: row["change"] for row in table_a["row_changes"]}
    assert changes["会议室A"] == "modified"
    assert changes["展厅B"] == "added"
    modified = next(r for r in table_a["row_changes"] if r["row_key"] == "会议室A")
    assert modified["from_row"]["场景"] == "日常会议"
    assert modified["to_row"]["场景"] == "临时会议"


# ============================================================================= 9. 鉴权 / 404 / 非法迁移


def test_auth_404_and_illegal_transition(
    client: TestClient, setup_primary: dict, flow: dict
) -> None:
    artifact_id = _new_artifact(client, flow)

    # 未登录 401
    client.cookies.clear()
    assert client.get(BASE).status_code == 401
    assert client.get(f"{BASE}/templates").status_code == 401
    assert client.get(f"{BASE}/{artifact_id}").status_code == 401
    assert client.post(f"{BASE}/{artifact_id}/submit", json={}).status_code == 401
    assert client.put(f"{BASE}/{artifact_id}/draft", json={"payload": {}}).status_code == 401
    login(client, PRIMARY["account"], PRIMARY["password"])

    # 不存在 404
    assert client.get(f"{BASE}/not-a-real-id").status_code == 404
    assert client.get(f"{BASE}/{artifact_id}/versions/99").status_code == 404
    assert client.get(
        f"{BASE}/{artifact_id}/diff", params={"from": 1, "to": 99}
    ).status_code == 404

    # 非法迁移：draft → confirmed 返回 409 且携带 current/target/reason/allowed_targets
    resp = client.post(f"{BASE}/{artifact_id}/confirm", json={})
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["code"] == "illegal_transition"
    assert body["current"] == "draft"
    assert body["target"] == "confirmed"
    assert body["reason"]
    assert "submitted" in body["allowed_targets"]

    # 已提交状态下再提交为非法迁移
    client.put(f"{BASE}/{artifact_id}/draft", json={"payload": _scene_payload()})
    client.post(f"{BASE}/{artifact_id}/submit", json={})
    assert client.post(f"{BASE}/{artifact_id}/submit", json={}).status_code == 409


# ============================================================================= 10. 创建校验 / 列表 / patch / 问题引用


def test_create_validates_node_and_kind(client: TestClient, setup_primary: dict, flow: dict) -> None:
    # kind 与节点不匹配 → 422
    mismatch = _create(client, flow, kind="ui_report", node_code="N01")
    assert mismatch.status_code == 422
    assert mismatch.json()["field_errors"][0]["field"] == "kind"

    # 未知 node_id → 404
    assert (
        client.post(
            BASE,
            json={
                "project_id": flow["project_id"],
                "node_id": "no-such-node",
                "kind": "scene_research",
                "title": "x",
            },
        ).status_code
        == 404
    )

    # 同一 node + kind 重复创建 → 409
    _new_artifact(client, flow)
    dup = _create(client, flow)
    assert dup.status_code == 409, dup.text
    assert dup.json()["code"] == "artifact_exists"


def test_list_filters_and_patch(client: TestClient, setup_primary: dict, flow: dict) -> None:
    artifact_id = _new_artifact(client, flow)
    _new_artifact(client, flow, kind="experience_plan", node_code="N02", title="体验方案")

    listed = client.get(BASE, params={"project_id": flow["project_id"]})
    assert listed.status_code == 200
    assert listed.json()["total"] == 2
    assert client.get(BASE, params={"kind": "scene_research"}).json()["total"] == 1
    assert client.get(BASE, params={"status": "draft"}).json()["total"] == 2

    patched = client.patch(
        f"{BASE}/{artifact_id}", json={"title": "新标题", "collaborators_text": "张三、李四"}
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["title"] == "新标题"
    assert patched.json()["collaborators_text"] == "张三、李四"
    # PATCH 不改动 payload
    assert patched.json()["current_version"]["payload"] == {}


def test_issue_refs_validates_existence(
    client: TestClient,
    setup_primary: dict,
    flow: dict,
    session_factory: sessionmaker[Session],
) -> None:
    artifact_id = _new_artifact(client, flow)

    bad = client.post(f"{BASE}/{artifact_id}/issue-refs", json={"issue_ids": ["missing-issue-id"]})
    assert bad.status_code == 422, bad.text
    assert bad.json()["field_errors"][0]["field"] == "issue_ids"

    with session_factory() as db:
        issue = Issue(id=new_id(), code=f"ISSUE-{new_id()[:8]}", project_id=str(flow["project_id"]))
        db.add(issue)
        db.commit()
        issue_id = issue.id

    ok = client.post(f"{BASE}/{artifact_id}/issue-refs", json={"issue_ids": [issue_id]})
    assert ok.status_code == 200, ok.text
    assert ok.json()["issue_ids"] == [issue_id]
    assert client.get(f"{BASE}/{artifact_id}").json()["current_version"]["issue_ids"] == [issue_id]


def test_write_operations_are_audited(
    client: TestClient,
    setup_primary: dict,
    flow: dict,
    session_factory: sessionmaker[Session],
) -> None:
    """所有写操作必须写业务审计（audit_business）。"""
    from sqlalchemy import select

    from app.models.account import AUDIT_CATEGORY_BUSINESS, AuditLog

    artifact_id = _new_artifact(client, flow)
    client.put(f"{BASE}/{artifact_id}/draft", json={"payload": _scene_payload()})
    client.post(f"{BASE}/{artifact_id}/submit", json={})
    client.post(f"{BASE}/{artifact_id}/confirm", json={})

    with session_factory() as db:
        rows = db.execute(
            select(AuditLog.action, AuditLog.category).where(AuditLog.target_id == artifact_id)
        ).all()
    actions = {action for action, _ in rows}
    assert {"artifact_created", "artifact_draft_saved", "artifact_submitted", "artifact_confirmed"} <= actions
    assert all(category == AUDIT_CATEGORY_BUSINESS for _, category in rows)


def test_confirm_requires_actual_provider_in_signatures(
    client: TestClient, setup_primary: dict, flow: dict
) -> None:
    """签名表每行必须记录「实际提供人」，否则确认 422 并提示走代录。"""
    artifact_id = _new_artifact(
        client, flow, kind="internal_scenario_review", node_code="N04", title="内部业务场景评审表"
    )
    payload = {
        "review_purpose": "固定文案",
        "header": [{"产品名称": "测试产品", "版本": "V1.0"}],
        "body": [{"角色": "讲解员", "场景": "会议室"}],
        "signatures": [{"部门": "研发部门", "负责人": "甲", "实际提供人": ""}],
    }
    client.put(f"{BASE}/{artifact_id}/draft", json={"payload": payload})
    assert client.post(f"{BASE}/{artifact_id}/submit", json={}).status_code == 200

    denied = client.post(f"{BASE}/{artifact_id}/confirm", json={})
    assert denied.status_code == 422, denied.text
    assert denied.json()["field_errors"][0]["field"] == "signatures"

    # 退回 → 恢复草稿 → 补齐实际提供人 → 提交 → 确认成功
    assert client.post(f"{BASE}/{artifact_id}/return", json={"reason": "补齐实际提供人"}).status_code == 200
    assert client.post(f"{BASE}/{artifact_id}/resume", json={"reason": "补齐实际提供人"}).status_code == 200
    client.put(
        f"{BASE}/{artifact_id}/draft",
        json={"payload": {"signatures": [{"部门": "研发部门", "负责人": "甲", "实际提供人": "甲"}]}},
    )
    assert client.post(f"{BASE}/{artifact_id}/submit", json={}).status_code == 200
    assert client.post(f"{BASE}/{artifact_id}/confirm", json={}).status_code == 200
