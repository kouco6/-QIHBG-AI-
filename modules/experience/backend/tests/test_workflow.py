"""T04 验收：基础领域模型与 13 节点状态机。

覆盖 T04 acceptance checks：

- 13 节点名称、顺序、范围、工期、输出与 :data:`app.domain.nodes.NODE_SPECS` **逐项相等**；
- 新产品项目创建即实例化 13 节点，N10 自动不适用；
- 新产品主线可推进；N06 在评审通过前不可开始；上游未完成不可开始后继节点；
- 非法迁移返回 409 且含 ``current`` / ``target``；缺理由的迁移返回 422；
- 迭代产品在 N03 提交核心业务判定（缺理由 422）并由 N04 确认；N10 允许执行；
- 「进行中 → 已完成」须有已确认产物（缺失时 409 并列出缺失类型）；
- 项目 PATCH 乐观锁冲突返回 409；未登录访问 401。
"""

from __future__ import annotations

import datetime as _dt

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.core.security import new_id
from app.domain.nodes import NODE_BY_CODE, NODE_SPECS, STAGES
from app.domain.states import ARTIFACT_CONFIRMED, NODE_NOT_APPLICABLE, NODE_NOT_STARTED
from app.models.artifact import Artifact
from app.models.scoring import ScoringScheme


# --------------------------------------------------------------------------- 辅助


def _seed_catalog(client: TestClient, session_factory: sessionmaker[Session]) -> tuple[dict, dict]:
    """建立事业部 / 系统（v1.1：产品与产品版本层已合并为系统）。"""
    division = client.post(
        "/api/v1/divisions", json={"code": "DIV-01", "name": "商用显示事业部"}
    ).json()
    with session_factory() as db:
        scheme = (
            db.query(ScoringScheme)
            .filter(ScoringScheme.is_default.is_(True), ScoringScheme.is_active.is_(True))
            .first()
        )
        assert scheme is not None
        scheme_id = scheme.id
    system = client.post(
        "/api/v1/systems",
        json={
            "code": "SYS-1001",
            "name": "会议协作系统",
            "scheme_id": scheme_id,
            "division_id": division["id"],
        },
    )
    assert system.status_code == 201, system.text
    return division, system.json()


def _create_project(
    client: TestClient,
    system: dict,
    *,
    project_type: str = "new_product",
    name: str = "会议一体机体验项目",
) -> dict:
    resp = client.post(
        "/api/v1/projects",
        json={
            "name": name,
            "system_id": system["id"],
            "project_type": project_type,
            "version_code": "V7.32",
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _nodes(client: TestClient, project_id: str) -> dict[str, dict]:
    body = client.get("/api/v1/workflow-nodes", params={"project_id": project_id}).json()
    return {node["code"]: node for node in body["items"]}


def _transition(
    client: TestClient,
    node: dict,
    *,
    action: str | None = None,
    target: str | None = None,
    reason: str | None = None,
    expected_version: int | None = None,
):
    body: dict[str, object] = {}
    if action is not None:
        body["action"] = action
    if target is not None:
        body["target"] = target
    if reason is not None:
        body["reason"] = reason
    if expected_version is not None:
        body["expected_version"] = expected_version
    return client.post(f"/api/v1/workflow-nodes/{node['id']}/transition", json=body)


def _insert_artifact(
    session_factory: sessionmaker[Session],
    *,
    project_id: str,
    node: dict,
    kind: str,
    status: str = ARTIFACT_CONFIRMED,
    reason: str = "",
) -> str:
    """直接经 ORM 插入产物行（Artifact 由 T05 实现，这里只依赖其字段契约）。"""
    artifact_id = new_id()
    with session_factory() as db:
        db.add(
            Artifact(
                id=artifact_id,
                project_id=project_id,
                node_id=node["id"],
                node_code=node["code"],
                kind=kind,
                title=f"{node['code']}-{kind}",
                status=status,
                not_applicable_reason=reason,
            )
        )
        db.commit()
    return artifact_id


def _complete_node(
    client: TestClient,
    session_factory: sessionmaker[Session],
    project_id: str,
    node: dict,
) -> None:
    """开始节点 → 写入确认产物 → 完成节点。"""
    started = _transition(client, node, action="start")
    assert started.status_code == 200, started.text
    for kind in NODE_BY_CODE[node["code"]].artifact_kinds:
        _insert_artifact(session_factory, project_id=project_id, node=node, kind=kind)
    done = _transition(client, node, action="complete")
    assert done.status_code == 200, done.text


# --------------------------------------------------------------------------- 13 节点常量一致性


def test_node_specs_match_frozen_constants(client: TestClient, setup_primary: dict) -> None:
    resp = client.get("/api/v1/workflow-nodes/meta/specs")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert len(body["nodes"]) == 13
    assert [s["code"] for s in body["stages"]] == [s.code for s in STAGES]
    for api_node, spec in zip(body["nodes"], NODE_SPECS):
        assert api_node["code"] == spec.code
        assert api_node["order"] == spec.order
        assert api_node["stage_code"] == spec.stage_code
        assert api_node["name"] == spec.name
        assert api_node["scope"] == spec.scope
        assert api_node["owner"] == spec.owner
        assert api_node["collaborators"] == spec.collaborators
        assert api_node["duration_days"] == spec.duration_days
        assert api_node["outputs"] == spec.outputs
        assert api_node["artifact_kinds"] == list(spec.artifact_kinds)
        assert api_node["upstream_deps"] == list(spec.upstream_deps)
        assert api_node["allow_not_applicable"] == spec.allow_not_applicable
        assert api_node["iteration_only"] == spec.iteration_only


# --------------------------------------------------------------------------- 创建与实例化


def test_new_product_project_instantiates_nodes_with_auto_na(
    client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session]
) -> None:
    _division, system = _seed_catalog(client, session_factory)
    project = _create_project(client, system, project_type="new_product")

    nodes = _nodes(client, project["id"])
    assert len(nodes) == 13
    assert [nodes[spec.code]["node_order"] for spec in NODE_SPECS] == list(range(1, 14))

    # 实例化节点的名称 / 范围 / 工期 / 输出与冻结常量逐项一致
    for spec in NODE_SPECS:
        node = nodes[spec.code]
        assert node["name"] == spec.name
        assert node["scope"] == spec.scope
        assert node["duration_days"] == spec.duration_days
        assert node["outputs"] == spec.outputs
        assert node["allow_not_applicable"] == spec.allow_not_applicable

    n10 = nodes["N10"]
    assert n10["status"] == NODE_NOT_APPLICABLE
    assert n10["not_applicable_reason"] == "新产品不适用体验优化迭代验收"
    assert n10["actual_end_at"] is not None

    # N01 可开始（无上游）
    n01 = nodes["N01"]
    assert n01["status"] == NODE_NOT_STARTED
    assert _transition(client, n01, action="start").status_code == 200

    # 计划时间按节点顺序串行排布
    starts = [nodes[spec.code]["planned_start_at"] for spec in NODE_SPECS]
    assert all(value is not None for value in starts)
    assert starts == sorted(starts)

    # 自动不适用节点应留有事件记录
    detail = client.get(f"/api/v1/workflow-nodes/{n10['id']}").json()
    assert any(event["to_status"] == NODE_NOT_APPLICABLE for event in detail["history"])


def test_upstream_incomplete_blocks_start(client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session]) -> None:
    _division, system = _seed_catalog(client, session_factory)
    project = _create_project(client, system)
    nodes = _nodes(client, project["id"])

    resp = _transition(client, nodes["N02"], action="start")
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["code"] == "precondition_failed"
    assert "N01" in body["reason"]


# --------------------------------------------------------------------------- 非法迁移与理由


def test_illegal_transition_returns_409_with_current_and_target(
    client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session]
) -> None:
    _division, system = _seed_catalog(client, session_factory)
    project = _create_project(client, system)
    nodes = _nodes(client, project["id"])

    resp = _transition(client, nodes["N01"], target="completed")
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["code"] == "illegal_transition"
    assert body["current"] == NODE_NOT_STARTED
    assert body["target"] == "completed"
    assert "allowed_targets" in body


def test_mark_na_and_reopen_require_reason(
    client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session]
) -> None:
    _division, system = _seed_catalog(client, session_factory)
    project = _create_project(client, system)
    nodes = _nodes(client, project["id"])

    # 未开始 → 不适用：缺理由 422
    resp = _transition(client, nodes["N01"], action="mark_na")
    assert resp.status_code == 422, resp.text

    _complete_node(client, session_factory, project["id"], nodes["N01"])
    nodes = _nodes(client, project["id"])
    assert nodes["N01"]["status"] == "completed"

    # 已完成 → 进行中（重新打开）：缺理由 422
    resp = _transition(client, nodes["N01"], action="reopen")
    assert resp.status_code == 422, resp.text


def test_reopen_records_downstream_stale_in_event(
    client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session]
) -> None:
    _division, system = _seed_catalog(client, session_factory)
    project = _create_project(client, system)
    nodes = _nodes(client, project["id"])

    _complete_node(client, session_factory, project["id"], nodes["N01"])
    _complete_node(client, session_factory, project["id"], nodes["N02"])

    resp = _transition(client, nodes["N01"], action="reopen", reason="上游数据修订")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "in_progress"
    assert {item["code"] for item in body["downstream_stale"]} >= {"N02"}

    history = body["history"]
    reopen_event = [event for event in history if event["action"] == "reopen"][-1]
    assert reopen_event["reason"].startswith("上游数据修订")
    assert "下游可能过期" in reopen_event["reason"]


# --------------------------------------------------------------------------- 完成条件


def test_complete_requires_confirmed_artifacts(
    client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session]
) -> None:
    _division, system = _seed_catalog(client, session_factory)
    project = _create_project(client, system)
    nodes = _nodes(client, project["id"])

    assert _transition(client, nodes["N01"], action="start").status_code == 200

    resp = _transition(client, nodes["N01"], action="complete")
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["code"] == "precondition_failed"
    assert body["missing_artifact_kinds"] == ["scene_research"]

    _insert_artifact(session_factory, project_id=project["id"], node=nodes["N01"], kind="scene_research")
    resp = _transition(client, nodes["N01"], action="complete")
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "completed"


# --------------------------------------------------------------------------- 新产品主线 + N06 评审门禁


def test_new_product_mainline_and_n06_review_gate(
    client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session]
) -> None:
    _division, system = _seed_catalog(client, session_factory)
    project = _create_project(client, system)

    # N01–N03 完成 → N04 进行中；此时 N06 不可开始
    for code in ("N01", "N02", "N03"):
        _complete_node(client, session_factory, project["id"], _nodes(client, project["id"])[code])
    nodes = _nodes(client, project["id"])
    assert _transition(client, nodes["N04"], action="start").status_code == 200

    blocked = _transition(client, nodes["N06"], action="start")
    assert blocked.status_code == 409, blocked.text
    assert "N04" in blocked.json()["reason"]

    # N04 完成 → N05 完成 → N06 才可开始
    nodes = _nodes(client, project["id"])
    for kind in NODE_BY_CODE["N04"].artifact_kinds:
        _insert_artifact(session_factory, project_id=project["id"], node=nodes["N04"], kind=kind)
    assert _transition(client, nodes["N04"], action="complete").status_code == 200

    _complete_node(client, session_factory, project["id"], _nodes(client, project["id"])["N05"])

    nodes = _nodes(client, project["id"])
    started = _transition(client, nodes["N06"], action="start")
    assert started.status_code == 200, started.text
    assert started.json()["status"] == "in_progress"


# --------------------------------------------------------------------------- 迭代产品核心业务判定


def test_iteration_core_business_submit_and_confirm(
    client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session]
) -> None:
    _division, system = _seed_catalog(client, session_factory)
    project = _create_project(client, system, project_type="iteration", name="迭代体验项目")

    # 理由必填 → 422
    resp = client.post(f"/api/v1/projects/{project['id']}/core-business", json={"involved": True})
    assert resp.status_code == 422, resp.text

    resp = client.post(
        f"/api/v1/projects/{project['id']}/core-business",
        json={"involved": True, "reason": "涉及核心通话业务链路"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["core_business_involved"] is True
    assert resp.json()["core_business_confirmed_at"] is None

    # N04 未进行中时不可确认
    early = client.post(f"/api/v1/projects/{project['id']}/core-business/confirm", json={})
    assert early.status_code == 409, early.text
    assert early.json()["code"] == "precondition_failed"

    # 迭代产品：N01/N02 按 scope 自动不适用，N03 无上游依赖可直接开始
    nodes = _nodes(client, project["id"])
    assert nodes["N01"]["status"] == NODE_NOT_APPLICABLE
    assert nodes["N02"]["status"] == NODE_NOT_APPLICABLE
    _complete_node(client, session_factory, project["id"], nodes["N03"])
    nodes = _nodes(client, project["id"])
    assert _transition(client, nodes["N04"], action="start").status_code == 200

    confirmed = client.post(f"/api/v1/projects/{project['id']}/core-business/confirm", json={})
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["core_business_confirmed_at"] is not None

    # 迭代产品允许执行 N10（非自动不适用）
    nodes = _nodes(client, project["id"])
    assert nodes["N10"]["applicable"] is True
    assert nodes["N10"]["status"] == NODE_NOT_STARTED
    assert any(action["action"] == "start" for action in nodes["N10"]["allowed_actions"])


# --------------------------------------------------------------------------- 迭代主线节点范围


def test_iteration_mainline_scope_and_gates(
    client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session]
) -> None:
    """迭代项目：N01/N02 自动不适用，N03 无需 N02，N06 仍守 N04/N05 评审门禁。"""
    _division, system = _seed_catalog(client, session_factory)
    project = _create_project(client, system, project_type="iteration", name="迭代主线范围校验")

    nodes = _nodes(client, project["id"])
    assert len(nodes) == 13

    # N01/N02 为新产品专属 → 创建即不适用，理由带项目类型
    for code in ("N01", "N02"):
        assert nodes[code]["status"] == NODE_NOT_APPLICABLE
        assert nodes[code]["applicable"] is False
        assert "迭代产品" in nodes[code]["not_applicable_reason"]

    # N03–N13 初始均为未开始；N10 在迭代项目适用
    for code in (f"N{i:02d}" for i in range(3, 14)):
        assert nodes[code]["status"] == NODE_NOT_STARTED, code
    assert nodes["N10"]["applicable"] is True

    # N03 的上游 N02 不适用 → 不存在上游阻塞，可直接开始
    assert nodes["N03"]["blocked_reason"] == ""
    started = _transition(client, nodes["N03"], action="start")
    assert started.status_code == 200, started.text

    # N06 仍需 N04（及适用时的 N05）评审通过
    gate = _transition(client, nodes["N06"], action="start")
    assert gate.status_code == 409, gate.text
    assert "N04" in gate.json()["reason"]

    # 完成 N03 → N04 可开始（N03 已在上面 start，直接补产物后 complete）
    nodes = _nodes(client, project["id"])
    for kind in NODE_BY_CODE["N03"].artifact_kinds:
        _insert_artifact(session_factory, project_id=project["id"], node=nodes["N03"], kind=kind)
    assert _transition(client, nodes["N03"], action="complete").status_code == 200
    nodes = _nodes(client, project["id"])
    assert _transition(client, nodes["N04"], action="start").status_code == 200


# --------------------------------------------------------------------------- N11 门禁（DESIGN §6.1 N11 触发条件）


def _complete_chain(
    client: TestClient,
    session_factory: sessionmaker[Session],
    project_id: str,
    codes: tuple[str, ...],
) -> None:
    for code in codes:
        _complete_node(client, session_factory, project_id, _nodes(client, project_id)[code])


def test_n11_blocked_when_n07_not_completed(
    client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session]
) -> None:
    """N07 未完成、N09 已完成时，启动 N11 返回 409（不得绕过 N07）。"""
    _division, system = _seed_catalog(client, session_factory)
    project = _create_project(client, system)
    _complete_chain(client, session_factory, project["id"], ("N01", "N02", "N03", "N04", "N05", "N06", "N09"))

    nodes = _nodes(client, project["id"])
    assert nodes["N07"]["status"] == NODE_NOT_STARTED
    assert nodes["N09"]["status"] == "completed"

    resp = _transition(client, nodes["N11"], action="start")
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["code"] == "precondition_failed"
    assert "N07" in body["reason"]


def test_n11_blocked_in_iteration_until_n10_done(
    client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session]
) -> None:
    """迭代项目：N07/N09 已完成但 N10 未完成 → 启动 N11 返回 409；N10 完成后可启动。"""
    _division, system = _seed_catalog(client, session_factory)
    project = _create_project(client, system, project_type="iteration", name="迭代 N11 门禁校验")
    _complete_chain(client, session_factory, project["id"], ("N03", "N04", "N05", "N06", "N07", "N09"))

    nodes = _nodes(client, project["id"])
    assert nodes["N10"]["status"] == NODE_NOT_STARTED

    resp = _transition(client, nodes["N11"], action="start")
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["code"] == "precondition_failed"
    assert "N10" in body["reason"]
    # 409 响应必须包含 current / target / reason / allowed_targets
    for key in ("current", "target", "reason", "allowed_targets"):
        assert key in body, key

    _complete_node(client, session_factory, project["id"], _nodes(client, project["id"])["N10"])
    nodes = _nodes(client, project["id"])
    started = _transition(client, nodes["N11"], action="start")
    assert started.status_code == 200, started.text
    assert started.json()["status"] == "in_progress"


def test_n11_startable_new_product_with_auto_na_n10(
    client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session]
) -> None:
    """新产品：N07/N09 已完成且 N10 自动不适用 → 可启动 N11。"""
    _division, system = _seed_catalog(client, session_factory)
    project = _create_project(client, system)
    _complete_chain(client, session_factory, project["id"], ("N01", "N02", "N03", "N04", "N05", "N06", "N07", "N09"))

    nodes = _nodes(client, project["id"])
    assert nodes["N10"]["status"] == NODE_NOT_APPLICABLE
    started = _transition(client, nodes["N11"], action="start")
    assert started.status_code == 200, started.text
    assert started.json()["status"] == "in_progress"


def test_n11_startable_iteration_when_all_upstreams_done(
    client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session]
) -> None:
    """迭代项目：N07/N09/N10 均满足时，可启动 N11。"""
    _division, system = _seed_catalog(client, session_factory)
    project = _create_project(client, system, project_type="iteration", name="迭代 N11 正向路径")
    _complete_chain(
        client, session_factory, project["id"], ("N03", "N04", "N05", "N06", "N07", "N09", "N10")
    )

    nodes = _nodes(client, project["id"])
    for code in ("N07", "N09", "N10"):
        assert nodes[code]["status"] == "completed", code
    started = _transition(client, nodes["N11"], action="start")
    assert started.status_code == 200, started.text
    assert started.json()["status"] == "in_progress"


def test_n11_conflict_response_shape(
    client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session]
) -> None:
    """N11 的 409 响应包含 current、target、reason 和 allowed_targets。"""
    _division, system = _seed_catalog(client, session_factory)
    project = _create_project(client, system)
    _complete_chain(client, session_factory, project["id"], ("N01", "N02", "N03", "N04", "N05", "N06", "N09"))

    nodes = _nodes(client, project["id"])
    resp = _transition(client, nodes["N11"], target="in_progress")
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["current"] == NODE_NOT_STARTED
    assert body["target"] == "in_progress"
    assert "N07" in body["reason"]
    assert isinstance(body["allowed_targets"], list) and body["allowed_targets"]


# --------------------------------------------------------------------------- 看板与列表


def test_board_has_four_stages_and_node_cards(
    client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session]
) -> None:
    _division, system = _seed_catalog(client, session_factory)
    project = _create_project(client, system)

    board = client.get(f"/api/v1/projects/{project['id']}/board").json()
    assert [stage["code"] for stage in board["stages"]] == [stage.code for stage in STAGES]
    cards = [card for stage in board["stages"] for card in stage["nodes"]]
    assert len(cards) == 13
    assert cards[-1]["code"] == "N13"
    n10 = next(card for card in cards if card["code"] == "N10")
    assert n10["status"] == NODE_NOT_APPLICABLE
    assert n10["blocking"] is False

    listing = client.get("/api/v1/projects", params={"page_size": 10}).json()
    assert listing["total"] == 1
    item = listing["items"][0]
    assert item["system_name"] == "会议协作系统"
    assert item["version_code"] == "V7.32"
    assert item["current_node_code"] == "N01"
    assert item["project_type"] == "new_product"


# --------------------------------------------------------------------------- 乐观锁与鉴权


def test_patch_project_optimistic_lock_conflict(
    client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session]
) -> None:
    _division, system = _seed_catalog(client, session_factory)
    project = _create_project(client, system)

    ok = client.patch(
        f"/api/v1/projects/{project['id']}",
        json={"owner_text": "龙斌", "expected_version": project["row_version"]},
    )
    assert ok.status_code == 200, ok.text

    stale = client.patch(
        f"/api/v1/projects/{project['id']}",
        json={"owner_text": "他人", "expected_version": project["row_version"]},
    )
    assert stale.status_code == 409, stale.text
    assert stale.json()["code"] == "version_conflict"


def test_endpoints_require_login(client: TestClient) -> None:
    client.cookies.clear()
    assert client.get("/api/v1/projects").status_code == 401
    assert client.get("/api/v1/workflow-nodes/meta/specs").status_code == 401
    assert client.get("/api/v1/divisions").status_code == 401


def test_missing_entity_returns_404(client: TestClient, setup_primary: dict) -> None:
    assert client.get("/api/v1/projects/does-not-exist").status_code == 404
    assert client.get("/api/v1/systems/does-not-exist").status_code == 404


# --------------------------------------------------------------------------- 目录唯一性与 is_current 互斥


def test_catalog_uniqueness_and_system_archive_guard(
    client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session]
) -> None:
    division, system = _seed_catalog(client, session_factory)

    dup_division = client.post("/api/v1/divisions", json={"code": "DIV-01", "name": "重复"})
    assert dup_division.status_code == 409, dup_division.text
    dup_system = client.post("/api/v1/systems", json={"code": "SYS-1001", "name": "重复", "scheme_id": system["scheme_id"]})
    assert dup_system.status_code == 409, dup_system.text

    # 系统下有进行中项目 → 停用系统 409
    project = _create_project(client, system)
    blocked = client.post(f"/api/v1/systems/{system['id']}/archive", json={"reason": "停产"})
    assert blocked.status_code == 409, blocked.text
    assert blocked.json()["code"] == "system_has_active_projects"

    # 归档项目后可停用系统，历史保留
    archived_project = client.post(f"/api/v1/projects/{project['id']}/archive", json={"reason": "结项"})
    assert archived_project.status_code == 200, archived_project.text
    archived = client.post(f"/api/v1/systems/{system['id']}/archive", json={"reason": "停产"})
    assert archived.status_code == 200
    assert archived.json()["status"] == "archived"
    assert client.get(f"/api/v1/systems/{system['id']}").status_code == 200

    assert division["id"]


def test_project_list_filters(
    client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session]
) -> None:
    _division, system = _seed_catalog(client, session_factory)
    _create_project(client, system, project_type="new_product", name="新产品项目")
    _create_project(client, system, project_type="iteration", name="迭代项目")

    only_iteration = client.get("/api/v1/projects", params={"project_type": "iteration"}).json()
    assert only_iteration["total"] == 1
    assert only_iteration["items"][0]["name"] == "迭代项目"

    keyword = client.get("/api/v1/projects", params={"keyword": "新产品"}).json()
    assert keyword["total"] == 1
    assert keyword["items"][0]["project_type"] == "new_product"


def test_catalog_update_and_archive_paths(
    client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session]
) -> None:
    division, system = _seed_catalog(client, session_factory)

    updated = client.patch(f"/api/v1/divisions/{division['id']}", json={"owner_text": "张三"})
    assert updated.status_code == 200 and updated.json()["owner_text"] == "张三"

    listing = client.get("/api/v1/divisions", params={"keyword": "商用"}).json()
    assert listing["total"] == 1
    assert listing["items"][0]["system_count"] == 1

    system_updated = client.patch(f"/api/v1/systems/{system['id']}", json={"note": "v1.1 系统备注"})
    assert system_updated.status_code == 200, system_updated.text
    assert system_updated.json()["note"] == "v1.1 系统备注"

    project = _create_project(client, system)
    archived = client.post(f"/api/v1/projects/{project['id']}/archive", json={"reason": "结项"})
    assert archived.status_code == 200
    assert archived.json()["status"] == "archived"

    # 事业部停用不物理删除，仍可查询
    div_archived = client.post(f"/api/v1/divisions/{division['id']}/archive", json={})
    assert div_archived.status_code == 200
    assert div_archived.json()["status"] == "archived"
    assert client.get(f"/api/v1/divisions/{division['id']}").status_code == 200


def test_planned_dates_follow_duration_chain(
    client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session]
) -> None:
    _division, system = _seed_catalog(client, session_factory)
    project = _create_project(client, system)
    nodes = _nodes(client, project["id"])

    from app.core.timeutil import to_naive_utc

    def _parse(value: str) -> _dt.datetime:
        return _dt.datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(_dt.timezone.utc).replace(tzinfo=None)

    cursor = _parse(nodes["N01"]["planned_start_at"])
    for spec in NODE_SPECS:
        node = nodes[spec.code]
        assert _parse(node["planned_start_at"]) == cursor
        cursor += _dt.timedelta(days=spec.duration_days)
        assert _parse(node["planned_end_at"]) == cursor
    assert to_naive_utc(_dt.datetime.now(_dt.timezone.utc)) is not None
