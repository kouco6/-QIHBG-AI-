"""T06 验收：源字典导入与管理。

覆盖 ACCEPTANCE「字典」组：

- 源工作簿只读处理并记录来源哈希；
- 软件三级指标 33 个、检查项编号 1–114 连续完整；
- 每个检查项保留说明、来源标准、问题示例与示例图片元数据；
- 硬件三级指标 15 个；硬件单品 56 × 4 = 224 数据行，等级扣分 5/3/2/1；
- 交互组件 46、细则 136（源表 182 行 = 46 条组件定义行 + 136 条细则，见 D-01）；
- 被引用条目不能物理删除，只能停用。

两条路径都覆盖：
1. **合成工作簿 + 直接 ORM 造数**（不依赖 G 盘，任何环境可跑）；
2. **真实源集成**（G 盘可读则断言真实计数，不可读则 ``skip`` 并记录，绝不伪造）。
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy.orm import Session, sessionmaker

from app.core.security import new_id
from app.models.dictionary import (
    BATCH_IMPORTED,
    DICT_CONTROL_HARDWARE,
    DICT_CONTROL_SOFTWARE,
    DICT_HARDWARE,
    DICT_HARDWARE_PRODUCT,
    DICT_SOFTWARE,
    CheckItem,
    DictionaryBatch,
    DictionaryNode,
)
from app.services import dictionary as service
from tests.conftest import MEMBER, PRIMARY, login

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "import_uei_workbook.py"
G_SOURCE = Path(
    "G:/常规文件/文件终版/12.管理/8、【其他】/【管理】产品企划部工作标准文档/"
    "【标准】UEI流程方案-20240820-V4.0.xlsx"
)
# 期望计数（源表权威口径）
EXPECTED_SOFTWARE = {"l1": 1, "l2": 4, "l3": 33, "check_items": 114}
EXPECTED_CONTROL_SOFTWARE = {"components": 46, "details": 136, "source_rows": 182}


def _load_script():
    """按路径加载仓库根导入脚本（仓库根不在 sys.path 上）。"""
    spec = importlib.util.spec_from_file_location("import_uei_workbook_t06", SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SCRIPT = _load_script()


def _source_available() -> bool:
    return G_SOURCE.exists()


# --------------------------------------------------------------------------- 合成工作簿


def _build_synthetic_workbook(path: Path) -> None:
    """构造与源表结构同形的小规模工作簿（仅用于解析/计数逻辑验证）。"""
    book = Workbook()

    # 体验指标（软件）：1 / 2 / 2 / 4 检查项
    ws = book.active
    ws.title = "体验指标（软件）"
    ws.append(["用户体验指标（软件）"])
    ws.append(["一级指标", "二级指标", "三级指标", None, "指标说明", "来源", "问题示例", "示例图片"])
    ws.append(["软件", "功能设计", "功能完备性", 1, "提供一组相应功能", "GB/T 25000.23", "缺少导出功能", None])
    ws.append([None, None, None, 2, "覆盖程度足够", None, "覆盖不足", None])
    ws.append([None, "视觉界面", "文案一致性", 3, "用词一致", "GB/T 18978.10", "提示语不统一", None])
    ws.append([None, None, None, 4, "语态一致", None, "语态混用", None])

    # 体验指标（硬件）：1 / 2 / 2、说明行 3
    ws = book.create_sheet("体验指标（硬件）")
    ws.append(["用户体验指标（硬件）"])
    ws.append(["一级指标", "二级指标", "三级指标", "指标说明", "来源", "问题示例", "示例图片"])
    ws.append(["硬件", "外观结构", "尺寸合理性", "尺寸合理", "/", "尺寸过大", None])
    ws.append([None, None, None, "可平稳放置", "/", "平放倾斜", None])
    ws.append([None, "防呆设计", "丝印可读性", "丝印清晰", "/", "丝印模糊", None])

    # 硬件单品体验维度：1 / 1 / 1 / 4 行
    ws = book.create_sheet("硬件单品体验维度")
    ws.append(["用户体验指标（硬件单品）"])
    ws.append(["一级指标", "二级指标", "三级指标/指标说明", "问题等级", "问题等级说明", "扣分值"])
    for grade, deduct, text in (
        ("致命", "5", "按键间距严重不合理"),
        ("严重", "3", "按键间距过小"),
        ("一般", "2", "按键间距略紧凑"),
        ("轻微", "1", "按键间距略有不足"),
    ):
        ws.append(["外观结构", "按键", "物理按钮间距合理", grade, text, deduct])

    # 交互控件表（软件）：1 组件 / 2 细则
    ws = book.create_sheet("交互控件表")
    ws.append(["交互控件表"])
    ws.append(["组件", "详情", "等级"])
    ws.append(["一、搜索框", "有输入状态", None])
    ws.append([None, "可以模糊搜索", None])

    # 交互控件表-硬件：1 组件 / 2 细则
    ws = book.create_sheet("交互控件表-硬件")
    ws.append(["交互控件表-硬件"])
    ws.append(["组件", "详情", "等级"])
    ws.append(["机械按键", "键程适中", None])
    ws.append([None, "反馈力度良好", None])

    book.save(path)


@pytest.fixture()
def synthetic_workbook() -> Iterator[Path]:
    """在临时目录生成合成工作簿；显式清理，避免依赖 tmp_path 批量清理。"""
    directory = tempfile.mkdtemp(prefix="t06_dict_")
    path = Path(directory) / "synthetic_uei.xlsx"
    _build_synthetic_workbook(path)
    try:
        yield path
    finally:
        shutil.rmtree(directory, ignore_errors=True)


# --------------------------------------------------------------------------- ORM 造数


def _insert_node(
    db: Session,
    *,
    dict_type: str,
    code: str,
    name: str,
    level: int,
    parent_id: str | None = None,
    order_no: int = 1,
    batch_id: str | None = None,
    reference_count: int = 0,
) -> DictionaryNode:
    node = DictionaryNode(
        id=new_id(),
        dict_type=dict_type,
        batch_id=batch_id,
        parent_id=parent_id,
        level=level,
        path=f"/{code}" if parent_id is None else f"/{code}",
        code=code,
        name=name,
        order_no=order_no,
        is_active=True,
        reference_count=reference_count,
    )
    db.add(node)
    db.flush()
    return node


def _insert_item(
    db: Session,
    *,
    dict_type: str,
    node_id: str,
    item_no: int,
    name: str,
    description: str = "",
    source_standard: str = "",
    example: str = "",
    batch_id: str | None = None,
    severity: str = "",
    deduction: str = "",
    reference_count: int = 0,
) -> CheckItem:
    item = CheckItem(
        id=new_id(),
        dict_type=dict_type,
        node_id=node_id,
        batch_id=batch_id,
        item_no=item_no,
        name=name,
        description=description,
        source_standard=source_standard,
        example=example,
        image_meta_json="[]",
        severity=severity,
        deduction=deduction,
        is_active=True,
        reference_count=reference_count,
    )
    db.add(item)
    db.flush()
    return item


def _seed_dictionary(session_factory: sessionmaker[Session]) -> dict[str, str]:
    """造一棵小规模软件字典 + 一条批次记录；返回关键 ID。"""
    with session_factory() as db:
        batch = DictionaryBatch(
            id=new_id(),
            source_path=str(G_SOURCE),
            source_sha256="3ac4727b218ed86ee212021039508f1a98cd45978fa8f4593ffb4b96b0624e26",
            source_size_bytes=241492,
            status=BATCH_IMPORTED,
            dry_run=False,
            counts_json=json.dumps({"software": EXPECTED_SOFTWARE}, ensure_ascii=False),
            expected_json=json.dumps({"software": EXPECTED_SOFTWARE}, ensure_ascii=False),
            diff_json=json.dumps({"ok": True, "items": {}}, ensure_ascii=False),
            notes="测试批次",
            created_by_name=PRIMARY["name"],
        )
        db.add(batch)
        db.flush()

        l1 = _insert_node(db, dict_type=DICT_SOFTWARE, code="SW-L1", name="软件", level=1, batch_id=batch.id)
        l2a = _insert_node(
            db, dict_type=DICT_SOFTWARE, code="SW-L2-01", name="功能设计", level=2,
            parent_id=l1.id, order_no=1, batch_id=batch.id,
        )
        l2b = _insert_node(
            db, dict_type=DICT_SOFTWARE, code="SW-L2-02", name="视觉界面", level=2,
            parent_id=l1.id, order_no=2, batch_id=batch.id,
        )
        l3a = _insert_node(
            db, dict_type=DICT_SOFTWARE, code="SW-L3-001", name="功能完备性", level=3,
            parent_id=l2a.id, order_no=1, batch_id=batch.id,
        )
        l3b = _insert_node(
            db, dict_type=DICT_SOFTWARE, code="SW-L3-002", name="文案一致性", level=3,
            parent_id=l2b.id, order_no=2, batch_id=batch.id,
        )
        ref_item = _insert_item(
            db, dict_type=DICT_SOFTWARE, node_id=l3a.id, item_no=1, name="功能完备性",
            description="提供一组相应功能", source_standard="GB/T 25000.23", example="缺少导出功能",
            batch_id=batch.id,
        )
        _insert_item(
            db, dict_type=DICT_SOFTWARE, node_id=l3a.id, item_no=2, name="功能完备性",
            description="覆盖程度足够", source_standard="", example="覆盖不足", batch_id=batch.id,
        )
        _insert_item(
            db, dict_type=DICT_SOFTWARE, node_id=l3b.id, item_no=3, name="文案一致性",
            description="用词一致", source_standard="GB/T 18978.10", example="提示语不统一",
            batch_id=batch.id,
        )
        # 硬件单品：1 维度 × 4 等级
        hp1 = _insert_node(
            db, dict_type=DICT_HARDWARE_PRODUCT, code="HP-L1-1", name="外观结构", level=1, batch_id=batch.id
        )
        hp2 = _insert_node(
            db, dict_type=DICT_HARDWARE_PRODUCT, code="HP-L2-01", name="按键", level=2,
            parent_id=hp1.id, batch_id=batch.id,
        )
        hp3 = _insert_node(
            db, dict_type=DICT_HARDWARE_PRODUCT, code="HP-L3-001", name="物理按钮间距合理", level=3,
            parent_id=hp2.id, batch_id=batch.id,
        )
        for grade, deduct in (("致命", "5"), ("严重", "3"), ("一般", "2"), ("轻微", "1")):
            _insert_item(
                db, dict_type=DICT_HARDWARE_PRODUCT, node_id=hp3.id,
                item_no=("致命", "严重", "一般", "轻微").index(grade) + 1,
                name=grade, description=f"{grade}等级说明", severity=grade, deduction=deduct,
                batch_id=batch.id,
            )
        db.commit()
        return {
            "batch_id": batch.id,
            "l1_id": l1.id,
            "l2a_id": l2a.id,
            "l3a_id": l3a.id,
            "ref_item_id": ref_item.id,
            "hp_l3_id": hp3.id,
        }


@pytest.fixture()
def seeded(session_factory: sessionmaker[Session]) -> dict[str, str]:
    return _seed_dictionary(session_factory)


# --------------------------------------------------------------------------- 纯函数


def test_item_sequence_accepts_continuous_1_to_n() -> None:
    result = service.validate_item_sequence(list(range(1, 115)))
    assert result["ok"] is True
    assert result["continuous"] is True
    assert result["count"] == 114
    assert result["item_min"] == 1 and result["item_max"] == 114
    assert result["missing"] == [] and result["duplicates"] == []


def test_item_sequence_rejects_missing_number() -> None:
    numbers = [n for n in range(1, 115) if n != 57]
    result = service.validate_item_sequence(numbers)
    assert result["ok"] is False
    assert result["missing"] == [57]
    assert result["continuous"] is False


def test_item_sequence_rejects_duplicate_number() -> None:
    numbers = list(range(1, 115))
    numbers.append(88)
    result = service.validate_item_sequence(numbers)
    assert result["ok"] is False
    assert result["duplicates"] == [88]
    assert result["continuous"] is False


def test_expected_counts_follow_manifest_and_prd() -> None:
    expected = service.expected_counts()
    assert expected[DICT_SOFTWARE]["l3"] == 33
    assert expected[DICT_SOFTWARE]["check_items"] == 114
    assert expected[DICT_SOFTWARE]["continuous"] is True
    assert expected[DICT_HARDWARE]["l3"] == 15
    assert expected[DICT_HARDWARE_PRODUCT] == {"l1": 4, "l2": 41, "l3": 56, "data_rows": 224}
    assert expected[DICT_CONTROL_SOFTWARE]["components"] == 46
    assert expected[DICT_CONTROL_SOFTWARE]["details"] == 136
    assert expected[DICT_CONTROL_SOFTWARE]["source_rows"] == 182
    assert expected[DICT_CONTROL_HARDWARE] == {"components": 5, "details": 50}


def test_diff_counts_flags_mismatch() -> None:
    expected = service.expected_counts()
    counts = {k: dict(v) for k, v in expected.items()}
    counts[DICT_SOFTWARE]["check_items"] = 113
    diff = service.diff_counts(counts, expected)
    assert diff["ok"] is False
    assert diff["items"]["software.check_items"] == {"expected": 114, "actual": 113, "ok": False}


# --------------------------------------------------------------------------- 合成工作簿解析


def test_parse_synthetic_workbook_structure(synthetic_workbook: Path) -> None:
    parsed = service.parse_workbook(synthetic_workbook)
    counts = parsed.counts

    assert counts[DICT_SOFTWARE]["l1"] == 1
    assert counts[DICT_SOFTWARE]["l2"] == 2
    assert counts[DICT_SOFTWARE]["l3"] == 2
    assert counts[DICT_SOFTWARE]["check_items"] == 4
    assert counts[DICT_SOFTWARE]["item_min"] == 1 and counts[DICT_SOFTWARE]["item_max"] == 4
    assert counts[DICT_SOFTWARE]["continuous"] is True

    assert counts[DICT_HARDWARE] == {"l1": 1, "l2": 2, "l3": 2, "check_items": 3}
    assert counts[DICT_HARDWARE_PRODUCT] == {"l1": 1, "l2": 1, "l3": 1, "data_rows": 4}
    assert counts[DICT_CONTROL_SOFTWARE] == {
        "components": 1,
        "details": 1,
        "source_rows": 2,
        "component_definition_rows": 1,
    }
    assert counts[DICT_CONTROL_HARDWARE] == {
        "components": 1,
        "details": 2,
        "source_rows": 2,
        "component_definition_rows": 0,
    }

    software_items = [i for i in parsed.items if i.dict_type == DICT_SOFTWARE]
    assert [i.item_no for i in software_items] == [1, 2, 3, 4]
    # 检查项保留说明 / 来源标准 / 问题示例 / 示例图片元数据字段
    first = software_items[0]
    assert first.description == "提供一组相应功能"
    assert first.source_standard == "GB/T 25000.23"
    assert first.example == "缺少导出功能"
    assert first.image_meta == []

    grades = [i for i in parsed.items if i.dict_type == DICT_HARDWARE_PRODUCT]
    assert [(g.severity, g.deduction) for g in grades] == [
        ("致命", "5"), ("严重", "3"), ("一般", "2"), ("轻微", "1")
    ]

    control_items = [i for i in parsed.items if i.dict_type == DICT_CONTROL_SOFTWARE]
    assert control_items[0].raw["is_component_definition"] is True
    assert control_items[1].raw["is_component_definition"] is False


def test_precheck_fails_on_count_mismatch(session_factory: sessionmaker[Session], synthetic_workbook: Path) -> None:
    """合成工作簿计数必然与 33/114/… 不一致 → 预检 status=failed 且拒绝落库。"""
    from app.core.errors import ConflictError

    with session_factory() as db:
        with pytest.raises(ConflictError):
            service.run_precheck(db, source_path=synthetic_workbook, actor_name="test")
        batch = db.query(DictionaryBatch).order_by(DictionaryBatch.created_at.desc()).first()
        assert batch is not None
        assert batch.status == "failed"
        assert json.loads(batch.diff_json)["ok"] is False
        # 未写入任何字典数据
        assert db.query(DictionaryNode).count() == 0
        assert db.query(CheckItem).count() == 0


def test_import_refuses_when_counts_mismatch(session_factory: sessionmaker[Session], synthetic_workbook: Path) -> None:
    from app.core.errors import ConflictError

    with session_factory() as db:
        with pytest.raises(ConflictError):
            service.run_import(db, source_path=synthetic_workbook, actor_name="test")
        assert db.query(DictionaryNode).count() == 0


def test_precheck_blocked_when_source_unreadable(session_factory: sessionmaker[Session]) -> None:
    """源不可读 → 批次 blocked，blocked_reason 写明解除条件，不写任何伪造数据。"""
    from app.core.errors import BlockedError

    bogus = Path(tempfile.gettempdir()) / "t06_no_such_workbook.xlsx"
    with session_factory() as db:
        with pytest.raises(BlockedError):
            service.run_precheck(db, source_path=bogus, actor_name="test")
        batch = db.query(DictionaryBatch).order_by(DictionaryBatch.created_at.desc()).first()
        assert batch is not None
        assert batch.status == "blocked"
        assert "源工作簿不可读" in batch.blocked_reason
        assert "解除条件" in batch.blocked_reason
        assert db.query(DictionaryNode).count() == 0
        assert db.query(CheckItem).count() == 0


def test_parse_workbook_blocked_when_file_present_but_corrupt(
    session_factory: sessionmaker[Session],
) -> None:
    """文件存在但解析失败（monkeypatch 模拟不可读）→ 同样进入 blocked 分支。"""
    from app.core.errors import BlockedError

    def _boom(_path: object) -> None:
        raise BlockedError(service.BLOCKED_REASON_UNREADABLE, code="source_unreadable")

    # 指向一个真实存在的文件（清单），但让解析抛错以模拟损坏/不可读
    with session_factory() as db:
        original = service.parse_workbook
        service.parse_workbook = _boom  # type: ignore[assignment]
        try:
            with pytest.raises(BlockedError):
                service.run_precheck(db, source_path=service.MANIFEST_PATH, actor_name="test")
        finally:
            service.parse_workbook = original  # type: ignore[assignment]
        batch = db.query(DictionaryBatch).order_by(DictionaryBatch.created_at.desc()).first()
        assert batch is not None and batch.status == "blocked"


# --------------------------------------------------------------------------- 导入脚本


def test_script_returns_blocked_exit_code_for_unreadable_source() -> None:
    code = SCRIPT.main(
        ["--apply", "--source", "E:/no/such/uei.xlsx", "--db-url", "sqlite://", "--json"]
    )
    assert code == SCRIPT.EXIT_BLOCKED == 2


def test_script_returns_failed_exit_code_on_count_mismatch(synthetic_workbook: Path) -> None:
    code = SCRIPT.main(["--dry-run", "--source", str(synthetic_workbook), "--db-url", "sqlite://", "--json"])
    assert code == SCRIPT.EXIT_FAILED == 1


@pytest.mark.skipif(not _source_available(), reason="源工作簿不可读")
def test_script_dry_run_real_source() -> None:
    code, result = SCRIPT.run(
        db_url="sqlite://", source=str(G_SOURCE), apply=False, actor="test"
    )
    assert code == SCRIPT.EXIT_OK
    assert result["status"] == "pending"
    assert result["diff"]["ok"] is True
    assert result["counts"][DICT_SOFTWARE]["l3"] == EXPECTED_SOFTWARE["l3"]
    assert result["counts"][DICT_SOFTWARE]["check_items"] == EXPECTED_SOFTWARE["check_items"]
    assert result["source_sha256"] == "3ac4727b218ed86ee212021039508f1a98cd45978fa8f4593ffb4b96b0624e26"


# --------------------------------------------------------------------------- API：权限


def test_unauthenticated_dictionary_reads_return_401(client: TestClient, setup_primary: dict) -> None:
    client.cookies.clear()
    for path in (
        "/api/v1/dictionaries/software/tree",
        "/api/v1/dictionaries/software/items",
        "/api/v1/dictionaries/software/summary",
        "/api/v1/dictionaries/batches",
    ):
        resp = client.get(path)
        assert resp.status_code == 401, f"{path} -> {resp.status_code}"
        assert resp.json()["code"] == "unauthorized"


def test_member_cannot_write_dictionary(
    client: TestClient, setup_primary: dict, member_account: dict, seeded: dict, new_client
) -> None:
    """ACCEPTANCE：普通账号调用导入/维护接口返回 403。"""
    member = new_client()
    login(member, MEMBER["account"], MEMBER["password"])

    assert member.post("/api/v1/dictionaries/import/precheck", json={}).status_code == 403
    assert member.post("/api/v1/dictionaries/import/apply", json={}).status_code == 403
    assert member.patch(
        f"/api/v1/dictionaries/nodes/{seeded['l1_id']}", json={"name": "改名"}
    ).status_code == 403
    assert member.patch(
        f"/api/v1/dictionaries/items/{seeded['ref_item_id']}", json={"is_active": False}
    ).status_code == 403

    # 读接口对普通账号开放，且与首账号可见范围一致
    assert member.get("/api/v1/dictionaries/software/tree").status_code == 200
    assert member.get("/api/v1/dictionaries/batches").json() == client.get("/api/v1/dictionaries/batches").json()


def test_delete_is_always_forbidden(
    client: TestClient, setup_primary: dict, seeded: dict
) -> None:
    for path in (
        f"/api/v1/dictionaries/nodes/{seeded['l1_id']}",
        f"/api/v1/dictionaries/items/{seeded['ref_item_id']}",
        "/api/v1/dictionaries/software/tree",
    ):
        resp = client.delete(path)
        assert resp.status_code == 405, f"{path} -> {resp.status_code}"
        assert resp.json()["code"] == "method_not_allowed"
        assert "被引用条目不能物理删除，只能停用" in resp.json()["message"]


# --------------------------------------------------------------------------- API：读


def test_tree_returns_levels_and_lazy_children(
    client: TestClient, setup_primary: dict, seeded: dict
) -> None:
    root = client.get("/api/v1/dictionaries/software/tree").json()
    assert root["items"][0]["level"] == 1
    assert root["items"][0]["name"] == "软件"
    assert root["items"][0]["has_children"] is True
    assert root["items"][0]["child_count"] == 2

    children = client.get(
        "/api/v1/dictionaries/software/tree", params={"parent_id": seeded["l1_id"]}
    ).json()
    assert [n["name"] for n in children["items"]] == ["功能设计", "视觉界面"]
    assert all(n["level"] == 2 for n in children["items"])

    search = client.get("/api/v1/dictionaries/software/tree", params={"q": "文案"}).json()
    assert [n["name"] for n in search["items"]] == ["文案一致性"]

    bad = client.get("/api/v1/dictionaries/not_a_type/tree")
    assert bad.status_code == 422


def test_items_pagination_and_filters(client: TestClient, setup_primary: dict, seeded: dict) -> None:
    page = client.get(
        "/api/v1/dictionaries/software/items",
        params={"node_id": seeded["l3a_id"], "page": 1, "page_size": 1},
    ).json()
    assert page["total"] == 2
    assert len(page["items"]) == 1
    assert page["items"][0]["item_no"] == 1

    first = page["items"][0]
    assert first["description"] == "提供一组相应功能"
    assert first["source_standard"] == "GB/T 25000.23"
    assert first["example"] == "缺少导出功能"
    assert first["image_meta"] == []

    ranged = client.get(
        "/api/v1/dictionaries/software/items",
        params={"item_no_min": 2, "item_no_max": 3},
    ).json()
    assert [i["item_no"] for i in ranged["items"]] == [2, 3]

    by_level = client.get("/api/v1/dictionaries/software/items", params={"level": 3}).json()
    assert by_level["total"] == 3

    by_keyword = client.get(
        "/api/v1/dictionaries/software/items", params={"keyword": "用词一致"}
    ).json()
    assert by_keyword["total"] == 1


def test_summary_reports_level_and_item_counts(
    client: TestClient, setup_primary: dict, seeded: dict
) -> None:
    body = client.get("/api/v1/dictionaries/software/summary").json()
    counts = body["counts"]
    assert counts["nodes_by_level"] == {"1": 1, "2": 2, "3": 2}
    assert counts["check_items"] == 3
    assert counts["item_min"] == 1 and counts["item_max"] == 3
    assert body["expected"]["l3"] == 33

    hp = client.get("/api/v1/dictionaries/hardware_product/summary").json()
    assert hp["counts"]["data_rows"] == 4
    assert hp["deductions"] == {"fatal": 5, "major": 3, "normal": 2, "minor": 1}


def test_batches_expose_source_sha256(client: TestClient, setup_primary: dict, seeded: dict) -> None:
    rows = client.get("/api/v1/dictionaries/batches").json()
    assert rows, "应至少返回一条测试批次"
    assert rows[0]["source_sha256"] == "3ac4727b218ed86ee212021039508f1a98cd45978fa8f4593ffb4b96b0624e26"
    assert rows[0]["status"] == BATCH_IMPORTED
    assert rows[0]["counts"]["software"]["check_items"] == 114
    assert rows[0]["diff"]["ok"] is True


# --------------------------------------------------------------------------- API：维护（停用而非删除）


def test_deactivate_keeps_row_and_only_flips_flag(
    client: TestClient, setup_primary: dict, seeded: dict, session_factory: sessionmaker[Session]
) -> None:
    item_id = seeded["ref_item_id"]
    resp = client.patch(f"/api/v1/dictionaries/items/{item_id}", json={"is_active": False})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["item"]["is_active"] is False
    assert "物理删除" in body["message"] or "停用" in body["message"]

    # 行仍在，且只是 is_active=False
    with session_factory() as db:
        row = db.get(CheckItem, item_id)
        assert row is not None
        assert row.is_active is False
        assert row.description == "提供一组相应功能"

    inactive = client.get(
        "/api/v1/dictionaries/software/items", params={"status": "inactive"}
    ).json()
    assert [i["id"] for i in inactive["items"]] == [item_id]
    active = client.get("/api/v1/dictionaries/software/items", params={"status": "active"}).json()
    assert item_id not in [i["id"] for i in active["items"]]


def test_deactivating_referenced_item_keeps_history(
    client: TestClient, setup_primary: dict, seeded: dict, session_factory: sessionmaker[Session]
) -> None:
    """引用计数 > 0 的条目停用仍返回 200，并提示历史引用保留。"""
    item_id = seeded["ref_item_id"]
    with session_factory() as db:
        row = db.get(CheckItem, item_id)
        assert row is not None
        row.reference_count = 3
        db.commit()

    resp = client.patch(f"/api/v1/dictionaries/items/{item_id}", json={"is_active": False})
    assert resp.status_code == 200
    assert "3 处历史引用保留" in resp.json()["message"]
    assert resp.json()["item"]["is_active"] is False
    assert resp.json()["item"]["reference_count"] == 3


def test_update_node_name_and_missing_id_404(client: TestClient, setup_primary: dict, seeded: dict) -> None:
    resp = client.patch(
        f"/api/v1/dictionaries/nodes/{seeded['l3a_id']}", json={"name": "功能完备性（复核）"}
    )
    assert resp.status_code == 200
    assert resp.json()["node"]["name"] == "功能完备性（复核）"

    missing = client.patch("/api/v1/dictionaries/nodes/not-a-real-id", json={"name": "x"})
    assert missing.status_code == 404
    assert missing.json()["code"] == "not_found"


def test_precheck_via_api_blocks_unreadable_source(client: TestClient, setup_primary: dict) -> None:
    """首账号调用预检但源不可读 → 409 blocked，并写明解除条件。"""
    resp = client.post(
        "/api/v1/dictionaries/import/precheck", json={"source": "E:/no/such/uei.xlsx"}
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["code"] in {"blocked", "source_unreadable"}
    assert "源工作簿不可读" in resp.json()["message"]

    batches = client.get("/api/v1/dictionaries/batches").json()
    assert batches[0]["status"] == "blocked"


# --------------------------------------------------------------------------- 真实源集成


@pytest.mark.skipif(not _source_available(), reason="源工作簿不可读")
def test_real_workbook_counts_match_acceptance(session_factory: sessionmaker[Session]) -> None:
    """G 盘源可读时：干跑预检并断言 33/114/15/224/46/182。"""
    with session_factory() as db:
        batch = service.run_precheck(db, source_path=G_SOURCE, actor_name="integration")
        assert batch.status == "pending"
        diff = json.loads(batch.diff_json)
        assert diff["ok"] is True
        counts = json.loads(batch.counts_json)

        assert counts[DICT_SOFTWARE]["l1"] == 1
        assert counts[DICT_SOFTWARE]["l2"] == 4
        assert counts[DICT_SOFTWARE]["l3"] == 33
        assert counts[DICT_SOFTWARE]["check_items"] == 114
        assert counts[DICT_SOFTWARE]["item_min"] == 1
        assert counts[DICT_SOFTWARE]["item_max"] == 114
        assert counts[DICT_SOFTWARE]["continuous"] is True

        assert counts[DICT_HARDWARE]["l3"] == 15
        assert counts[DICT_HARDWARE_PRODUCT] == {"l1": 4, "l2": 41, "l3": 56, "data_rows": 224}
        assert counts[DICT_CONTROL_SOFTWARE] == {
            "components": 46,
            "details": 136,
            "source_rows": 182,
            "component_definition_rows": 46,
        }
        assert counts[DICT_CONTROL_HARDWARE]["components"] == 5
        assert counts[DICT_CONTROL_HARDWARE]["details"] == 50
        assert counts[DICT_CONTROL_HARDWARE]["source_rows"] == 50

        # 源只读：哈希与大小不变
        assert batch.source_sha256 == "3ac4727b218ed86ee212021039508f1a98cd45978fa8f4593ffb4b96b0624e26"
        assert batch.source_size_bytes == 241492

        # 干跑不落字典数据
        assert db.query(DictionaryNode).count() == 0
        assert db.query(CheckItem).count() == 0


@pytest.mark.skipif(not _source_available(), reason="源工作簿不可读")
def test_real_import_is_idempotent(session_factory: sessionmaker[Session]) -> None:
    """真实导入两次不产生重复行；旧批次条目只停用不删除。"""
    with session_factory() as db:
        first = service.run_import(db, source_path=G_SOURCE, actor_name="integration")
        second = service.run_import(db, source_path=G_SOURCE, actor_name="integration")

        assert first.status == BATCH_IMPORTED and second.status == BATCH_IMPORTED
        nodes = db.query(DictionaryNode).count()
        items = db.query(CheckItem).count()
        assert db.query(DictionaryNode).filter(DictionaryNode.dict_type == DICT_SOFTWARE).count() == 38
        assert db.query(CheckItem).filter(CheckItem.dict_type == DICT_SOFTWARE).count() == 114

        # 第二次导入后仍无重复（所有行都指向最新批次）
        assert db.query(DictionaryNode).filter(DictionaryNode.batch_id == second.id).count() == nodes
        assert db.query(CheckItem).filter(CheckItem.batch_id == second.id).count() == items
        assert nodes > 0 and items > 0


@pytest.mark.skipif(not _source_available(), reason="源工作簿不可读")
def test_real_import_serves_tree_and_items(
    client: TestClient, setup_primary: dict
) -> None:
    """真实导入后，接口返回的树与检查项与验收口径一致。"""
    applied = client.post("/api/v1/dictionaries/import/apply", json={})
    assert applied.status_code == 200, applied.text
    assert applied.json()["status"] == BATCH_IMPORTED

    summary = client.get("/api/v1/dictionaries/software/summary").json()["counts"]
    assert summary["nodes_by_level"] == {"1": 1, "2": 4, "3": 33}
    assert summary["check_items"] == 114
    assert summary["continuous"] is True

    items = client.get("/api/v1/dictionaries/software/items", params={"status": "active"}).json()
    assert items["total"] == 114
    assert [i["item_no"] for i in items["items"]] == list(range(1, 51))

    controls = client.get("/api/v1/dictionaries/control_software/summary").json()["counts"]
    assert controls["components"] == 46
    assert controls["details"] == 136
    assert controls["source_rows"] == 182
    assert controls["component_definition_rows"] == 46
