"""T10 回归测试（v1.1 层级合并）：系统成员（项目）、L2 并集重算、系统快照与跨系统对比。

覆盖 SPEC（T10 / ACCEPTANCE「L2 系统合并 UEI」），语义映射：产品线 → 系统、成员 → 项目成员：

1. 项目通过 ``system_id`` 直挂系统；可在系统间**转移**（历史审计保留），权重可调；
2. 同一问题 ID 在多份来源快照中**只扣一次**（``raw_issue_count > deduped_issue_count``）；
3. 重算**只用系统绑定方案**（项目原快照用别的方案 → 标记口径外，仍按系统方案纳入）；
4. 筛选条件**随系统快照保存**（``filters_json`` 可读回）；
5. 样本不足（有效项目 < 2 或去重问题 < 5）→ 不给结论、不排名；
6. 三个口径并列：``authoritative_uei``（权威去重重算）、
   ``weighted_average_uei``（Σ(项目UEI×权重)/Σ权重）、``bucket_uei``（最低项目 UEI），
   辅助口径标 ``authoritative=false``；
7. 跨系统对比只允许 2–5 个（1 个或 6 个 422，3 个成功）；
8. 方案解析：显式指定 > 项目所属系统绑定方案 > 默认方案；
9. 换方案自增绑定版本且历史快照不受影响；系统快照不可变（405）。

测试夹具：直接插入 Issue 快照（ProjectScoreSnapshot / SnapshotIssue），项目经 ORM 或 API 构造。
"""

from __future__ import annotations

import datetime as _dt
import json
from decimal import Decimal

from sqlalchemy import select

from app.core.security import new_id
from app.core.timeutil import utcnow
from app.domain import scoring as sc
from app.models.flow import Division, Project
from app.models.scoring import ProjectScoreSnapshot, ScoringScheme, SnapshotIssue
from app.models.systems import SystemSnapshot
from app.seeds.scoring_schemes import scheme_cell_map

PRIMARY = {"name": "龙斌", "account": "longbin", "password": "UeiWorkbench2026"}


def login(client, account: str, password: str) -> None:
    resp = client.post("/api/v1/auth/login", json={"account": account, "password": password})
    assert resp.status_code == 200, resp.text


def setup_primary(client) -> None:
    resp = client.post("/api/v1/auth/setup", json={**PRIMARY, "confirm_password": PRIMARY["password"]})
    assert resp.status_code == 201, resp.text


# --------------------------------------------------------------------------- 数据构造


def seed_division(session_factory, *, suffix: str) -> str:
    with session_factory() as db:
        division = Division(id=new_id(), code=f"DIV-SYS-{suffix}", name=f"事业部-SYS-{suffix}")
        db.add(division)
        db.commit()
        return division.id


def seed_project(
    session_factory,
    *,
    suffix: str,
    system_id: str,
    division_id: str | None = None,
    version_code: str = "V1.0",
    weight: str = "1",
) -> dict[str, str]:
    """直接以 ORM 构造挂系统项目（v1.1：项目直挂系统，带版本号与权重）。"""
    with session_factory() as db:
        code = f"PRJ-{suffix}"
        project = Project(
            id=new_id(),
            code=code,
            name=f"项目-{suffix}",
            system_id=system_id,
            division_id=division_id,
            version_code=version_code,
            weight=weight,
            project_type="new_product",
        )
        db.add(project)
        db.commit()
        return {"id": project.id, "name": project.name, "code": code}


def scheme_id_by_code(session_factory, code: str) -> str:
    with session_factory() as db:
        row = db.execute(select(ScoringScheme).where(ScoringScheme.code == code)).scalars().first()
        assert row is not None, f"缺少方案 {code}"
        return row.id


def insert_l1_snapshot(
    session_factory,
    *,
    project_id: str,
    project_name: str,
    scheme_id: str,
    scheme_code: str,
    issues: list[tuple[str, str, str]],
    snapshot_at: _dt.datetime,
    version_code: str = "V1.0",
    is_effective: bool = True,
) -> str:
    """直接写入不可变 L1 快照与逐问题明细（issues: (issue_id, business_level, severity)）。"""
    with session_factory() as db:
        cell_map = scheme_cell_map(db, scheme_id)
        snapshot_id = new_id()
        core = Decimal("0")
        non_core = Decimal("0")
        counts = {key: 0 for key in sc.CELL_KEYS}
        snapshot = ProjectScoreSnapshot(
            id=snapshot_id,
            scope="project",
            project_id=project_id,
            project_name=project_name,
            version_code=version_code,
            scheme_id=scheme_id,
            scheme_code=scheme_code,
            scheme_business_ratio="8:2",
            scheme_problem_ratio="7:5:3:1",
            is_effective=is_effective,
            created_by_name="测试",
            snapshot_at=snapshot_at,
            created_at=snapshot_at,
            updated_at=snapshot_at,
        )
        db.add(snapshot)
        for index, (issue_id, business_level, severity) in enumerate(issues):
            key = sc.cell_key(business_level, severity)
            deduction = Decimal(str(cell_map[key]))
            counts[key] += 1
            if key.startswith("core_"):
                core += deduction
            else:
                non_core += deduction
            db.add(
                SnapshotIssue(
                    id=new_id(),
                    snapshot_id=snapshot_id,
                    issue_id=issue_id,
                    issue_code=f"ISS-{index:03d}",
                    business_level=business_level,
                    severity=severity,
                    cell_key=key,
                    deduction=str(deduction),
                    created_at=snapshot_at,
                    updated_at=snapshot_at,
                )
            )
        total = core + non_core
        snapshot.issue_count = len(issues)
        snapshot.core_issue_count = sum(v for k, v in counts.items() if k.startswith("core_"))
        snapshot.non_core_issue_count = sum(v for k, v in counts.items() if k.startswith("non_core_"))
        snapshot.severity_counts_json = json.dumps(counts, ensure_ascii=False)
        snapshot.core_deduction = sc.format_score(core)
        snapshot.non_core_deduction = sc.format_score(non_core)
        snapshot.total_deduction = sc.format_score(total)
        snapshot.raw_uei = sc.format_score(sc.BASE_SCORE - total)
        snapshot.display_uei = sc.format_score(sc.BASE_SCORE - total)
        db.commit()
        return snapshot_id


def create_system(client, *, code: str, name: str, scheme_id: str, division_id: str | None = None) -> dict:
    resp = client.post(
        "/api/v1/systems",
        json={"code": code, "name": name, "scheme_id": scheme_id, "division_id": division_id},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def attach_member(client, system_id: str, project_id: str, weight: str | None = None):
    body: dict = {"project_id": project_id}
    if weight is not None:
        body["weight"] = weight
    return client.post(f"/api/v1/systems/{system_id}/members", json=body)


# --------------------------------------------------------------------------- 成员（项目）


def test_member_attach_transfer_and_weight(session_factory, client) -> None:
    setup_primary(client)
    division_id = seed_division(session_factory, suffix="MEM")
    default_scheme = scheme_id_by_code(session_factory, sc.DEFAULT_SCHEME_CODE)
    system_a = create_system(client, code="MEM-A", name="系统A", scheme_id=default_scheme, division_id=division_id)
    system_b = create_system(client, code="MEM-B", name="系统B", scheme_id=default_scheme, division_id=division_id)

    # 项目创建：v1.1 要求 system_id + version_code（weight 可选）
    created = client.post(
        "/api/v1/projects",
        json={
            "name": "会议一体机体验项目",
            "system_id": system_a["id"],
            "project_type": "new_product",
            "version_code": "V1.0",
            "weight": "2",
        },
    )
    assert created.status_code == 201, created.text
    project = created.json()
    assert project["system_id"] == system_a["id"]
    assert project["version_code"] == "V1.0"
    assert project["weight"] == "2"
    project_id = project["id"]

    # 创建项目缺 system_id / version_code → 422
    assert client.post(
        "/api/v1/projects", json={"name": "缺系统", "project_type": "new_product", "version_code": "V1.0"}
    ).status_code == 422
    assert client.post(
        "/api/v1/projects", json={"name": "缺版本", "system_id": system_a["id"], "project_type": "new_product"}
    ).status_code == 422

    # 成员列表：项目在 A 下
    members_a = client.get(f"/api/v1/systems/{system_a['id']}/members").json()
    assert len(members_a) == 1
    assert members_a[0]["project_id"] == project_id
    assert members_a[0]["weight"] == "2"

    # 挂到 B → 视为转移：A 不再持有，B 接管（请求体不传 weight 时按 schema 默认重置为 "1"）
    moved = attach_member(client, system_b["id"], project_id)
    assert moved.status_code == 201, moved.text
    assert moved.json()["system_id"] == system_b["id"]
    assert moved.json()["weight"] == "1"
    assert client.get(f"/api/v1/systems/{system_a['id']}/members").json() == []
    assert len(client.get(f"/api/v1/systems/{system_b['id']}/members").json()) == 1

    # 重复挂同一系统 → 仍成功（v1.1 项目只属一个系统，无多对多成员关系，挂入幂等）
    assert attach_member(client, system_b["id"], project_id).status_code == 201

    # 权重调整
    weighted = client.post(f"/api/v1/systems/{system_b['id']}/members/{project_id}/weight", json={"weight": "3"})
    assert weighted.status_code == 200, weighted.text
    assert weighted.json()["weight"] == "3"

    # 非法权重 → 422；项目不属于该系统 → 409
    assert (
        client.post(
            f"/api/v1/systems/{system_b['id']}/members/{project_id}/weight", json={"weight": "0"}
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"/api/v1/systems/{system_b['id']}/members/{project_id}/weight", json={"weight": "abc"}
        ).status_code
        == 422
    )
    mismatch = client.post(f"/api/v1/systems/{system_a['id']}/members/{project_id}/weight", json={"weight": "5"})
    assert mismatch.status_code == 409
    assert mismatch.json()["code"] == "member_system_mismatch"

    # 挂入不存在项目 → 404
    assert attach_member(client, system_a["id"], "not-exist").status_code == 404


# --------------------------------------------------------------------------- 去重


def test_same_issue_id_deducted_once(session_factory, client) -> None:
    setup_primary(client)
    division_id = seed_division(session_factory, suffix="DUP")
    default_scheme_id = scheme_id_by_code(session_factory, sc.DEFAULT_SCHEME_CODE)
    system = create_system(client, code="DUP-SYS", name="去重系统", scheme_id=default_scheme_id, division_id=division_id)
    projects = [
        seed_project(session_factory, suffix=f"DUP{index}", system_id=system["id"], division_id=division_id)
        for index in range(2)
    ]

    shared = "issue-shared-0001"
    base = utcnow()
    insert_l1_snapshot(
        session_factory,
        project_id=projects[0]["id"],
        project_name=projects[0]["name"],
        scheme_id=default_scheme_id,
        scheme_code=sc.DEFAULT_SCHEME_CODE,
        issues=[(shared, "core", "normal"), ("issue-a-0002", "core", "normal")],
        snapshot_at=base,
    )
    insert_l1_snapshot(
        session_factory,
        project_id=projects[1]["id"],
        project_name=projects[1]["name"],
        scheme_id=default_scheme_id,
        scheme_code=sc.DEFAULT_SCHEME_CODE,
        issues=[(shared, "core", "normal"), ("issue-b-0003", "non_core", "normal")],
        snapshot_at=base + _dt.timedelta(seconds=5),
    )

    preview = client.get(f"/api/v1/systems/{system['id']}/analytics/preview").json()
    assert preview["raw_issue_count"] == 4
    assert preview["deduped_issue_count"] == 3
    assert preview["raw_issue_count"] > preview["deduped_issue_count"]
    assert len(preview["issues"]) == 3
    assert len({item["issue_id"] for item in preview["issues"]}) == 3
    # 去重后：2 × 核心一般(2.4) + 1 × 非核心一般(0.6) = 5.4 → UEI 94.6
    assert preview["total_deduction"] == "5.4"
    assert preview["authoritative_uei"] == "94.6"
    assert {item["project_id"] for item in preview["issues"]} == {p["id"] for p in projects}


# --------------------------------------------------------------------------- 只用系统方案


def test_only_system_scheme_is_used_and_outliers_flagged(session_factory, client) -> None:
    setup_primary(client)
    division_id = seed_division(session_factory, suffix="SCOPE")
    system_scheme_id = scheme_id_by_code(session_factory, sc.DEFAULT_SCHEME_CODE)
    other_scheme_id = scheme_id_by_code(session_factory, "6-4__6-3-2-1")
    system = create_system(client, code="SCOPE-SYS", name="口径系统", scheme_id=system_scheme_id, division_id=division_id)
    projects = [
        seed_project(session_factory, suffix=f"SCOPE{index}", system_id=system["id"], division_id=division_id)
        for index in range(2)
    ]

    base = utcnow()
    for index, project in enumerate(projects):
        insert_l1_snapshot(
            session_factory,
            project_id=project["id"],
            project_name=project["name"],
            scheme_id=other_scheme_id,
            scheme_code="6-4__6-3-2-1",
            issues=[
                (f"scope-{index}-1", "core", "normal"),
                (f"scope-{index}-2", "core", "normal"),
                (f"scope-{index}-3", "core", "normal"),
            ],
            snapshot_at=base + _dt.timedelta(seconds=index),
        )

    preview = client.get(f"/api/v1/systems/{system['id']}/analytics/preview").json()
    assert preview["outlier_project_count"] == 2
    assert len(preview["out_of_scope_projects"]) == 2
    assert all(item["is_out_of_scope"] is True for item in preview["sources"])
    # 系统方案 8:2/7:5:3:1 核心-一般 = 2.4；6 × 2.4 = 14.4 → UEI 85.6（而非 6-4 方案的 7.2 / 92.8）
    assert preview["total_deduction"] == "14.4"
    assert preview["authoritative_uei"] == "85.6"
    assert preview["scheme"]["code"] == sc.DEFAULT_SCHEME_CODE


def test_latest_effective_snapshot_is_default_source(session_factory, client) -> None:
    setup_primary(client)
    division_id = seed_division(session_factory, suffix="LATEST")
    default_scheme_id = scheme_id_by_code(session_factory, sc.DEFAULT_SCHEME_CODE)
    system = create_system(client, code="LATEST-SYS", name="最新系统", scheme_id=default_scheme_id, division_id=division_id)
    project = seed_project(session_factory, suffix="LATEST", system_id=system["id"], division_id=division_id)

    base = utcnow()
    insert_l1_snapshot(
        session_factory,
        project_id=project["id"],
        project_name=project["name"],
        scheme_id=default_scheme_id,
        scheme_code=sc.DEFAULT_SCHEME_CODE,
        issues=[("old-1", "core", "normal")],
        snapshot_at=base - _dt.timedelta(days=2),
        version_code="V1.0",
    )
    newest_id = insert_l1_snapshot(
        session_factory,
        project_id=project["id"],
        project_name=project["name"],
        scheme_id=default_scheme_id,
        scheme_code=sc.DEFAULT_SCHEME_CODE,
        issues=[("new-1", "core", "normal"), ("new-2", "core", "normal")],
        snapshot_at=base,
        version_code="V2.0",
    )

    preview = client.get(f"/api/v1/systems/{system['id']}/analytics/preview").json()
    assert preview["source_snapshot_count"] == 1
    assert preview["sources"][0]["l1_snapshot_id"] == newest_id
    assert preview["sources"][0]["project_id"] == project["id"]
    assert preview["deduped_issue_count"] == 2

    # 版本区间筛选：只取 V1. 前缀
    by_version = client.get(
        f"/api/v1/systems/{system['id']}/analytics/preview",
        params={"selection_mode": "version", "version_prefix": "V1."},
    ).json()
    assert by_version["deduped_issue_count"] == 1
    assert by_version["selection_mode"] == "version"


# --------------------------------------------------------------------------- 样本不足


def test_sample_insufficient_no_ranking(session_factory, client) -> None:
    setup_primary(client)
    default_scheme_id = scheme_id_by_code(session_factory, sc.DEFAULT_SCHEME_CODE)
    base = utcnow()

    # 情形 A：有效项目数 1 < 2
    division_a = seed_division(session_factory, suffix="SA")
    system_a = create_system(client, code="SA-SYS", name="单项目系统", scheme_id=default_scheme_id, division_id=division_a)
    project_a = seed_project(session_factory, suffix="SA", system_id=system_a["id"], division_id=division_a)
    insert_l1_snapshot(
        session_factory,
        project_id=project_a["id"],
        project_name=project_a["name"],
        scheme_id=default_scheme_id,
        scheme_code=sc.DEFAULT_SCHEME_CODE,
        issues=[(f"a-{i}", "core", "normal") for i in range(10)],
        snapshot_at=base,
    )
    preview_a = client.get(f"/api/v1/systems/{system_a['id']}/analytics/preview").json()
    assert preview_a["effective_project_count"] == 1
    assert preview_a["sample_sufficient"] is False
    assert preview_a["rankings"] == []
    assert "样本不足" in preview_a["sample_gap"]
    assert preview_a["authoritative_uei"] != ""

    # 情形 B：去重问题数 4 < 5
    division_b = seed_division(session_factory, suffix="SB")
    system_b = create_system(client, code="SB-SYS", name="少问题系统", scheme_id=default_scheme_id, division_id=division_b)
    projects_b = [
        seed_project(session_factory, suffix=f"SB{index}", system_id=system_b["id"], division_id=division_b)
        for index in range(2)
    ]
    for index, project in enumerate(projects_b):
        insert_l1_snapshot(
            session_factory,
            project_id=project["id"],
            project_name=project["name"],
            scheme_id=default_scheme_id,
            scheme_code=sc.DEFAULT_SCHEME_CODE,
            issues=[(f"b-{index}-1", "core", "normal"), (f"b-{index}-2", "core", "normal")],
            snapshot_at=base + _dt.timedelta(seconds=index),
        )
    preview_b = client.get(f"/api/v1/systems/{system_b['id']}/analytics/preview").json()
    assert preview_b["deduped_issue_count"] == 4
    assert preview_b["sample_sufficient"] is False
    assert preview_b["rankings"] == []
    assert "4 < 5" in preview_b["sample_gap"]

    # 情形 C：满足样本 → 排名产生
    division_c = seed_division(session_factory, suffix="SC")
    system_c = create_system(client, code="SC-SYS", name="足样本系统", scheme_id=default_scheme_id, division_id=division_c)
    projects_c = [
        seed_project(session_factory, suffix=f"SC{index}", system_id=system_c["id"], division_id=division_c)
        for index in range(2)
    ]
    for index, project in enumerate(projects_c):
        insert_l1_snapshot(
            session_factory,
            project_id=project["id"],
            project_name=project["name"],
            scheme_id=default_scheme_id,
            scheme_code=sc.DEFAULT_SCHEME_CODE,
            issues=[(f"c-{index}-{i}", "core", "normal") for i in range(3)],
            snapshot_at=base + _dt.timedelta(seconds=index),
        )
    preview_c = client.get(f"/api/v1/systems/{system_c['id']}/analytics/preview").json()
    assert preview_c["deduped_issue_count"] == 6
    assert preview_c["sample_sufficient"] is True
    assert len(preview_c["rankings"]) == 2
    assert preview_c["sample_gap"] == ""


# --------------------------------------------------------------------------- 三口径（含权重）


def test_auxiliary_scores_are_non_authoritative(session_factory, client) -> None:
    setup_primary(client)
    division_id = seed_division(session_factory, suffix="AUX")
    default_scheme_id = scheme_id_by_code(session_factory, sc.DEFAULT_SCHEME_CODE)
    system = create_system(client, code="AUX-SYS", name="辅助系统", scheme_id=default_scheme_id, division_id=division_id)
    # 项目 A 权重 1，项目 B 权重 5
    project_a = seed_project(session_factory, suffix="AUXA", system_id=system["id"], division_id=division_id, weight="1")
    project_b = seed_project(session_factory, suffix="AUXB", system_id=system["id"], division_id=division_id, weight="5")

    base = utcnow()
    # 项目 A：1 条核心致命 → 5.6 → UEI 94.4
    insert_l1_snapshot(
        session_factory,
        project_id=project_a["id"],
        project_name=project_a["name"],
        scheme_id=default_scheme_id,
        scheme_code=sc.DEFAULT_SCHEME_CODE,
        issues=[("aux-a-1", "core", "fatal")],
        snapshot_at=base,
    )
    # 项目 B：5 条核心致命 → 28.0 → UEI 72.0
    insert_l1_snapshot(
        session_factory,
        project_id=project_b["id"],
        project_name=project_b["name"],
        scheme_id=default_scheme_id,
        scheme_code=sc.DEFAULT_SCHEME_CODE,
        issues=[(f"aux-b-{i}", "core", "fatal") for i in range(5)],
        snapshot_at=base + _dt.timedelta(seconds=1),
    )

    preview = client.get(f"/api/v1/systems/{system['id']}/analytics/preview").json()
    # 权威口径：6 × 5.6 = 33.6 → 66.4
    assert preview["authoritative_uei"] == "66.4"
    assert preview["auxiliary"]["authoritative"] is False
    # 权重加权平均：(94.4×1 + 72.0×5) / 6 = 75.733… → 75.7
    assert preview["auxiliary"]["weighted_average_uei"] == "75.7"
    # 木桶分：min(94.4, 72.0) = 72.0
    assert preview["auxiliary"]["bucket_uei"] == "72.0"
    assert preview["auxiliary"]["weighted_average_uei"] != preview["authoritative_uei"]
    assert len(preview["rankings"]) == 2
    assert preview["rankings"][0]["project_name"] == project_b["name"]
    assert preview["rankings"][0]["deviation"] == "5.6"
    assert preview["top_exposure"]

    # 调整权重后加权口径随之变化：(94.4×3 + 72.0×5) / 8 = 80.4
    changed = client.post(
        f"/api/v1/systems/{system['id']}/members/{project_a['id']}/weight", json={"weight": "3"}
    )
    assert changed.status_code == 200, changed.text
    preview_after = client.get(f"/api/v1/systems/{system['id']}/analytics/preview").json()
    assert preview_after["auxiliary"]["weighted_average_uei"] == "80.4"
    # 权威口径不受权重影响
    assert preview_after["authoritative_uei"] == "66.4"


# --------------------------------------------------------------------------- 快照


def test_l2_snapshot_saves_filters_and_is_immutable(session_factory, client) -> None:
    setup_primary(client)
    division_id = seed_division(session_factory, suffix="L2S")
    default_scheme_id = scheme_id_by_code(session_factory, sc.DEFAULT_SCHEME_CODE)
    system = create_system(client, code="L2S-SYS", name="快照系统", scheme_id=default_scheme_id, division_id=division_id)
    projects = [
        seed_project(session_factory, suffix=f"L2S{index}", system_id=system["id"], division_id=division_id)
        for index in range(2)
    ]
    for index, project in enumerate(projects):
        insert_l1_snapshot(
            session_factory,
            project_id=project["id"],
            project_name=project["name"],
            scheme_id=default_scheme_id,
            scheme_code=sc.DEFAULT_SCHEME_CODE,
            issues=[(f"l2s-{index}-{i}", "core", "normal") for i in range(3)],
            snapshot_at=utcnow() + _dt.timedelta(seconds=index),
        )

    created = client.post(
        "/api/v1/system-snapshots",
        json={
            "system_id": system["id"],
            "selection_mode": "window",
            "from": "2000-01-01",
            "to": "2099-12-31",
            "note": "窗口快照",
        },
    )
    assert created.status_code == 201, created.text
    snapshot = created.json()
    assert snapshot["system_id"] == system["id"]
    assert snapshot["selection_mode"] == "window"
    assert snapshot["filters"]["selection_mode"] == "window"
    assert snapshot["filters"]["from"] == "2000-01-01"
    assert snapshot["filters"]["to"] == "2099-12-31"
    assert snapshot["deduped_issue_count"] == 6
    assert len(snapshot["sources"]) == 2
    assert {item["project_id"] for item in snapshot["sources"]} == {p["id"] for p in projects}
    assert len(snapshot["issues"]) == 6
    assert snapshot["auxiliary"]["authoritative"] is False
    assert snapshot["immutable"] is True

    # 筛选条件随快照落库（filters_json 可读回）
    with session_factory() as db:
        row = db.get(SystemSnapshot, snapshot["id"])
        filters = json.loads(row.filters_json)
    assert filters == {"selection_mode": "window", "from": "2000-01-01", "to": "2099-12-31"}

    detail = client.get(f"/api/v1/system-snapshots/{snapshot['id']}")
    assert detail.status_code == 200
    payload = detail.json()
    assert payload["filters"]["selection_mode"] == "window"
    assert payload["raw_issue_count"] == 6
    assert payload["deduped_issue_count"] == 6
    assert len({item["issue_id"] for item in payload["issues"]}) == len(payload["issues"])

    for method in ("patch", "put", "delete"):
        kwargs = {"json": {}} if method in {"patch", "put"} else {}
        res = getattr(client, method)(f"/api/v1/system-snapshots/{snapshot['id']}", **kwargs)
        assert res.status_code == 405, f"{method} 应返回 405"
        assert "不可修改" in res.json()["message"]

    # 分值库 L2 投影已写入（含 system_id 与来源类型）
    entries = client.get("/api/v1/score-library", params={"level": "L2"}).json()
    assert entries["total"] == 1
    assert entries["items"][0]["source_snapshot_id"] == snapshot["id"]
    assert entries["items"][0]["source_type"] == "system_snapshot"
    assert entries["items"][0]["system_id"] == system["id"]
    assert "UEI" in entries["items"][0]["caliber"]

    # 版本区间模式缺少 version_prefix → 422
    bad = client.post(
        "/api/v1/system-snapshots",
        json={"system_id": system["id"], "selection_mode": "version"},
    )
    assert bad.status_code == 422


def test_l2_snapshot_list_filters(session_factory, client) -> None:
    setup_primary(client)
    default_scheme_id = scheme_id_by_code(session_factory, sc.DEFAULT_SCHEME_CODE)
    system_a = create_system(client, code="LST-A", name="列表系统A", scheme_id=default_scheme_id)
    system_b = create_system(client, code="LST-B", name="列表系统B", scheme_id=default_scheme_id)
    for system in (system_a, system_b):
        created = client.post(
            "/api/v1/system-snapshots", json={"system_id": system["id"], "selection_mode": "latest"}
        )
        assert created.status_code == 201, created.text

    listed = client.get("/api/v1/system-snapshots").json()
    assert listed["total"] == 2
    only_a = client.get("/api/v1/system-snapshots", params={"system_id": system_a["id"]}).json()
    assert only_a["total"] == 1
    assert only_a["items"][0]["system_id"] == system_a["id"]


# --------------------------------------------------------------------------- 换方案 / 停用


def test_change_scheme_bumps_binding_version_and_keeps_history(session_factory, client) -> None:
    setup_primary(client)
    division_id = seed_division(session_factory, suffix="CHG")
    scheme_a = scheme_id_by_code(session_factory, sc.DEFAULT_SCHEME_CODE)
    scheme_b = scheme_id_by_code(session_factory, "6-4__6-3-2-1")
    system = create_system(client, code="CHG-SYS", name="换方案系统", scheme_id=scheme_a, division_id=division_id)
    assert system["scheme_version"] == 1
    project = seed_project(session_factory, suffix="CHG", system_id=system["id"], division_id=division_id)
    insert_l1_snapshot(
        session_factory,
        project_id=project["id"],
        project_name=project["name"],
        scheme_id=scheme_a,
        scheme_code=sc.DEFAULT_SCHEME_CODE,
        issues=[("chg-1", "core", "normal")],
        snapshot_at=utcnow(),
    )
    old_snapshot = client.post(
        "/api/v1/system-snapshots", json={"system_id": system["id"], "selection_mode": "latest"}
    ).json()
    assert old_snapshot["scheme_code"] == sc.DEFAULT_SCHEME_CODE

    changed = client.post(f"/api/v1/systems/{system['id']}/scheme", json={"scheme_id": scheme_b, "reason": "试算"})
    assert changed.status_code == 200, changed.text
    assert changed.json()["scheme_id"] == scheme_b
    assert changed.json()["scheme_version"] == 2

    # 历史 L2 快照不受影响
    after = client.get(f"/api/v1/system-snapshots/{old_snapshot['id']}").json()
    assert after["scheme_code"] == sc.DEFAULT_SCHEME_CODE
    assert after["authoritative_uei"] == old_snapshot["authoritative_uei"]

    # 新预览使用新方案
    preview = client.get(f"/api/v1/systems/{system['id']}/analytics/preview").json()
    assert preview["scheme"]["code"] == "6-4__6-3-2-1"

    assert client.post(f"/api/v1/systems/{system['id']}/scheme", json={"scheme_id": "not-exist"}).status_code == 404


def test_archive_system_blocks_active_projects_and_keeps_history(session_factory, client) -> None:
    setup_primary(client)
    division_id = seed_division(session_factory, suffix="ARC")
    default_scheme_id = scheme_id_by_code(session_factory, sc.DEFAULT_SCHEME_CODE)
    system = create_system(client, code="ARC-SYS", name="停用系统", scheme_id=default_scheme_id, division_id=division_id)
    project = seed_project(session_factory, suffix="ARC", system_id=system["id"], division_id=division_id)
    client.post("/api/v1/system-snapshots", json={"system_id": system["id"], "selection_mode": "latest"})

    # 仍有进行中项目 → 409
    blocked = client.post(f"/api/v1/systems/{system['id']}/archive", json={"reason": "下线"})
    assert blocked.status_code == 409, blocked.text
    assert blocked.json()["code"] == "system_has_active_projects"

    # 归档项目后可停用系统（历史与快照保留）
    archived_project = client.post(f"/api/v1/projects/{project['id']}/archive", json={"reason": "下线"})
    assert archived_project.status_code == 200, archived_project.text
    archived = client.post(f"/api/v1/systems/{system['id']}/archive", json={"reason": "下线"})
    assert archived.status_code == 200, archived.text
    assert archived.json()["status"] == "archived"

    detail = client.get(f"/api/v1/systems/{system['id']}").json()
    assert detail["status"] == "archived"
    assert len(detail["snapshot_history"]) == 1


# --------------------------------------------------------------------------- 方案解析


def test_resolve_scheme_prefers_system_binding_over_default(session_factory, client) -> None:
    setup_primary(client)
    division_id = seed_division(session_factory, suffix="RSLV")
    default_id = scheme_id_by_code(session_factory, sc.DEFAULT_SCHEME_CODE)
    other_id = scheme_id_by_code(session_factory, "6-4__6-3-2-1")
    system = create_system(client, code="RSLV-SYS", name="解析系统", scheme_id=other_id, division_id=division_id)
    project = seed_project(session_factory, suffix="RSLV", system_id=system["id"], division_id=division_id)

    # 1) 项目所属系统绑定方案优先于默认方案
    preview = client.get("/api/v1/scores/preview", params={"project_id": project["id"]}).json()
    assert preview["scheme_source"] == "system"
    assert preview["scheme"]["code"] == "6-4__6-3-2-1"
    assert preview["scheme_conflict"] is False

    # 2) 显式指定方案 → 优先级最高
    explicit = client.get(
        "/api/v1/scores/preview", params={"project_id": project["id"], "scheme_id": default_id}
    ).json()
    assert explicit["scheme_source"] == "explicit"
    assert explicit["scheme"]["code"] == sc.DEFAULT_SCHEME_CODE

    # 3) 系统停用（项目先归档）→ 退回默认方案
    assert client.post(f"/api/v1/projects/{project['id']}/archive").status_code == 200
    assert client.post(f"/api/v1/systems/{system['id']}/archive").status_code == 200
    fallback = client.get("/api/v1/scores/preview", params={"project_id": project["id"]}).json()
    assert fallback["scheme_source"] == "default"
    assert fallback["scheme"]["code"] == sc.DEFAULT_SCHEME_CODE


# --------------------------------------------------------------------------- 跨系统对比


def test_cross_system_comparison_requires_2_to_5_systems(session_factory, client) -> None:
    setup_primary(client)
    default_scheme_id = scheme_id_by_code(session_factory, sc.DEFAULT_SCHEME_CODE)
    systems = [
        create_system(client, code=f"CMP-{index}", name=f"对比系统{index}", scheme_id=default_scheme_id)
        for index in range(6)
    ]
    ids = [system["id"] for system in systems]

    assert client.post("/api/v1/system-comparisons", json={"system_ids": ids[:1]}).status_code == 422
    assert client.post("/api/v1/system-comparisons", json={"system_ids": ids}).status_code == 422
    assert client.post("/api/v1/system-comparisons", json={"system_ids": []}).status_code == 422
    ok = client.post("/api/v1/system-comparisons", json={"system_ids": ids[:3]})
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["system_count"] == 3
    assert len(body["columns"]) == 3
    assert "同一口径" in body["same_caliber_note"] or "同口径" in body["same_caliber_note"]
    # 三个系统都无来源快照 → 样本不足，均不进入排名并显式标注
    assert body["ranking"] == []
    assert len(body["excluded_from_ranking"]) == 3
    assert all(column["ranking_excluded"] is True for column in body["columns"])
    # 对比只允许存在的系统
    assert (
        client.post("/api/v1/system-comparisons", json={"system_ids": [ids[0], "not-exist"]}).status_code == 404
    )


def test_cross_system_comparison_ranks_sufficient_systems_only(session_factory, client) -> None:
    setup_primary(client)
    default_scheme_id = scheme_id_by_code(session_factory, sc.DEFAULT_SCHEME_CODE)
    base = utcnow()

    division_id = seed_division(session_factory, suffix="RCMP")
    rich = create_system(client, code="RCMP-RICH", name="足样系统", scheme_id=default_scheme_id, division_id=division_id)
    poor = create_system(client, code="RCMP-POOR", name="少样系统", scheme_id=default_scheme_id, division_id=division_id)
    rich_projects = [
        seed_project(session_factory, suffix=f"RCMPR{index}", system_id=rich["id"], division_id=division_id)
        for index in range(2)
    ]
    poor_project = seed_project(session_factory, suffix="RCMPP", system_id=poor["id"], division_id=division_id)

    for index, project in enumerate(rich_projects):
        insert_l1_snapshot(
            session_factory,
            project_id=project["id"],
            project_name=project["name"],
            scheme_id=default_scheme_id,
            scheme_code=sc.DEFAULT_SCHEME_CODE,
            issues=[(f"rich-{index}-{i}", "core", "normal") for i in range(3)],
            snapshot_at=base + _dt.timedelta(seconds=index),
        )
    insert_l1_snapshot(
        session_factory,
        project_id=poor_project["id"],
        project_name=poor_project["name"],
        scheme_id=default_scheme_id,
        scheme_code=sc.DEFAULT_SCHEME_CODE,
        issues=[("poor-1", "core", "normal")],
        snapshot_at=base,
    )

    resp = client.post("/api/v1/system-comparisons", json={"system_ids": [rich["id"], poor["id"]]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ranking"] == [rich["id"]]
    assert [item["system_id"] for item in body["excluded_from_ranking"]] == [poor["id"]]
    by_system = {column["system_id"]: column for column in body["columns"]}
    assert by_system[rich["id"]]["sample_sufficient"] is True
    assert by_system[poor["id"]]["sample_sufficient"] is False
    assert by_system[poor["id"]]["exclude_reason"]


# --------------------------------------------------------------------------- 鉴权 / 404 / 建约束


def test_system_endpoints_require_authentication(client) -> None:
    assert client.get("/api/v1/systems").status_code == 401
    assert client.post("/api/v1/systems", json={"code": "X", "name": "X", "scheme_id": "x"}).status_code == 401
    assert client.get("/api/v1/system-snapshots").status_code == 401
    assert client.post("/api/v1/system-comparisons", json={"system_ids": ["a", "b"]}).status_code == 401


def test_system_unknown_entities_return_404(session_factory, client) -> None:
    setup_primary(client)
    assert client.get("/api/v1/systems/not-exist").status_code == 404
    assert client.get("/api/v1/systems/not-exist/analytics/preview").status_code == 404
    assert client.get("/api/v1/system-snapshots/not-exist").status_code == 404


def test_create_system_requires_scheme_and_unique_code(session_factory, client) -> None:
    setup_primary(client)
    default_scheme_id = scheme_id_by_code(session_factory, sc.DEFAULT_SCHEME_CODE)
    create_system(client, code="UNIQ-1", name="唯一系统", scheme_id=default_scheme_id)
    duplicate = client.post(
        "/api/v1/systems", json={"code": "UNIQ-1", "name": "重复", "scheme_id": default_scheme_id}
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["code"] == "duplicate_code"

    bad_scheme = client.post(
        "/api/v1/systems", json={"code": "UNIQ-2", "name": "坏方案", "scheme_id": "not-exist"}
    )
    assert bad_scheme.status_code == 404

    keyword = client.get("/api/v1/systems", params={"keyword": "UNIQ-1"}).json()
    assert keyword["total"] == 1
    inactive = client.get("/api/v1/systems", params={"status": "archived"}).json()
    assert inactive["total"] == 0
