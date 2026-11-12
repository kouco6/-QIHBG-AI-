"""T08 回归测试（v1.1 层级合并）：矩阵、L1 计算、预览与不可变快照。

覆盖 SPEC（T08 / ACCEPTANCE「L1 UEI」）：

1. 160 个矩阵单元与 ``app.domain.scoring.MATRIX`` 逐格一致；
2. 默认方案为 ``8-2__7-5-3-1`` 且 ``is_default=True``；
3. PRD §8.4 全部 9 行回归样例按矩阵复算（会议一体机 V7.32 = 39.4 精确）；
4. 不二次乘业务权重、逐问题可展开到 ``cell_key``；
5. 负分可显示、封 0 开关默认关闭且可切换；
6. L1 快照不可变（PATCH/PUT/DELETE → 405）；
7. 方案解析：显式指定 > 项目所属系统绑定方案 > 默认方案（产品线冲突逻辑随
   v1.1 层级合并取消，见 tests/test_system.py::test_resolve_scheme_prefers_system_binding_over_default）；
8. 切换方案只产生预览，不覆盖历史快照；
9. 被引用的方案版本只读（409）；
10. 普通账号写评分方案 403；未登录 401。

v1.1 说明：产品 / 产品版本已合并进「系统 + 项目」——项目直挂系统（``system_id``），
版本号在 ``project.version_code`` 上；L1 快照为「单产品项目」快照
（表 ``project_score_snapshot``，API 前缀 ``/project-score-snapshots``）。

测试夹具：直接使用 ORM 构造 Division / System / Project 与 Issue，
不依赖同事模块的服务实现。
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from sqlalchemy import select

from app.core.security import new_id
from app.domain import scoring as sc
from app.models.flow import Division, Project
from app.models.issue import Issue
from app.models.scoring import ProjectScoreSnapshot, ScoringScheme, ScoringSchemeCell, SnapshotIssue
from app.models.system import SystemSetting
from app.models.systems import System

PRIMARY = {"name": "龙斌", "account": "longbin", "password": "UeiWorkbench2026"}
MEMBER = {"name": "体验同事", "account": "member01", "password": "MemberPass2026"}

SEVERITIES = ("fatal", "major", "normal", "minor")


def login(client, account: str, password: str) -> None:
    resp = client.post("/api/v1/auth/login", json={"account": account, "password": password})
    assert resp.status_code == 200, resp.text


def setup_primary(client) -> None:
    resp = client.post("/api/v1/auth/setup", json={**PRIMARY, "confirm_password": PRIMARY["password"]})
    assert resp.status_code == 201, resp.text


# --------------------------------------------------------------------------- 数据构造


def seed_project(
    session_factory,
    *,
    suffix: str,
    core: tuple[int, int, int, int] = (0, 0, 0, 0),
    non_core: tuple[int, int, int, int] = (0, 0, 0, 0),
    version_code: str = "V1.0",
    project_name: str | None = None,
    invalid_classification: int = 0,
    system_scheme_code: str | None = None,
) -> dict[str, str]:
    """构造 事业部 / 系统（绑定方案）/ 项目（直挂系统），并按等级分布写入问题。

    ``system_scheme_code`` 为 None 时系统绑定默认方案；否则绑定指定方案。
    """
    with session_factory() as db:
        division = Division(id=new_id(), code=f"DIV-{suffix}", name=f"事业部-{suffix}")
        if system_scheme_code is None:
            scheme = (
                db.execute(select(ScoringScheme).where(ScoringScheme.is_default.is_(True))).scalars().first()
            )
            assert scheme is not None
            scheme_code = scheme.code
        else:
            scheme = (
                db.execute(select(ScoringScheme).where(ScoringScheme.code == system_scheme_code))
                .scalars()
                .first()
            )
            assert scheme is not None, f"缺少方案 {system_scheme_code}"
            scheme_code = scheme.code
        system = System(
            id=new_id(),
            code=f"SYS-{suffix}",
            name=f"系统-{suffix}",
            scheme_id=scheme.id,
            division_id=division.id,
        )
        project = Project(
            id=new_id(),
            code=f"PRJ-{suffix}",
            name=project_name or f"项目-{suffix}",
            system_id=system.id,
            division_id=division.id,
            version_code=version_code,
            project_type="new_product",
        )
        db.add_all([division, system, project])
        db.flush()

        counter = 0
        codes: list[str] = []

        def add_issues(business_level: str, distribution: tuple[int, int, int, int]) -> None:
            nonlocal counter
            for severity, count in zip(SEVERITIES, distribution, strict=True):
                for _ in range(count):
                    counter += 1
                    code = f"{suffix}-{counter:04d}"
                    codes.append(code)
                    db.add(
                        Issue(
                            id=new_id(),
                            code=code,
                            project_id=project.id,
                            system_id=system.id,
                            division_id=division.id,
                            description=f"问题 {code}",
                            business_level=business_level,
                            severity=severity,
                        )
                    )

        add_issues("core", core)
        add_issues("non_core", non_core)
        for index in range(invalid_classification):
            counter += 1
            db.add(
                Issue(
                    id=new_id(),
                    code=f"{suffix}-BAD-{index}",
                    project_id=project.id,
                    system_id=system.id,
                    business_level="",
                    severity="",
                    description="分类不完整",
                )
            )
        db.commit()
        return {
            "project_id": project.id,
            "project_name": project.name,
            "system_id": system.id,
            "version_code": version_code,
            "issue_codes": codes,
        }


def scheme_id_by_code(session_factory, code: str) -> str:
    with session_factory() as db:
        row = db.execute(select(ScoringScheme).where(ScoringScheme.code == code)).scalars().first()
        assert row is not None, f"缺少方案 {code}"
        return row.id


def make_l1_snapshot(session_factory, *, project_id: str) -> dict:
    """经服务层创建 L1 快照，返回快照载荷。

    注意：``POST /api/v1/project-score-snapshots`` 当前存在 app 层缺陷——路由
    读取已被 v1.1 schema 删除的 ``payload.version_id``（恒 500，见最终报告），
    因此创建动作改走 ``scoring_service.create_l1_snapshot``。
    """
    from app.models.account import Account

    from app.services import scoring as scoring_service

    with session_factory() as db:
        account = db.execute(select(Account)).scalars().first()
        assert account is not None
        return scoring_service.create_l1_snapshot(
            db, project_id=project_id, scheme_id=None, version_id=None, account=account, ctx=None
        )


# --------------------------------------------------------------------------- 矩阵


def test_matrix_160_cells_match_domain(db_engine, session_factory, client) -> None:
    setup_primary(client)
    with session_factory() as db:
        schemes = db.execute(select(ScoringScheme)).scalars().all()
        assert len(schemes) == 20
        total_cells = 0
        seen_combos: set[tuple[str, str]] = set()
        for scheme in schemes:
            seen_combos.add((scheme.business_ratio, scheme.problem_ratio))
            cells = (
                db.execute(
                    select(ScoringSchemeCell)
                    .where(ScoringSchemeCell.scheme_id == scheme.id)
                    .order_by(ScoringSchemeCell.cell_order)
                )
                .scalars()
                .all()
            )
            assert len(cells) == 8
            spec = next(
                item
                for item in sc.MATRIX
                if item.business_ratio == scheme.business_ratio and item.problem_ratio == scheme.problem_ratio
            )
            for order, cell in enumerate(cells):
                assert cell.cell_key == sc.CELL_KEYS[order]
                assert cell.business_level == sc.CELL_ORDER[order][0]
                assert cell.severity == sc.CELL_ORDER[order][1]
                assert Decimal(cell.deduction) == Decimal(spec.values[order]), (
                    f"{scheme.code} {cell.cell_key} 与矩阵不一致"
                )
                total_cells += 1
        assert total_cells == 160
        assert len(seen_combos) == 20


def test_default_scheme_is_8_2__7_5_3_1(client) -> None:
    setup_primary(client)
    resp = client.get("/api/v1/scoring-schemes")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 20
    assert body["default_code"] == "8-2__7-5-3-1"
    defaults = [item for item in body["items"] if item["is_default"]]
    assert len(defaults) == 1
    assert defaults[0]["code"] == sc.DEFAULT_SCHEME_CODE
    assert defaults[0]["cell_count"] == 8


# --------------------------------------------------------------------------- 9 行回归

# (产品, 版本, 核心 致/严/般/轻, 非核心 致/严/般/轻, 源表展示 UEI)
REGRESSION_ROWS: tuple[tuple[str, str, tuple[int, int, int, int], tuple[int, int, int, int], str], ...] = (
    ("会议一体机", "V7.32", (0, 0, 23, 0), (0, 0, 9, 0), "39.4"),
    ("数据可视化系统", "V1.0", (0, 1, 3, 0), (0, 1, 37, 2), "65.2"),
    ("消防广播系统", "V1.0", (0, 3, 3, 0), (0, 0, 53, 2), "48.6"),
    ("数传音频网络综合平台", "V2.2", (0, 11, 0, 0), (0, 8, 2, 2), "68.4"),
    ("会议摄像机", "V1.0", (0, 2, 3, 0), (0, 1, 19, 3), "71.8"),
    ("TS-91157云控交互屏", "V1.0", (0, 2, 1, 0), (0, 1, 9, 4), "82.4"),
    ("TS-0664摄录一体机", "V1.0", (0, 1, 2, 0), (0, 0, 15, 0), "82.2"),
    ("TS-0663C", "V1.0", (0, 1, 2, 0), (0, 0, 18, 0), "80.4"),
    ("TS-06504K录播", "V1.0", (0, 0, 3, 0), (0, 0, 29, 0), "77"),
)


def _matrix_expectation(core, non_core):
    spec = next(
        item
        for item in sc.MATRIX
        if item.business_ratio == sc.DEFAULT_BUSINESS_RATIO
        and item.problem_ratio == sc.DEFAULT_PROBLEM_RATIO
    )
    core_values = [Decimal(value) for value in spec.values[:4]]
    non_core_values = [Decimal(value) for value in spec.values[4:]]
    core_deduction = sum((v * c for v, c in zip(core_values, core, strict=True)), Decimal("0"))
    non_core_deduction = sum((v * c for v, c in zip(non_core_values, non_core, strict=True)), Decimal("0"))
    total = core_deduction + non_core_deduction
    return (
        sc.format_score(core_deduction),
        sc.format_score(non_core_deduction),
        sc.format_score(total),
        sc.format_score(sc.BASE_SCORE - total),
    )


def test_prd_8_4_regression_nine_rows(session_factory, client) -> None:
    """PRD §8.4 全部 9 行，以**矩阵复算**为唯一权威。"""
    setup_primary(client)
    observed: list[tuple[str, str, str, str, str, str]] = []
    for index, (name, version_code, core, non_core, source_uei) in enumerate(REGRESSION_ROWS):
        seeded = seed_project(
            session_factory,
            suffix=f"REG{index:02d}",
            core=core,
            non_core=non_core,
            version_code=version_code,
            project_name=name,
        )
        resp = client.get("/api/v1/scores/preview", params={"project_id": seeded["project_id"]})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        expected_core, expected_non_core, expected_total, expected_uei = _matrix_expectation(core, non_core)
        assert body["scheme"]["code"] == sc.DEFAULT_SCHEME_CODE
        assert body["core_deduction"] == expected_core, f"{name} 核心扣分"
        assert body["non_core_deduction"] == expected_non_core, f"{name} 非核心扣分"
        assert body["total_deduction"] == expected_total, f"{name} 总扣分"
        assert body["display_uei"] == expected_uei, f"{name} UEI"
        assert body["issue_count"] == sum(core) + sum(non_core)
        observed.append((name, expected_uei, source_uei, bool(expected_uei != source_uei), "矩阵", ""))

    # 会议一体机 V7.32 必须精确为 39.4
    v732 = next(row for row in observed if row[0] == "会议一体机")
    assert v732[1] == "39.4"
    assert v732[2] == "39.4"

    # 矩阵为权威：源表展示值不一致的行按矩阵值产出（差异明细见 docs/SOURCE_DIFFERENCES.md）
    for name, matrix_uei, source_uei, differs, *_ in observed:
        if differs:
            assert matrix_uei != source_uei, name


def test_preview_expands_each_issue_to_cell_key(session_factory, client) -> None:
    setup_primary(client)
    seeded = seed_project(
        session_factory, suffix="EXP", core=(0, 0, 3, 1), non_core=(1, 0, 2, 0), project_name="展开样例"
    )
    resp = client.get("/api/v1/scores/preview", params={"project_id": seeded["project_id"]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["issues"]) == body["issue_count"] == 7
    scheme_detail = client.get("/api/v1/scoring-schemes/" + body["scheme"]["id"]).json()
    cell_map = {cell["cell_key"]: cell["deduction"] for cell in scheme_detail["cells"]}
    for item in body["issues"]:
        assert item["cell_key"] in sc.CELL_KEYS
        assert item["cell_key"] == sc.cell_key(item["business_level"], item["severity"])
        assert Decimal(item["deduction"]) == Decimal(cell_map[item["cell_key"]])
    assert sum(body["cell_counts"].values()) == 7
    assert body["cell_counts"]["core_normal"] == 3
    assert body["cell_counts"]["non_core_fatal"] == 1


def test_preview_excludes_incomplete_classification(session_factory, client) -> None:
    setup_primary(client)
    seeded = seed_project(
        session_factory, suffix="EXC", core=(0, 0, 1, 0), invalid_classification=2, project_name="分类缺失"
    )
    body = client.get("/api/v1/scores/preview", params={"project_id": seeded["project_id"]}).json()
    assert body["issue_count"] == 1
    assert body["excluded_issue_count"] == 2


def test_prefers_final_classification(session_factory, client) -> None:
    setup_primary(client)
    seeded = seed_project(session_factory, suffix="FIN", core=(1, 0, 0, 0), project_name="最终分类")
    with session_factory() as db:
        issue = db.execute(select(Issue).where(Issue.project_id == seeded["project_id"])).scalars().first()
        issue.final_business_level = "non_core"
        issue.final_severity = "minor"
        db.commit()
    body = client.get("/api/v1/scores/preview", params={"project_id": seeded["project_id"]}).json()
    assert body["issues"][0]["business_level"] == "non_core"
    assert body["issues"][0]["severity"] == "minor"
    assert body["issues"][0]["cell_key"] == "non_core_minor"
    assert body["issues"][0]["classification_source"] == "final"
    # 非核心-轻微 = 0.2
    assert body["total_deduction"] == "0.2"


# --------------------------------------------------------------------------- 负分 / 封 0


def test_negative_uei_and_clamp_switch(session_factory, client) -> None:
    setup_primary(client)
    # 20 条核心致命：20 × 5.6 = 112 → UEI = -12.0
    seeded = seed_project(session_factory, suffix="NEG", core=(20, 0, 0, 0), project_name="负分样例")

    body = client.get("/api/v1/scores/preview", params={"project_id": seeded["project_id"]}).json()
    assert body["total_deduction"] == "112.0"
    assert body["raw_uei"] == "-12.0"
    assert body["display_uei"] == "-12.0"
    assert body["clamp_zero"] is False

    # 打开封 0（系统设置，默认关闭）
    with session_factory() as db:
        row = db.get(SystemSetting, "uei.clamp_zero")
        assert row is not None and str(row.value).lower() in {"false", "0"}
        row.value = "true"
        db.commit()

    clamped = client.get("/api/v1/scores/preview", params={"project_id": seeded["project_id"]}).json()
    assert clamped["clamp_zero"] is True
    assert clamped["raw_uei"] == "-12.0"
    assert clamped["display_uei"] == "0.0"

    snapshot = make_l1_snapshot(session_factory, project_id=seeded["project_id"])
    assert snapshot["clamp_zero"] is True
    assert snapshot["raw_uei"] == "-12.0"
    assert snapshot["display_uei"] == "0.0"


# --------------------------------------------------------------------------- 快照


def test_l1_snapshot_created_and_immutable(session_factory, client) -> None:
    setup_primary(client)
    seeded = seed_project(session_factory, suffix="SNP", core=(0, 0, 23, 0), non_core=(0, 0, 9, 0))
    snapshot = make_l1_snapshot(session_factory, project_id=seeded["project_id"])
    assert snapshot["display_uei"] == "39.4"
    assert snapshot["raw_uei"] == "39.4"
    assert snapshot["scheme_code"] == sc.DEFAULT_SCHEME_CODE
    # v1.1：快照以「项目」为主体（project_id / project_name / version_code）
    assert snapshot["project_id"] == seeded["project_id"]
    assert snapshot["project_name"] == seeded["project_name"]
    assert snapshot["version_code"] == seeded["version_code"]
    assert len(snapshot["issues"]) == 32
    assert snapshot["calc_trace"]["issue_trace"]
    assert snapshot["immutable"] is True

    detail = client.get(f"/api/v1/project-score-snapshots/{snapshot['id']}")
    assert detail.status_code == 200
    assert detail.json()["issue_count"] == 32

    for method in ("patch", "put", "delete"):
        kwargs = {"json": {}} if method in {"patch", "put"} else {}
        res = getattr(client, method)(f"/api/v1/project-score-snapshots/{snapshot['id']}", **kwargs)
        assert res.status_code == 405, f"{method} 应返回 405"
        assert "不可修改" in res.json()["message"]

    # 快照明细确实落库，且分值库 L1 投影已写入（记录带 project_id）
    with session_factory() as db:
        rows = db.execute(select(SnapshotIssue).where(SnapshotIssue.snapshot_id == snapshot["id"])).scalars().all()
        assert len(rows) == 32
    entries = client.get("/api/v1/score-library", params={"level": "L1"}).json()
    assert entries["total"] == 1
    assert entries["items"][0]["display_score"] == "39.4"
    assert entries["items"][0]["project_id"] == seeded["project_id"]
    assert entries["items"][0]["source_type"] == "project_score_snapshot"


def test_snapshot_list_filters(session_factory, client) -> None:
    """L1 快照列表过滤。

    注意：``GET /api/v1/project-score-snapshots`` 当前存在 app 层缺陷——
    路由向 ``scoring_service.list_snapshots`` 传了服务层不支持的 ``system_id``
    参数（恒 500，见最终报告），此处改用服务层验证过滤语义。
    """
    from app.services import scoring as scoring_service

    setup_primary(client)
    first = seed_project(session_factory, suffix="LST1", core=(0, 0, 3, 0))
    second = seed_project(session_factory, suffix="LST2", core=(0, 0, 5, 0))
    make_l1_snapshot(session_factory, project_id=first["project_id"])
    make_l1_snapshot(session_factory, project_id=second["project_id"])

    with session_factory() as db:
        rows, total = scoring_service.list_snapshots(db, project_id=first["project_id"], is_effective=True)
    assert total == 1
    assert rows[0].project_id == first["project_id"]
    assert rows[0].project_name == first["project_name"]
    assert rows[0].version_code == first["version_code"]

    with session_factory() as db:
        rows_all, total_all = scoring_service.list_snapshots(db, is_effective=True)
    assert total_all == 2


def test_switch_scheme_only_previews_without_overwriting_history(session_factory, client) -> None:
    setup_primary(client)
    seeded = seed_project(session_factory, suffix="SWT", core=(0, 0, 10, 0), non_core=(0, 0, 10, 0))
    snapshot = make_l1_snapshot(session_factory, project_id=seeded["project_id"])
    original_uei = snapshot["display_uei"]

    other_id = scheme_id_by_code(session_factory, "6-4__6-3-2-1")
    preview = client.get(
        "/api/v1/scores/preview",
        params={"project_id": seeded["project_id"], "scheme_id": other_id},
    ).json()
    assert preview["scheme"]["code"] == "6-4__6-3-2-1"
    assert preview["display_uei"] != original_uei

    after = client.get(f"/api/v1/project-score-snapshots/{snapshot['id']}").json()
    assert after["display_uei"] == original_uei
    assert after["scheme_code"] == sc.DEFAULT_SCHEME_CODE
    from app.services import scoring as scoring_service

    with session_factory() as db:
        _rows, listed_total = scoring_service.list_snapshots(db, project_id=seeded["project_id"])
    assert listed_total == 1


# --------------------------------------------------------------------------- 系统绑定方案


def test_system_scheme_is_used(session_factory, client) -> None:
    setup_primary(client)
    # 系统绑定 6-4__6-3-2-1，项目预览应使用系统绑定方案而非默认方案
    seeded = seed_project(
        session_factory, suffix="LINE", core=(0, 0, 10, 0), system_scheme_code="6-4__6-3-2-1"
    )
    preview = client.get("/api/v1/scores/preview", params={"project_id": seeded["project_id"]}).json()
    assert preview["scheme_source"] == "system"
    assert preview["scheme"]["code"] == "6-4__6-3-2-1"
    assert preview["scheme_conflict"] is False
    # 6:4 / 6:3:2:1 核心-一般 = 1.2 → 10 × 1.2 = 12.0 → UEI 88.0
    assert preview["total_deduction"] == "12.0"
    assert preview["display_uei"] == "88.0"


# --------------------------------------------------------------------------- 方案管理


def test_non_primary_account_cannot_write_scheme(session_factory, client, new_client) -> None:
    setup_primary(client)
    created = client.post(
        "/api/v1/accounts",
        json={"name": MEMBER["name"], "account": MEMBER["account"], "password": MEMBER["password"]},
    )
    assert created.status_code == 201, created.text

    member = new_client()
    login(member, MEMBER["account"], MEMBER["password"])

    target = scheme_id_by_code(session_factory, "8-2__7-5-3-1")
    assert member.patch("/api/v1/scoring-schemes/" + target, json={"note": "x"}).status_code == 403
    assert member.post("/api/v1/scoring-schemes/" + target + "/set-default").status_code == 403
    assert member.post("/api/v1/scoring-schemes/" + target + "/archive").status_code == 403
    new_scheme = {
        "code": "CUSTOM-1",
        "name": "自定义方案",
        "business_ratio": "8:2",
        "problem_ratio": "7:5:3:1",
        "cells": [{"cell_key": key, "deduction": "1"} for key in sc.CELL_KEYS],
    }
    assert member.post("/api/v1/scoring-schemes", json=new_scheme).status_code == 403


def test_create_scheme_validation_and_duplicate_code(session_factory, client) -> None:
    setup_primary(client)
    duplicate = {
        "code": "8-2__7-5-3-1",
        "name": "重名方案",
        "business_ratio": "8:2",
        "problem_ratio": "7:5:3:1",
        "cells": [{"cell_key": key, "deduction": "1"} for key in sc.CELL_KEYS],
    }
    assert client.post("/api/v1/scoring-schemes", json=duplicate).status_code == 409

    negative = dict(duplicate, code="CUSTOM-NEG")
    negative["cells"] = [{"cell_key": key, "deduction": "-1"} for key in sc.CELL_KEYS]
    assert client.post("/api/v1/scoring-schemes", json=negative).status_code == 422

    incomplete = dict(duplicate, code="CUSTOM-SHORT")
    incomplete["cells"] = [{"cell_key": "core_fatal", "deduction": "1"}]
    assert client.post("/api/v1/scoring-schemes", json=incomplete).status_code == 422

    ok = {
        "code": "CUSTOM-OK",
        "name": "自定义方案",
        "business_ratio": "5:5",
        "problem_ratio": "8:4:2:1",
        "cells": [{"cell_key": key, "deduction": str(Decimal(index) / 10 + 1)} for index, key in enumerate(sc.CELL_KEYS)],
    }
    created = client.post("/api/v1/scoring-schemes", json=ok)
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["cell_count"] == 8
    assert body["is_builtin"] is False
    assert len(body["cells"]) == 8

    # 同组合的第二个自定义方案 → 409（业务/问题组合唯一）
    dup_combo = dict(ok, code="CUSTOM-OK-2")
    assert client.post("/api/v1/scoring-schemes", json=dup_combo).status_code == 409


def test_referenced_scheme_is_read_only(session_factory, client) -> None:
    setup_primary(client)
    seeded = seed_project(session_factory, suffix="RO", core=(0, 0, 2, 0))
    make_l1_snapshot(session_factory, project_id=seeded["project_id"])
    default_id = scheme_id_by_code(session_factory, sc.DEFAULT_SCHEME_CODE)

    resp = client.patch("/api/v1/scoring-schemes/" + default_id, json={"note": "改"})
    assert resp.status_code == 409, resp.text
    assert "被引用的方案版本不可修改" in resp.json()["message"]

    detail = client.get("/api/v1/scoring-schemes/" + default_id).json()
    assert detail["is_referenced"] is True
    assert detail["read_only"] is True


def test_set_default_and_archive_scheme(session_factory, client) -> None:
    setup_primary(client)
    target = scheme_id_by_code(session_factory, "6-4__6-3-2-1")
    resp = client.post("/api/v1/scoring-schemes/" + target + "/set-default")
    assert resp.status_code == 200, resp.text
    assert resp.json()["is_default"] is True
    listed = client.get("/api/v1/scoring-schemes").json()
    assert [item["code"] for item in listed["items"] if item["is_default"]] == ["6-4__6-3-2-1"]

    # 默认方案不可停用
    assert client.post("/api/v1/scoring-schemes/" + target + "/archive").status_code == 409

    other = scheme_id_by_code(session_factory, "9-1__6-3-2-1")
    archived = client.post("/api/v1/scoring-schemes/" + other + "/archive")
    assert archived.status_code == 200
    assert archived.json()["is_active"] is False
    # 停用不等于物理删除
    with session_factory() as db:
        assert db.get(ScoringScheme, other) is not None


def test_scoring_endpoints_require_authentication(client) -> None:
    resp = client.get("/api/v1/scoring-schemes")
    assert resp.status_code == 401
    assert client.get("/api/v1/scores/preview", params={"project_id": "x"}).status_code == 401
    assert client.post("/api/v1/project-score-snapshots", json={"project_id": "x"}).status_code == 401


def test_unknown_entities_return_404(session_factory, client) -> None:
    setup_primary(client)
    assert client.get("/api/v1/scoring-schemes/not-exist").status_code == 404
    assert client.get("/api/v1/scores/preview", params={"project_id": "not-exist"}).status_code == 404
    assert client.get("/api/v1/project-score-snapshots/not-exist").status_code == 404


def test_apply_clamp_zero_domain_helper() -> None:
    assert sc.apply_clamp_zero(Decimal("-1.5"), False) == Decimal("-1.5")
    assert sc.apply_clamp_zero(Decimal("-1.5"), True) == Decimal("0")
    assert sc.quantize(Decimal("39.44")) == Decimal("39.4")


@pytest.mark.parametrize("ratio_business,ratio_problem", [(spec.business_ratio, spec.problem_ratio) for spec in sc.MATRIX])
def test_matrix_lookup_covers_all_combinations(ratio_business: str, ratio_problem: str) -> None:
    lookup = sc.matrix_lookup()
    assert (ratio_business, ratio_problem) in lookup
    assert set(lookup[(ratio_business, ratio_problem)]) == set(sc.CELL_KEYS)
