"""T11（L3 事业部 BEI）验收测试。

覆盖 ACCEPTANCE.md「L3 事业部 BEI」全部验收项与任务描述的 13 个验收点。

夹具约定（见 conftest.py）：
- ``db_engine`` 每个测试新建内存库并 ``seed_all``（含 BEI 阈值 v1 版本，active）。
- 直接用 ORM 构造 Division / System / Project / Issue / ProjectScoreSnapshot 等，
  不依赖其他同事模块的服务。
"""

from __future__ import annotations

import datetime as _dt
import json
from decimal import Decimal

import pytest
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.security import new_id
from app.core.timeutil import utcnow
from app.domain import bei as bd
from app.domain import states as st
from app.models.bei import BeiMetricValue, BeiThresholdVersion
from app.models.flow import (
    DIVISION_ACTIVE,
    PROJECT_ACTIVE,
    Division,
    Project,
)
from app.models.issue import Issue
from app.models.scoring import ProjectScoreSnapshot, SNAPSHOT_SCOPE_PROJECT
from app.models.systems import SYSTEM_ACTIVE, System
from app.services import bei as bei_service


PERIOD = "2026Q4"


# --------------------------------------------------------------------------- ORM 构造助手
def _now() -> _dt.datetime:
    return utcnow()


def make_division(db: Session, code: str, name: str) -> Division:
    division = Division(id=new_id(), code=code, name=name, owner_text="测试负责人", status=DIVISION_ACTIVE)
    db.add(division)
    return division


def make_system(db: Session, division: Division, code: str, name: str) -> System:
    system = System(
        id=new_id(),
        code=code,
        name=name,
        division_id=division.id,
        scheme_id="scheme-default",
        status=SYSTEM_ACTIVE,
    )
    db.add(system)
    return system


def make_project(db: Session, division: Division, system: System, code: str) -> Project:
    project = Project(
        id=new_id(),
        code=code,
        name=f"{system.name} 体验项目",
        system_id=system.id,
        version_code="V1.0",
        division_id=division.id,
        project_type="new_product",
        owner_text="测试负责人",
        status=PROJECT_ACTIVE,
    )
    db.add(project)
    return project


def add_issue(db: Session, *, division, project, idx: int, replied: bool = True) -> Issue:
    now = _now()
    issue = Issue(
        id=new_id(),
        code=f"ISS-TEST-{idx:04d}",
        project_id=project.id,
        system_id=project.system_id,
        division_id=division.id,
        module=f"模块{idx % 5}",
        description=f"体验问题 {idx}",
        business_level="core",
        severity="normal",
        metric_l1="易学性",
        metric_l2="交互体验",
        metric_l3="normal",
        issue_type="体验问题",
        owner_text="体验团队",
        status=st.ISSUE_CLOSED,
        division_reply="事业部已确认修复" if replied else "",
        solution="优化交互流程" if replied else "",
        committed_version=project.version_code,
        actual_version=project.version_code,
        first_replied_at=now if replied else None,
        closed_at=now,
        source_refs_json="[]",
        is_proxy=False,
    )
    issue.created_at = now
    issue.updated_at = now
    db.add(issue)
    return issue


def add_snapshots(db: Session, *, division, project, prev_uei: str, latest_uei: str) -> None:
    """两个相邻 L1 快照（用于精确控制 D5：uei_gain 与 critical_major_drop_rate）。"""
    now = _now()
    sev = json.dumps({"fatal": 0, "major": 0, "normal": 10, "minor": 0})
    for offset_days, uei in ((-2, prev_uei), (0, latest_uei)):
        snap = ProjectScoreSnapshot(
            id=new_id(),
            scope=SNAPSHOT_SCOPE_PROJECT,
            project_id=project.id,
            project_name=project.name,
            version_code=project.version_code,
            division_id=division.id,
            scheme_id="scheme-x",
            scheme_code="x",
            issue_count=10,
            severity_counts_json=sev,
            raw_uei=uei,
            display_uei=uei,
            is_effective=True,
            created_by_name="测试",
            snapshot_at=now + _dt.timedelta(days=offset_days),
        )
        db.add(snap)


def build_full_division(
    db: Session,
    *,
    code: str = "DIV-TEST",
    name: str = "测试事业部",
    n_issues: int = 8,
    with_snapshots: bool = True,
    replied: bool = True,
) -> Division:
    """构造一个「样本充足 + 有在研项目」且（可选）含 D5 快照的完整事业部。"""
    division = make_division(db, code, name)
    system = make_system(db, division, "SYS-TEST", "测试系统")
    project = make_project(db, division, system, "P-TEST")
    for i in range(n_issues):
        add_issue(db, division=division, project=project, idx=i, replied=replied)
    if with_snapshots:
        # prev=0, latest=10 → uei_gain=10（归一化 100）；致命+严重占比降幅=0（归一化 60）
        add_snapshots(db, division=division, project=project, prev_uei="0", latest_uei="10")
    db.commit()
    return division


# --------------------------------------------------------------------------- 工具
def _close(a: Decimal, b: Decimal, tol: Decimal = Decimal("0.0001")) -> bool:
    return abs(a - b) <= tol


# ===========================================================================
# 验收点 1：五维权重 20/25/20/20/15；维度内算术平均
# ===========================================================================
def test_weights_and_dimension_arithmetic_mean(session_factory):
    db = session_factory()
    division = build_full_division(db, with_snapshots=True)
    result = bei_service.evaluate_division(db, division=division, period=PERIOD)

    # 全部维度有数据 → 重标权重 == 冻结权重
    expected_weights = {d.code: Decimal(d.weight) for d in bd.DIMENSIONS}
    assert result.rescaled_weights == expected_weights
    assert sum(result.rescaled_weights.values(), Decimal("0")) == Decimal("1.00")
    assert [d.code for d in bd.DIMENSIONS] == ["D1", "D2", "D3", "D4", "D5"]

    # D5 精确：uei_gain 归一化 100 + critical_major_drop_rate 归一化 60 → 80.00
    assert result.dim_scores["D5"] == Decimal("80.00")

    # 维度内 = 有数据二级指标归一化的算术平均（结构校验）
    for dim in bd.DIMENSIONS:
        code = dim.code
        if code in result.dim_scores:
            vals = [
                r.normalized
                for r in result.rows
                if r.dimension == code and r.is_scoring and r.normalized is not None
            ]
            expected_mean = sum(vals, Decimal("0")) / Decimal(len(vals))
            assert _close(result.dim_scores[code], expected_mean), code

    # 自动分 = Σ(维度分 × 重标权重)
    auto_expected = sum(
        (result.dim_scores[c] * result.rescaled_weights[c] for c in result.active_dimensions), Decimal("0")
    )
    assert _close(result.auto_score, auto_expected)
    db.close()


# ===========================================================================
# 验收点 2：全无数据维度被剔除，剩余维度权重等比放大
# ===========================================================================
def test_missing_dimension_rescaled_weights(session_factory):
    db = session_factory()
    division = build_full_division(db, with_snapshots=False)  # 无快照 → D5 无数据
    result = bei_service.evaluate_division(db, division=division, period=PERIOD)

    assert "D5" not in result.active_dimensions
    assert set(result.active_dimensions) == {"D1", "D2", "D3", "D4"}
    assert sum(result.rescaled_weights.values(), Decimal("0")) == Decimal("1.00")
    # D2 重标后 = 0.25 / (0.20+0.25+0.20+0.20)
    assert _close(result.rescaled_weights["D2"], Decimal("0.25") / Decimal("0.85"))
    # 自动分使用重标权重
    auto_expected = sum(
        (result.dim_scores[c] * result.rescaled_weights[c] for c in result.active_dimensions), Decimal("0")
    )
    assert _close(result.auto_score, auto_expected)
    db.close()


# ===========================================================================
# 验收点 7：档位边界（用 BEI 实际使用的评级函数）
# ===========================================================================
@pytest.mark.parametrize(
    "score,expected",
    [
        (Decimal("85"), bd.GRADE_EXCELLENT),
        (Decimal("84.9"), bd.GRADE_GOOD),
        (Decimal("70"), bd.GRADE_GOOD),
        (Decimal("69.9"), bd.GRADE_FAIR),
        (Decimal("55"), bd.GRADE_FAIR),
        (Decimal("54.9"), bd.GRADE_POOR),
    ],
)
def test_grade_boundaries(score, expected):
    assert bd.grade_of(score) == expected


def test_grade_boundaries_in_payload(client, setup_primary, session_factory):
    db = session_factory()
    division = build_full_division(db)
    db.close()
    # 实时预估 → 档位应与 grade_of(auto_score) 一致
    resp = client.post(
        "/api/v1/divisions/bei/preview",
        json={"division_id": division.id, "period": PERIOD},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["grade"] == bd.grade_of(Decimal(str(body["auto_score"]))) if body["auto_score"] else True
    assert body["grade_label"] in bd.GRADE_LABELS.values()


# ===========================================================================
# 验收点 11：阈值版本可溯源（source_ref 含 §8.8.6）并显示「经验阈值 · 待校准」
# ===========================================================================
def test_threshold_version_traceable(client, setup_primary):
    resp = client.get("/api/v1/bei-threshold-versions")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["source_ref"].count("8.8.6") >= 1
    assert body["status_label"] == "经验阈值 · 待校准"
    assert len(body["items"]) >= 1
    item = body["items"][0]
    assert item["status_label"] == "经验阈值 · 待校准"
    # 详情同样可溯源
    detail = client.get(f"/api/v1/bei-threshold-versions/{item['id']}")
    assert detail.status_code == 200, detail.text
    assert "8.8.6" in detail.json()["source_ref"]


def test_threshold_version_detail_not_found(client, setup_primary):
    resp = client.get("/api/v1/bei-threshold-versions/does-not-exist")
    assert resp.status_code == 404


# ===========================================================================
# 验收点 10：阈值缺失 → blocked（409）带解除条件；采集 / 下钻仍可用
# ===========================================================================
def test_threshold_missing_blocks_ranking_and_keeps_collection(client, setup_primary, session_factory):
    db = session_factory()
    build_full_division(db)
    db.execute(delete(BeiThresholdVersion))
    db.commit()
    db.close()

    # 榜单（得分路径）→ 409 blocked
    resp = client.get(f"/api/v1/bei?period={PERIOD}")
    assert resp.status_code == 409, resp.text
    assert resp.json()["code"] == "blocked"
    assert "unblock_condition" in resp.json()

    # 下钻 / 采集仍可用（preview 返回 200 且包含原始取数与下钻）
    prev = client.post(
        "/api/v1/divisions/bei/preview",
        json={"division_id": _first_division_id(session_factory), "period": PERIOD},
    )
    assert prev.status_code == 200, prev.text
    pbody = prev.json()
    assert pbody["blocked"] is not None
    assert pbody["has_score"] is False
    # 原始取数 + 下钻仍在
    assert len(pbody["metrics"]) == len(bd.METRICS)
    assert any(m["raw_value"] is not None for m in pbody["metrics"])


def _first_division_id(session_factory) -> str:
    db = session_factory()
    did = db.execute(select(Division.id)).scalars().first()
    db.close()
    return did


# ===========================================================================
# 验收点 5：参评问题 < 5 → insufficient_sample，不给分不排名
# ===========================================================================
def test_insufficient_sample(client, setup_primary, session_factory):
    db = session_factory()
    division = build_full_division(db, n_issues=3)  # < 5
    db.close()
    resp = client.post(
        "/api/v1/divisions/bei/preview",
        json={"division_id": division.id, "period": PERIOD},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "insufficient_sample"
    assert body["has_score"] is False
    assert body["combined_score"] is None
    # 榜单中单列 insufficient_sample 组，不参与排名
    ranking = client.get(f"/api/v1/bei?period={PERIOD}")
    assert ranking.status_code == 200, ranking.text
    r = ranking.json()
    found = None
    for grp in ("ranked", "insufficient_sample", "no_participating_data"):
        for row in r["groups"][grp]:
            if row["division_id"] == division.id:
                found = (grp, row)
    assert found is not None and found[0] == "insufficient_sample"
    assert found[1]["combined_score"] is None


# ===========================================================================
# 验收点 6：无在研产品 → no_participating_data，不是 0 分
# ===========================================================================
def test_no_participating_data(client, setup_primary, session_factory):
    db = session_factory()
    division = make_division(db, "DIV-NOPROD", "无产品事业部")  # 无产品 / 无项目 / 无问题
    db.commit()
    db.close()
    resp = client.post(
        "/api/v1/divisions/bei/preview",
        json={"division_id": division.id, "period": PERIOD},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "no_participating_data"
    assert body["combined_score"] is None  # 不是 "0"
    assert body["has_score"] is False


# ===========================================================================
# 验收点 9：每指标可下钻到原始问题（drill_json 含 issue_code）
# ===========================================================================
def test_drill_down_to_raw_issue(client, setup_primary, session_factory):
    db = session_factory()
    division = build_full_division(db, n_issues=6)
    db.close()
    resp = client.get(f"/api/v1/divisions/{division.id}/bei/{PERIOD}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    drill_metrics = [m for m in body["metrics"] if m["drill_count"] > 0]
    assert len(drill_metrics) >= 1
    sample = drill_metrics[0]
    assert sample["drill"][0]["issue_code"]
    # response_rate 必有下钻
    rr = next(m for m in body["metrics"] if m["metric_key"] == "response_rate")
    assert rr["drill_count"] >= 1 and rr["drill"][0]["issue_code"]


# ===========================================================================
# 验收点 3 & 4：人工分分栏 + 必填项 + 不修改自动指标
# ===========================================================================
def test_manual_score_split_and_validation(client, setup_primary, session_factory):
    db = session_factory()
    division = build_full_division(db)
    db.close()
    preview = client.post(
        "/api/v1/divisions/bei/preview",
        json={"division_id": division.id, "period": PERIOD},
    )
    evaluation_id = preview.json()["evaluation_id"]
    auto_before = preview.json()["auto_score"]

    # 缺 reason → 422
    r1 = client.post(
        f"/api/v1/divisions/bei/{evaluation_id}/manual-score",
        json={"score": 90, "basis": "依据"},
    )
    assert r1.status_code == 422
    # 缺 basis → 422
    r2 = client.post(
        f"/api/v1/divisions/bei/{evaluation_id}/manual-score",
        json={"score": 90, "reason": "事由"},
    )
    assert r2.status_code == 422
    # weight > 0.20 → 422
    r3 = client.post(
        f"/api/v1/divisions/bei/{evaluation_id}/manual-score",
        json={"score": 90, "reason": "事由", "basis": "依据", "weight": 0.25},
    )
    assert r3.status_code == 422

    # 合法：weight=0.20
    ok = client.post(
        f"/api/v1/divisions/bei/{evaluation_id}/manual-score",
        json={"score": 90, "reason": "季度体验印象加分", "basis": "评审纪要", "weight": 0.20},
    )
    assert ok.status_code == 200, ok.text
    b = ok.json()
    assert b["manual_score"] == "90"                 # 人工分（BeiManualScore.score 为字符串列）
    assert b["auto_score"] == auto_before           # 自动分独立、未变
    assert b["auto_weight"] == "0.80"                # 自动占比 ≥ 80%
    assert b["manual_weight"] == "0.20"              # 人工 ≤ 20%
    assert b["combined_score"] is not None


def test_manual_score_does_not_modify_metric_values(client, setup_primary, session_factory):
    db = session_factory()
    division = build_full_division(db)
    # 记录下钻前的 BeiMetricValue 原始值
    db.close()
    preview = client.post(
        "/api/v1/divisions/bei/preview",
        json={"division_id": division.id, "period": PERIOD},
    )
    evaluation_id = preview.json()["evaluation_id"]
    db = session_factory()
    before = {
        mv.metric_key: mv.raw_value
        for mv in db.execute(select(BeiMetricValue).where(BeiMetricValue.evaluation_id == evaluation_id)).scalars().all()
    }
    db.close()

    client.post(
        f"/api/v1/divisions/bei/{evaluation_id}/manual-score",
        json={"score": 80, "reason": "印象分", "basis": "依据", "weight": 0.20},
    )
    db = session_factory()
    after = {
        mv.metric_key: mv.raw_value
        for mv in db.execute(select(BeiMetricValue).where(BeiMetricValue.evaluation_id == evaluation_id)).scalars().all()
    }
    db.close()
    assert before == after  # 人工分只写 BeiManualScore，不改动 BeiMetricValue


# ===========================================================================
# 验收点 8（前半）：季度内为 estimate 且标注未定榜
# ===========================================================================
def test_estimate_flag(client, setup_primary, session_factory):
    db = session_factory()
    division = build_full_division(db)
    db.close()

    preview = client.post(
        "/api/v1/divisions/bei/preview",
        json={"division_id": division.id, "period": PERIOD},
    )
    assert preview.status_code == 200, preview.text
    pb = preview.json()
    assert pb["estimate"] is True
    assert pb["finalized"] is False
    assert pb["status"] == "estimate"


# ===========================================================================
# 验收点 8（后半：定榜后不可变 / 再定榜 409）& 验收点 13（分值库 L3）
#
# 说明：定榜提交路径曾因 services/bei.finalize_division 访问 DivisionEvaluation.manual_score
# （模型上并无该属性，人工分只存于 BeiManualScore）而必崩。该缺陷已修复（改用 getattr 兜底），
# 本用例恢复正常断言：定榜成功 → 再次定榜 409 snapshot_immutable → 分值库出现 L3 记录。
def test_finalize_immutable_and_score_library_l3(client, setup_primary, session_factory):
    db = session_factory()
    division = build_full_division(db)
    db.close()

    preview = client.post(
        "/api/v1/divisions/bei/preview",
        json={"division_id": division.id, "period": PERIOD},
    )
    evaluation_id = preview.json()["evaluation_id"]

    # 定榜（首账号）
    fin = client.post(
        "/api/v1/bei/quarterly-snapshots/finalize",
        json={"division_id": division.id, "period": PERIOD},
    )
    assert fin.status_code == 200, fin.text
    fb = fin.json()
    assert fb["finalized"] is True
    assert fb["finalized_by_name"]
    assert fb["evaluation_id"] == evaluation_id

    # 再定榜 → 409
    again = client.post(
        "/api/v1/bei/quarterly-snapshots/finalize",
        json={"division_id": division.id, "period": PERIOD},
    )
    assert again.status_code == 409, again.text

    # 定榜后写入分值库 level=L3 且可回溯 source_snapshot_id
    lib = client.get(f"/api/v1/score-library?level=L3&object_id={division.id}")
    assert lib.status_code == 200, lib.text
    matched = [it for it in lib.json()["items"] if it["source_snapshot_id"] == evaluation_id]
    assert len(matched) == 1 and matched[0]["level"] == "L3"


# ===========================================================================
# 验收点 12（部分）：备注不影响得分；普通账号建阈值版本 / 定榜 → 403；未登录 → 401
# ===========================================================================
def test_note_does_not_affect_score(client, setup_primary, session_factory):
    db = session_factory()
    division = build_full_division(db)
    db.close()
    preview = client.post(
        "/api/v1/divisions/bei/preview",
        json={"division_id": division.id, "period": PERIOD},
    )
    evaluation_id = preview.json()["evaluation_id"]
    auto_before = preview.json()["auto_score"]
    combined_before = preview.json()["combined_score"]

    note = client.post(
        f"/api/v1/divisions/bei/{evaluation_id}/note",
        json={"content": "本季度体验重视度较高，值得肯定。"},
    )
    assert note.status_code == 200, note.text
    nb = note.json()
    assert nb["auto_score"] == auto_before
    assert nb["combined_score"] == combined_before
    assert len(nb["notes"]) >= 1
    assert nb["notes"][0]["content"]
    assert nb["notes"][0]["entered_by"]


def test_unauthenticated_401(client):
    # client 未登录
    assert client.get(f"/api/v1/bei?period={PERIOD}").status_code == 401
    assert client.post(
        "/api/v1/divisions/bei/preview", json={"division_id": "x", "period": PERIOD}
    ).status_code == 401
    # 定榜端点同样需登录
    assert client.post(
        "/api/v1/bei/quarterly-snapshots/finalize", json={"division_id": "x", "period": PERIOD}
    ).status_code == 401


def test_member_cannot_write_settings(client, new_client, member_account):
    # member_account 夹具已通过 primary 的 client 建好普通账号
    member = new_client()
    from tests.conftest import login, MEMBER

    login(member, MEMBER["account"], MEMBER["password"])
    # 普通账号建阈值版本 → 403
    r1 = member.post(
        "/api/v1/bei-threshold-versions",
        json={"version_label": "v2-member"},
    )
    assert r1.status_code == 403
    # 普通账号定榜 → 403（需要一个事业部 / 周期，但权限先拦截）
    r2 = member.post(
        "/api/v1/bei/quarterly-snapshots/finalize",
        json={"division_id": "x", "period": PERIOD},
    )
    assert r2.status_code == 403


def test_primary_can_create_threshold_version(client, setup_primary, session_factory):
    resp = client.post(
        "/api/v1/bei-threshold-versions",
        json={"version_label": "v2-primary", "source_ref": "自测来源 §8.8.6", "source_note": "测试"},
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["version_label"] == "v2-primary"
    # 重复标签 → 409
    dup = client.post(
        "/api/v1/bei-threshold-versions",
        json={"version_label": "v2-primary"},
    )
    assert dup.status_code == 409


# ===========================================================================
# 实体不存在 → 404
# ===========================================================================
def test_division_detail_not_found(client, setup_primary):
    resp = client.get(f"/api/v1/divisions/does-not-exist/bei/{PERIOD}")
    assert resp.status_code == 404
