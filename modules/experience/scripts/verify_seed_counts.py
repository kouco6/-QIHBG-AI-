#!/usr/bin/env python
"""种子与字典数量校验。

T02：校验迁移与系统设置已就绪（在 T06 字典导入交付前，字典项标记为待交付而非失败）。
T06 之后：校验 114 / 224 / 46+136（源表 182 行 = 46 条组件定义 + 136 条细则）等精确数量。

退出码：0 通过；1 校验失败；2 环境不可用。
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

EXPECTED_SETTINGS = {
    "uei.clamp_zero": "false",
    "bei.threshold_version": "v1",
    "provider.mode": "mock",
}

# T06 交付后的硬性计数（源表权威口径；交互控件 46 组件定义 + 136 细则 = 182 源行，见 SOURCE_DIFFERENCES D-01）
EXPECTED_DICTIONARY = {
    "software_l3": 33,
    "software_check_items": 114,
    "hardware_l3": 15,
    "hardware_single_unit_rows": 224,
    "interactive_components": 46,
    "interactive_details": 136,
    "interactive_source_rows": 182,
    "interactive_component_definition_rows": 46,
}


def _verify_dictionary_counts(conn: sqlite3.Connection, add) -> None:  # noqa: ANN001
    """T06：读库统计字典计数并与期望比对，逐项打印 OK/FAIL。

    字典表存在且已有导入数据时**阻断**（不一致即 FAIL）；尚未导入时为提示项，
    以便未执行 `scripts/import_uei_workbook.py --apply` 的环境仍可校验其余种子。
    """
    tables = {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }
    if not {"dictionary_node", "check_item"} <= tables:
        add(
            "字典计数（T06）",
            True,
            "字典表尚未创建；请先执行迁移与 `python scripts/import_uei_workbook.py --apply`",
            blocking=False,
        )
        return

    def scalar(sql: str, params: tuple = ()) -> int:
        row = conn.execute(sql, params).fetchone()
        return int(row[0]) if row and row[0] is not None else 0

    def node_count(dict_type: str, level: int | None = None) -> int:
        if level is None:
            return scalar("SELECT COUNT(*) FROM dictionary_node WHERE dict_type=?", (dict_type,))
        return scalar(
            "SELECT COUNT(*) FROM dictionary_node WHERE dict_type=? AND level=?",
            (dict_type, level),
        )

    def item_count(dict_type: str) -> int:
        return scalar("SELECT COUNT(*) FROM check_item WHERE dict_type=?", (dict_type,))

    def control_definition_rows() -> int:
        """交互控件（软件）中标记为「组件定义行」的条数（D-01）。"""
        total = 0
        for (raw,) in conn.execute(
            "SELECT raw_json FROM check_item WHERE dict_type='control_software'"
        ).fetchall():
            try:
                if json.loads(raw or "{}").get("is_component_definition"):
                    total += 1
            except (TypeError, ValueError):
                continue
        return total

    imported = scalar("SELECT COUNT(*) FROM dictionary_batch WHERE status='imported'") > 0
    blocking = imported  # 已导入则计数为硬性要求

    checks = [
        ("软件三级指标 33", node_count("software", 3), EXPECTED_DICTIONARY["software_l3"]),
        ("软件检查项 114", item_count("software"), EXPECTED_DICTIONARY["software_check_items"]),
        ("硬件三级指标 15", node_count("hardware", 3), EXPECTED_DICTIONARY["hardware_l3"]),
        (
            "硬件单品数据行 224",
            item_count("hardware_product"),
            EXPECTED_DICTIONARY["hardware_single_unit_rows"],
        ),
        (
            "交互细则 136",
            item_count("control_software") - control_definition_rows(),
            EXPECTED_DICTIONARY["interactive_details"],
        ),
        (
            "交互组件定义行 46",
            control_definition_rows(),
            EXPECTED_DICTIONARY["interactive_component_definition_rows"],
        ),
        (
            "交互源表行数 182",
            item_count("control_software"),
            EXPECTED_DICTIONARY["interactive_source_rows"],
        ),
        ("硬件交互组件 5", node_count("control_hardware", 1), 5),
    ]

    for name, actual, expected in checks:
        add(
            f"字典·{name}",
            actual == expected,
            f"实际 {actual} / 期望 {expected}",
            blocking=blocking,
        )

    # 软件检查项编号必须连续 1–114（无缺号无重号）
    numbers = [row[0] for row in conn.execute(
        "SELECT item_no FROM check_item WHERE dict_type='software' ORDER BY item_no"
    ).fetchall()]
    if numbers:
        expected_seq = list(range(1, EXPECTED_DICTIONARY["software_check_items"] + 1))
        ok = numbers == expected_seq
        detail = (
            f"连续 1–{len(numbers)}"
            if ok
            else f"编号不连续：n={len(numbers)} min={min(numbers)} max={max(numbers)} "
            f"unique={len(set(numbers))}"
        )
    else:
        ok = not blocking
        detail = "尚无软件检查项"
    add("字典·软件检查项编号 1–114 连续", ok, detail, blocking=blocking)

    # D-01 口径留档（提示项，不阻断）：46 条组件定义行 + 136 条细则 = 源表 182 行
    add(
        "字典·交互控件 D-01 口径",
        True,
        f"{control_definition_rows()} 条组件定义行 + "
        f"{item_count('control_software') - control_definition_rows()} 条细则 = "
        f"{item_count('control_software')} 源表行（见 docs/SOURCE_DIFFERENCES.md D-01）",
        blocking=False,
    )

    batches = scalar("SELECT COUNT(*) FROM dictionary_batch")
    add(
        "字典·导入批次",
        batches > 0,
        f"批次 {batches} 条",
        blocking=False,
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="体验工作台种子校验")
    ap.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    ap.add_argument("--json", action="store_true", help="以 JSON 输出")
    args = ap.parse_args()

    root = Path(args.root)
    db_path = root / "data" / "uei.db"
    manifest_path = root / "backend" / "app" / "seeds" / "source_manifest.json"

    report: dict[str, object] = {"database": str(db_path), "checks": [], "ok": True}
    checks: list[dict[str, object]] = report["checks"]  # type: ignore[assignment]

    def add(name: str, ok: bool, detail: str, blocking: bool = True) -> None:
        checks.append({"name": name, "ok": ok, "detail": detail, "blocking": blocking})
        if blocking and not ok:
            report["ok"] = False

    # 1) 数据库存在
    if not db_path.exists():
        add("数据库文件", False, f"未找到 {db_path}；请先运行迁移（start.ps1 或 alembic upgrade head）")
        emit(report, args.json)
        return 1
    add("数据库文件", True, str(db_path))

    conn = sqlite3.connect(str(db_path))
    try:
        # 2) WAL
        journal = conn.execute("PRAGMA journal_mode").fetchone()[0]
        add("SQLite WAL", str(journal).lower() == "wal", f"journal_mode={journal}")

        # 3) 迁移版本
        try:
            rev = conn.execute("SELECT version_num FROM alembic_version").fetchone()
            add("迁移版本", bool(rev), f"version_num={rev[0] if rev else '无'}")
        except sqlite3.Error as exc:
            add("迁移版本", False, f"alembic_version 表缺失：{exc}")

        # 4) 系统设置
        try:
            rows = dict(conn.execute("SELECT key, value FROM system_setting").fetchall())
            missing = {k: v for k, v in EXPECTED_SETTINGS.items() if rows.get(k) != v}
            add("系统设置默认值", not missing, "全部就绪" if not missing else f"不符：{missing}")
        except sqlite3.Error as exc:
            add("系统设置默认值", False, f"system_setting 表缺失：{exc}")

        # 5) 字典数量（T06 交付前为提示项，不阻塞）
        has_dict_tables = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%dict%' OR name LIKE '%dictionary%'"
        ).fetchall()
        if not has_dict_tables:
            add(
                "字典数量",
                True,
                "字典表尚未创建（T06 交付）。期望："
                + json.dumps(EXPECTED_DICTIONARY, ensure_ascii=False),
                blocking=False,
            )
        else:
            add("字典数量", True, "字典表已存在，详细计数校验由 T06 测试负责", blocking=False)

        # 5b) T06：字典精确计数（33 / 114 / 15 / 224 / 46 / 182）
        _verify_dictionary_counts(conn, add)
    finally:
        conn.close()

    # 6) 源清单可读
    if manifest_path.exists():
        try:
            man = json.loads(manifest_path.read_text(encoding="utf-8"))
            add("源清单", True, f"sheet_count={man.get('workbook', {}).get('sheet_count')}")
        except json.JSONDecodeError as exc:
            add("源清单", False, f"JSON 解析失败：{exc}")
    else:
        add("源清单", False, f"未找到 {manifest_path}")

    emit(report, args.json)
    return 0 if report["ok"] else 1


def emit(report: dict[str, object], as_json: bool) -> None:
    if as_json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return
    print("种子校验：")
    for c in report["checks"]:  # type: ignore[union-attr]
        mark = "OK  " if c["ok"] else "FAIL"
        tip = "" if c["blocking"] else "（提示项）"
        print(f"  [{mark}] {c['name']}{tip} — {c['detail']}")
    print("结论：" + ("通过" if report["ok"] else "未通过"))


if __name__ == "__main__":
    sys.exit(main())
