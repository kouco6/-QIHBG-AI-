"""T09 验收：可用性研究与报告（N12）。

覆盖 ACCEPTANCE T09 与 PRD §10 全部口径：

- SUS 标准样例手算复核（100 / 0 / 85.0）；
- **缺题不计算**（不得返回 0）；
- 满意度 1–10（越界 422，肯定式文案）；
- **无效参与者不进均值**，原始值与排除理由保留；
- 耗时不得为负；
- 模块 Top N 聚合、新手 vs 熟手时间对比；
- 从脚本设计产物导入任务；
- 401 / 404 / 别名重复 409；
- 报告生成完整结构。

夹具直接用 ORM 构造 Division / System / Project / WorkflowNode，
不依赖其他任务模块的服务实现。
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.core.security import new_id
from app.core.timeutil import utcnow
from app.domain import states as st
from app.models.artifact import Artifact, ArtifactVersion
from app.models.flow import Division, Project, WorkflowNode
from app.models.systems import System
from tests.conftest import PRIMARY  # noqa: F401  （保持与其他测试一致的可发现性）

BASE = "/api/v1/usability-studies"


# --------------------------------------------------------------------------- 夹具


def _build_project(session_factory: sessionmaker[Session], *, with_n12: bool = True) -> dict[str, str]:
    ids = {
        "division_id": new_id(),
        "system_id": new_id(),
        "project_id": new_id(),
        "node_n08_id": new_id(),
        "node_n12_id": new_id(),
    }
    now = utcnow()
    with session_factory() as db:
        db.add(Division(id=ids["division_id"], code=f"DIV-UE-{ids['division_id'][:4]}", name="产品事业部"))
        db.add(
            System(
                id=ids["system_id"],
                code=f"SYS-UE-{ids['system_id'][:4]}",
                name="会议协作系统",
                division_id=ids["division_id"],
                scheme_id="scheme-default",
            )
        )
        db.add(
            Project(
                id=ids["project_id"],
                code=f"PRJ-UE-{ids['project_id'][:4]}",
                name="会议一体机体验项目",
                system_id=ids["system_id"],
                version_code="V7.32",
                division_id=ids["division_id"],
                project_type="new_product",
                owner_text="项目负责人",
            )
        )
        db.add(
            WorkflowNode(
                id=ids["node_n08_id"],
                project_id=ids["project_id"],
                code="N08",
                node_order=8,
                stage_code="S3",
                name="脚本设计",
                outputs_text="脚本设计",
                created_at=now,
                updated_at=now,
            )
        )
        if with_n12:
            db.add(
                WorkflowNode(
                    id=ids["node_n12_id"],
                    project_id=ids["project_id"],
                    code="N12",
                    node_order=12,
                    stage_code="S4",
                    name="可用性测试/小组走查",
                    outputs_text="可用性测试报告/小组走查报告",
                    created_at=now,
                    updated_at=now,
                )
            )
        db.commit()
    return ids


@pytest.fixture()
def project(session_factory: sessionmaker[Session]) -> dict[str, str]:
    return _build_project(session_factory)


def _create_study(client: TestClient, project: dict[str, str], **overrides) -> dict:
    payload = {
        "project_id": project["project_id"],
        "name": "会议一体机可用性测试",
        "study_kind": "usability_test",
        "version_code": "V7.32",
    }
    payload.update(overrides)
    resp = client.post(BASE, json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _add_participants(client: TestClient, study_id: str, items: list[dict]) -> list[dict]:
    resp = client.post(f"{BASE}/{study_id}/participants", json={"participants": items})
    assert resp.status_code == 201, resp.text
    return resp.json()["items"]


def _add_task(client: TestClient, study_id: str, **overrides) -> dict:
    payload = {
        "flow": "一、会前",
        "module": "会议预约",
        "content": "预约一场会议",
        "expected": "预约成功",
    }
    payload.update(overrides)
    resp = client.post(f"{BASE}/{study_id}/tasks", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _put_run(client: TestClient, study_id: str, **body) -> tuple[int, dict]:
    resp = client.put(f"{BASE}/{study_id}/runs", json=body)
    return resp.status_code, resp.json()


def _put_sus(client: TestClient, study_id: str, **body) -> tuple[int, dict]:
    resp = client.put(f"{BASE}/{study_id}/sus", json=body)
    return resp.status_code, resp.json()


def _sus_body(q: list[int | None]) -> dict:
    return {f"q{i + 1}": q[i] for i in range(10)}


def _stats(client: TestClient, study_id: str, **params) -> dict:
    resp = client.get(f"{BASE}/{study_id}/stats", params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


# =========================================================================== 1. SUS 标准算法


def test_sus_standard_samples_hand_checked(client: TestClient, setup_primary: dict, project: dict) -> None:
    study = _create_study(client, project)
    sid = study["id"]

    # 样例一：全满分 → 100
    code, body = _put_sus(client, sid, participant_id="n/a", **_sus_body([5, 1, 5, 1, 5, 1, 5, 1, 5, 1]))
    # 参与者不存在 → 404，改用纯计算端点复核
    assert code == 404

    r1 = client.post(f"{BASE}/{sid}/sus/calculate", json=_sus_body([5, 1, 5, 1, 5, 1, 5, 1, 5, 1]))
    assert r1.status_code == 200, r1.text
    b1 = r1.json()
    assert b1["sus_score"] == "100.0"
    assert b1["industry_reference"] == "67.6"
    assert b1["difference"] == "32.4"
    assert b1["missing_questions"] == []
    assert b1["is_complete"] is True

    # 样例二：全最低 → 0
    b2 = client.post(f"{BASE}/{sid}/sus/calculate", json=_sus_body([1, 5, 1, 5, 1, 5, 1, 5, 1, 5])).json()
    assert b2["sus_score"] == "0.0"
    assert b2["difference"] == "-67.6"

    # 样例三：混合值手算
    # 奇题 4,5,4,5,4 → (4-1)+(5-1)+(4-1)+(5-1)+(4-1)=3+4+3+4+3=17
    # 偶题 2,1,2,1,2 → (5-2)+(5-1)+(5-2)+(5-1)+(5-2)=3+4+3+4+3=17
    # 合计 34 × 2.5 = 85.0
    b3 = client.post(f"{BASE}/{sid}/sus/calculate", json=_sus_body([4, 2, 5, 1, 4, 2, 5, 1, 4, 2])).json()
    assert b3["sus_score"] == "85.0"
    assert b3["difference"] == "17.4"
    assert b3["total_converted"] == 34
    assert len(b3["details"]) == 10
    # 逐题换算明细：奇题减 1、偶题 5 减得分
    assert b3["details"][0] == {
        "question": 1,
        "raw": 4,
        "converted": 3,
        "direction": "正向（得分 - 1）",
    }
    assert b3["details"][1]["converted"] == 3
    assert b3["details"][1]["direction"] == "反向（5 - 得分）"


# =========================================================================== 2. 缺题不计算


def test_sus_missing_question_returns_none_not_zero(
    client: TestClient, setup_primary: dict, project: dict
) -> None:
    study = _create_study(client, project)
    sid = study["id"]

    # 缺 q7 → 不计算，且能定位缺题号
    body = _sus_body([5, 1, 5, 1, 5, 1, None, 1, 5, 1])
    resp = client.post(f"{BASE}/{sid}/sus/calculate", json=body)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["sus_score"] is None
    assert data["sus_score"] != "0.0"
    assert data["missing_questions"] == [7]
    assert data["is_complete"] is False
    assert data["difference"] is None

    # 落库路径同样不计算
    participants = _add_participants(client, sid, [{"alias": "P1", "group_type": "novice"}])
    pid = participants[0]["id"]
    code, stored = _put_sus(client, sid, participant_id=pid, **body)
    assert code == 200, stored
    assert stored["sus_score"] is None
    assert stored["missing_questions"] == [7]


# =========================================================================== 3. 满意度越界


def test_satisfaction_out_of_range_is_422_with_affirmative_message(
    client: TestClient, setup_primary: dict, project: dict
) -> None:
    study = _create_study(client, project)
    sid = study["id"]
    pid = _add_participants(client, sid, [{"alias": "P1", "group_type": "novice"}])[0]["id"]

    for value in (0, 11):
        resp = client.patch(f"{BASE}/{sid}/participants/{pid}", json={"satisfaction": value})
        assert resp.status_code == 422, resp.text
        payload = resp.json()
        assert payload["code"] == "validation_error"
        messages = " ".join(fe["message"] for fe in payload["field_errors"])
        assert "满意度要在 1–10 分之间" in messages

    # 合法值 1–10 可写入
    ok = client.patch(f"{BASE}/{sid}/participants/{pid}", json={"satisfaction": 10})
    assert ok.status_code == 200 and ok.json()["satisfaction"] == 10

    # SUS 录入中的满意度同样校验
    bad = client.put(f"{BASE}/{sid}/sus", json={"participant_id": pid, **_sus_body([5] * 10), "satisfaction": 11})
    assert bad.status_code == 422, bad.text
    assert "满意度要在 1–10 分之间" in " ".join(fe["message"] for fe in bad.json()["field_errors"])


# =========================================================================== 4. 无效参与者不进均值


def test_invalid_participant_excluded_from_means_keeps_raw_values(
    client: TestClient, setup_primary: dict, project: dict
) -> None:
    study = _create_study(client, project)
    sid = study["id"]
    participants = _add_participants(
        client,
        sid,
        [
            {"alias": "P1", "group_type": "novice"},
            {"alias": "P2", "group_type": "expert"},
            {"alias": "P3", "group_type": "novice"},
        ],
    )
    p1, p2, p3 = (p["id"] for p in participants)

    # P1 → 100；P2 → 85.0；P3（将被排除）→ 0.0
    assert _put_sus(client, sid, participant_id=p1, **_sus_body([5, 1, 5, 1, 5, 1, 5, 1, 5, 1]))[0] == 200
    assert _put_sus(client, sid, participant_id=p2, **_sus_body([4, 2, 5, 1, 4, 2, 5, 1, 4, 2]))[0] == 200
    assert _put_sus(client, sid, participant_id=p3, **_sus_body([1, 5, 1, 5, 1, 5, 1, 5, 1, 5]))[0] == 200
    assert (
        client.patch(f"{BASE}/{sid}/participants/{p1}", json={"satisfaction": 8}).status_code == 200
    )
    assert (
        client.patch(f"{BASE}/{sid}/participants/{p2}", json={"satisfaction": 6}).status_code == 200
    )
    assert (
        client.patch(f"{BASE}/{sid}/participants/{p3}", json={"satisfaction": 2}).status_code == 200
    )

    # 标记 P3 无效：必须填理由
    bad = client.patch(f"{BASE}/{sid}/participants/{p3}", json={"is_valid": False})
    assert bad.status_code == 422, bad.text

    ok = client.patch(
        f"{BASE}/{sid}/participants/{p3}",
        json={"is_valid": False, "exclusion_reason": "中途退出，未完成任务"},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["is_valid"] is False

    stats = _stats(client, sid)
    # 均值只按 2 名有效参与者：(100.0 + 85.0) / 2 = 92.5
    assert stats["sus"]["mean"] == "92.5"
    assert stats["sus"]["valid_sample_count"] == 2
    # 满意度均值只按 2 名有效参与者：(8 + 6) / 2 = 7.0
    assert stats["satisfaction"]["mean"] == "7.0"
    assert stats["satisfaction"]["valid_sample_count"] == 2

    # 无效参与者显式列出，含理由与原始值（SUS 0.0、满意度 2）
    invalid = stats["invalid_participants"]
    assert invalid["count"] == 1
    entry = invalid["items"][0]
    assert entry["alias"] == "P3"
    assert entry["exclusion_reason"] == "中途退出，未完成任务"
    assert entry["sus_score"] == "0.0"
    assert entry["satisfaction"] == 2
    assert entry["excluded_from_means"] is True
    assert entry["raw_values_retained"] is True

    # 明细中 P3 标记为未纳入
    p3_detail = next(d for d in stats["sus"]["details"] if d["alias"] == "P3")
    assert p3_detail["included"] is False
    assert p3_detail["sus_score"] == "0.0"


# =========================================================================== 5. 耗时不为负


def test_negative_duration_is_422(client: TestClient, setup_primary: dict, project: dict) -> None:
    study = _create_study(client, project)
    sid = study["id"]
    pid = _add_participants(client, sid, [{"alias": "P1", "group_type": "novice"}])[0]["id"]
    task = _add_task(client, sid)

    code, body = _put_run(
        client,
        sid,
        task_id=task["id"],
        participant_id=pid,
        status="completed",
        duration_seconds=-1,
    )
    assert code == 422, body
    assert "任务耗时要在 0 秒及以上" in " ".join(fe["message"] for fe in body["field_errors"])

    # 0 秒合法
    code, body = _put_run(
        client, sid, task_id=task["id"], participant_id=pid, status="completed", duration_seconds=0
    )
    assert code == 200, body


# =========================================================================== 6. 模块 Top N


def test_module_top_n_aggregation(client: TestClient, setup_primary: dict, project: dict) -> None:
    study = _create_study(client, project)
    sid = study["id"]
    participants = _add_participants(
        client,
        sid,
        [
            {"alias": "P1", "group_type": "novice"},
            {"alias": "P2", "group_type": "novice"},
            {"alias": "P3", "group_type": "expert"},
        ],
    )
    pids = [p["id"] for p in participants]
    t_a = _add_task(client, sid, module="模块A", content="任务A", task_no=1)
    t_b = _add_task(client, sid, module="模块B", content="任务B", task_no=2)
    t_c = _add_task(client, sid, module="模块C", content="任务C", task_no=3)

    # 模块A：3 人 × 未完成，每人 2 个错误步骤 → run 3 / failed 3 / error 6
    for pid in pids:
        code, body = _put_run(
            client,
            sid,
            task_id=t_a["id"],
            participant_id=pid,
            status="failed",
            duration_seconds=60,
            error_steps="步骤一失败\n步骤二失败",
        )
        assert code == 200, body
        assert body["run"]["error_count"] == 2

    # 模块B：2 人完成 → run 2 / failed 0 / error 0
    for pid in pids[:2]:
        assert _put_run(
            client, sid, task_id=t_b["id"], participant_id=pid, status="completed", duration_seconds=30
        )[0] == 200

    # 模块C：1 人完成
    assert _put_run(
        client, sid, task_id=t_c["id"], participant_id=pids[0], status="completed", duration_seconds=20
    )[0] == 200

    stats = _stats(client, sid)
    items = stats["module_top_n"]["items"]
    by_module = {item["module"]: item for item in items}

    assert by_module["模块A"]["run_count"] == 3
    assert by_module["模块A"]["failed_count"] == 3
    assert by_module["模块A"]["error_count"] == 6
    assert by_module["模块A"]["avg_duration_seconds"] == 60.0
    assert by_module["模块B"]["run_count"] == 2
    assert by_module["模块B"]["failed_count"] == 0
    assert by_module["模块C"]["run_count"] == 1

    # 排序：失败优先 → 模块A 居首
    assert items[0]["module"] == "模块A"

    # top_n 生效
    limited = _stats(client, sid, top_n=2)
    assert len(limited["module_top_n"]["items"]) == 2
    assert limited["module_top_n"]["top_n"] == 2


# =========================================================================== 7. 新手 / 熟手时间对比


def test_novice_vs_expert_timing_ratio(client: TestClient, setup_primary: dict, project: dict) -> None:
    study = _create_study(client, project)
    sid = study["id"]
    participants = _add_participants(
        client,
        sid,
        [
            {"alias": "N1", "group_type": "novice"},
            {"alias": "N2", "group_type": "novice"},
            {"alias": "E1", "group_type": "expert"},
            {"alias": "E2", "group_type": "expert"},
        ],
    )
    ids = {p["alias"]: p["id"] for p in participants}
    task = _add_task(client, sid)

    # 新手：360 / 240 → 均值 300；熟手：100 / 100 → 均值 100；倍数 3.0
    durations = {"N1": 360, "N2": 240, "E1": 100, "E2": 100}
    for alias, duration in durations.items():
        code, body = _put_run(
            client,
            sid,
            task_id=task["id"],
            participant_id=ids[alias],
            status="completed",
            duration_seconds=duration,
        )
        assert code == 200, body

    timing = _stats(client, sid)["timing"]
    assert timing["novice_avg_duration_seconds"] == 300.0
    assert timing["expert_avg_duration_seconds"] == 100.0
    assert timing["novice_vs_expert_ratio"] == 3.0
    assert timing["overall_avg_duration_seconds"] == 200.0
    assert timing["sample_scope"] == "valid_participants"


# =========================================================================== 8. 从脚本产物导入任务


def test_import_tasks_from_script_artifact(
    client: TestClient, setup_primary: dict, project: dict, session_factory: sessionmaker[Session]
) -> None:
    study = _create_study(client, project)
    sid = study["id"]

    artifact_id = new_id()
    now = utcnow()
    rows = [
        {"序号": 1, "流程": "一、会前", "功能模块": "会议预约", "任务内容": "预约一场会议", "预期完成结果": "预约成功"},
        ["2", "二、会中", "共享白板", "发起白板共享", "白板正常共享"],
    ]
    with session_factory() as db:
        db.add(
            Artifact(
                id=artifact_id,
                project_id=project["project_id"],
                node_id=project["node_n08_id"],
                node_code="N08",
                kind="script_design",
                title="会议一体机脚本设计",
                status=st.ARTIFACT_DRAFT,
                current_version_no=1,
                created_at=now,
                updated_at=now,
            )
        )
        db.add(
            ArtifactVersion(
                id=new_id(),
                artifact_id=artifact_id,
                version_no=1,
                status=st.ARTIFACT_DRAFT,
                payload_json=json.dumps({"flow": "一、会前", "rows": rows}, ensure_ascii=False),
                created_at=now,
                updated_at=now,
            )
        )
        db.commit()

    resp = client.post(f"{BASE}/{sid}/tasks/import-from-script", json={"artifact_id": artifact_id})
    assert resp.status_code == 201, resp.text
    items = resp.json()["items"]
    assert len(items) == 2
    assert items[0]["task_no"] == 1
    assert items[0]["module"] == "会议预约"
    assert items[0]["content"] == "预约一场会议"
    assert items[0]["expected"] == "预约成功"
    # 列表形式（按列对齐）也能解析
    assert items[1]["task_no"] == 2
    assert items[1]["flow"] == "二、会中"
    assert items[1]["module"] == "共享白板"

    # 非脚本产物 → 422
    other = new_id()
    with session_factory() as db:
        db.add(
            Artifact(
                id=other,
                project_id=project["project_id"],
                node_id=project["node_n08_id"],
                node_code="N08",
                kind="prototype_report",
                title="原型报告",
                status=st.ARTIFACT_DRAFT,
                current_version_no=1,
                created_at=now,
                updated_at=now,
            )
        )
        db.add(
            ArtifactVersion(
                id=new_id(),
                artifact_id=other,
                version_no=1,
                payload_json="{}",
                created_at=now,
                updated_at=now,
            )
        )
        db.commit()
    bad = client.post(f"{BASE}/{sid}/tasks/import-from-script", json={"artifact_id": other})
    assert bad.status_code == 422, bad.text


def test_import_from_script_missing_artifact_is_404(
    client: TestClient, setup_primary: dict, project: dict
) -> None:
    study = _create_study(client, project)
    resp = client.post(f"{BASE}/{study['id']}/tasks/import-from-script", json={"artifact_id": new_id()})
    assert resp.status_code == 404, resp.text


# =========================================================================== 9. 鉴权 / 404 / 409


def test_unauthenticated_returns_401(client: TestClient) -> None:
    resp = client.get(BASE)
    assert resp.status_code == 401, resp.text


def test_missing_study_returns_404(client: TestClient, setup_primary: dict) -> None:
    resp = client.get(f"{BASE}/{new_id()}")
    assert resp.status_code == 404, resp.text
    resp2 = client.get(f"{BASE}/{new_id()}/stats")
    assert resp2.status_code == 404, resp2.text


def test_duplicate_participant_alias_is_409(
    client: TestClient, setup_primary: dict, project: dict
) -> None:
    study = _create_study(client, project)
    sid = study["id"]
    _add_participants(client, sid, [{"alias": "P1", "group_type": "novice"}])

    dup = client.post(f"{BASE}/{sid}/participants", json={"participants": [{"alias": "P1", "group_type": "expert"}]})
    assert dup.status_code == 409, dup.text
    assert dup.json()["code"] == "participant_alias_duplicated"

    # 同一批次内重复也拒绝
    dup2 = client.post(
        f"{BASE}/{sid}/participants",
        json={
            "participants": [
                {"alias": "P2", "group_type": "novice"},
                {"alias": "P2", "group_type": "novice"},
            ]
        },
    )
    assert dup2.status_code == 409, dup2.text


def test_invalid_enum_and_missing_project_are_422(
    client: TestClient, setup_primary: dict, project: dict
) -> None:
    # 缺少 project_id → 422
    resp = client.post(BASE, json={"name": "X", "study_kind": "usability_test"})
    assert resp.status_code == 422, resp.text

    # 非法研究类型 → 422
    resp2 = client.post(
        BASE,
        json={"project_id": project["project_id"], "name": "X", "study_kind": "unknown_kind"},
    )
    assert resp2.status_code == 422, resp2.text

    study = _create_study(client, project)
    bad_group = client.post(
        f"{BASE}/{study['id']}/participants",
        json={"participants": [{"alias": "P9", "group_type": "vip"}]},
    )
    assert bad_group.status_code == 422, bad_group.text

    bad_status = client.put(
        f"{BASE}/{study['id']}/runs",
        json={"task_id": "t", "participant_id": "p", "status": "unknown"},
    )
    assert bad_status.status_code == 422, bad_status.text


# =========================================================================== 10. 报告生成


def test_report_generation_full_structure(client: TestClient, setup_primary: dict, project: dict) -> None:
    study = _create_study(client, project)
    sid = study["id"]
    participants = _add_participants(
        client,
        sid,
        [
            {"alias": "N1", "group_type": "novice"},
            {"alias": "E1", "group_type": "expert"},
        ],
    )
    ids = {p["alias"]: p["id"] for p in participants}
    task = _add_task(client, sid, module="会议预约")

    for alias, duration, status_value in (("N1", 300, "completed"), ("E1", 100, "failed")):
        assert _put_run(
            client,
            sid,
            task_id=task["id"],
            participant_id=ids[alias],
            status=status_value,
            duration_seconds=duration,
            error_steps="出错步骤" if status_value == "failed" else "",
        )[0] == 200
    assert _put_sus(client, sid, participant_id=ids["N1"], **_sus_body([5, 1, 5, 1, 5, 1, 5, 1, 5, 1]))[0] == 200
    assert _put_sus(client, sid, participant_id=ids["E1"], **_sus_body([4, 2, 5, 1, 4, 2, 5, 1, 4, 2]))[0] == 200
    assert client.patch(f"{BASE}/{sid}/participants/{ids['N1']}", json={"satisfaction": 9}).status_code == 200
    assert client.patch(f"{BASE}/{sid}/participants/{ids['E1']}", json={"satisfaction": 7}).status_code == 200

    resp = client.post(f"{BASE}/{sid}/report", json={"create_artifact": True, "top_n": 5})
    assert resp.status_code == 200, resp.text
    report = resp.json()

    # 结构完整
    for key in ("study", "summary", "improvement", "details", "module_overview", "module_top_n", "artifact"):
        assert key in report, key

    summary = report["summary"]
    for key in ("sus", "module_top_n", "completion", "timing", "satisfaction", "text"):
        assert key in summary, key
    # SUS 均值 (100.0 + 85.0) / 2 = 92.5
    assert summary["sus"]["mean"] == "92.5"
    assert summary["sus"]["industry_reference"] == "67.6"
    assert summary["satisfaction"]["mean"] == "8.0"
    assert summary["timing"]["novice_vs_expert_ratio"] == 3.0
    assert "SUS" in summary["text"]

    # 改进方案区为占位说明
    assert report["improvement"]["status"] == "placeholder"
    assert "改进方案" in report["improvement"]["note"]

    # 模块级问题总览
    assert isinstance(report["module_overview"], list)
    assert report["module_overview"][0]["module"] == "会议预约"

    # 产物已创建并关联（项目存在 N12 节点）
    assert report["artifact"] is not None
    assert report["artifact"]["kind"] == "usability_report"
    assert report["artifact"]["node_code"] == "N12"

    # 详情报告状态变为已生成
    detail = client.get(f"{BASE}/{sid}").json()
    assert detail["report"]["has_report"] is True
    assert detail["report"]["status"] == "generated"


def test_report_without_n12_node_returns_report_only(
    client: TestClient, setup_primary: dict, session_factory: sessionmaker[Session]
) -> None:
    project = _build_project(session_factory, with_n12=False)
    study = _create_study(client, project)
    resp = client.post(f"{BASE}/{study['id']}/report", json={"create_artifact": True})
    assert resp.status_code == 200, resp.text
    report = resp.json()
    assert report["artifact"]["created"] is False
    assert "N12" in report["artifact"]["reason"]

    detail = client.get(f"{BASE}/{study['id']}").json()
    assert detail["report"]["has_report"] is False


# =========================================================================== 附加：列表 / 详情 / 不适用


def test_list_filters_and_study_lifecycle(
    client: TestClient, setup_primary: dict, project: dict
) -> None:
    study = _create_study(client, project)
    sid = study["id"]
    assert study["code"].startswith("US-")
    assert study["project_name"] == "会议一体机体验项目"
    assert study["study_kind_label"] == "可用性测试"

    # 添加参与者后自动进入进行中
    _add_participants(client, sid, [{"alias": "P1", "group_type": "novice"}])
    detail = client.get(f"{BASE}/{sid}").json()
    assert detail["status"] == "running"
    assert detail["counts"]["participants_valid"] == 1

    # 列表过滤
    listing = client.get(BASE, params={"project_id": project["project_id"]}).json()
    assert listing["page_size"] == 50
    assert listing["total"] >= 1
    assert listing["items"][0]["participant_count"] == 1

    # 标记不适用：理由必填
    bad = client.post(f"{BASE}/{sid}/mark-na", json={"reason": "   "})
    assert bad.status_code == 422, bad.text
    ok = client.post(f"{BASE}/{sid}/mark-na", json={"reason": "本次无待测版本"})
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["is_not_applicable"] is True
    assert body["not_applicable_reason"] == "本次无待测版本"


def test_run_matrix_and_idempotent_upsert(
    client: TestClient, setup_primary: dict, project: dict
) -> None:
    study = _create_study(client, project)
    sid = study["id"]
    pid = _add_participants(client, sid, [{"alias": "P1", "group_type": "novice"}])[0]["id"]
    task = _add_task(client, sid)

    code, body = _put_run(
        client, sid, task_id=task["id"], participant_id=pid, status="partial", duration_seconds=45
    )
    assert code == 200
    assert body["run"]["status"] == "partial"
    assert body["matrix_progress"]["run_count"] == 1
    assert body["matrix_progress"]["completed_run_count"] == 0
    assert body["matrix_progress"]["expected_run_count"] == 1

    # 幂等：同 task + participant 第二次为更新而非新增
    code2, body2 = _put_run(
        client, sid, task_id=task["id"], participant_id=pid, status="completed", duration_seconds=50
    )
    assert code2 == 200
    assert body2["run"]["id"] == body["run"]["id"]
    assert body2["matrix_progress"]["run_count"] == 1
    assert body2["matrix_progress"]["completed_run_count"] == 1
    assert body2["matrix_progress"]["completion_rate"] == 100.0

    matrix = client.get(f"{BASE}/{sid}/runs").json()
    assert matrix["tasks"][0]["id"] == task["id"]
    row = matrix["rows"][0]
    assert row["alias"] == "P1"
    cell = row["cells"][task["id"]]
    assert cell["status"] == "completed"
    assert cell["duration_seconds"] == 50


def test_task_delete_conflict_when_referenced(
    client: TestClient, setup_primary: dict, project: dict
) -> None:
    study = _create_study(client, project)
    sid = study["id"]
    pid = _add_participants(client, sid, [{"alias": "P1", "group_type": "novice"}])[0]["id"]
    task = _add_task(client, sid)

    # 未被引用时可删
    free = _add_task(client, sid, content="临时任务")
    assert client.delete(f"{BASE}/{sid}/tasks/{free['id']}").status_code == 200

    # 被引用时 409
    assert _put_run(
        client, sid, task_id=task["id"], participant_id=pid, status="completed", duration_seconds=10
    )[0] == 200
    conflict = client.delete(f"{BASE}/{sid}/tasks/{task['id']}")
    assert conflict.status_code == 409, conflict.text
    assert conflict.json()["code"] == "task_referenced"
