"""体验字典服务（T06）：源工作簿只读解析、计数核对、幂等导入与树表维护。

设计边界
--------
- **只读源**：源工作簿以 ``openpyxl.load_workbook(..., read_only=True, data_only=True)``
  打开，绝不写入；本模块只提取文本与图片**引用元数据**，不解析图片二进制。
- **数量即口径**：软件 1/4/33/114（检查项连续 1–114）、硬件 1/4/15、
  硬件单品 4/41/56/224、交互控件（软件）46/136（源表 182 行）、交互控件（硬件）5/50。
  实际计数与期望不一致时预检 ``status=failed`` 并拒绝落库，禁止裁剪或补齐。
- **干跑优先**：预检（``precheck``）只写一条批次记录用于留痕，不写字典数据。
- **幂等**：节点以 ``(dict_type, code)`` 去重、检查项以 ``(dict_type, node_id, item_no)``
  去重；重复执行只更新字段，不产生重复行。
- **停用而非删除**：导入成功后把**旧批次**条目置 ``is_active=False``（不物理删除）；
  被引用的条目只能停用。
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

from sqlalchemy import func, insert, select, update
from sqlalchemy.orm import Session

from app.core.errors import BlockedError, ConflictError, NotFoundError, ValidationError
from app.core.security import new_id
from app.core.timeutil import utcnow
from app.models.dictionary import (
    BATCH_BLOCKED,
    BATCH_FAILED,
    BATCH_IMPORTED,
    BATCH_PENDING,
    CheckItem,
    DICT_CONTROL_HARDWARE,
    DICT_CONTROL_SOFTWARE,
    DICT_HARDWARE,
    DICT_HARDWARE_PRODUCT,
    DICT_SOFTWARE,
    DICT_TYPES,
    DictionaryBatch,
    DictionaryNode,
    HARDWARE_SEVERITY_DEDUCTION,
)

# --- 路径与清单 ---

# app/services/dictionary.py -> services -> app -> backend -> 仓库根
ROOT_DIR = Path(__file__).resolve().parents[3]
MANIFEST_PATH = ROOT_DIR / "backend" / "app" / "seeds" / "source_manifest.json"

BLOCKED_REASON_UNREADABLE = (
    "源工作簿不可读。解除条件：确认 G 盘源文件 "
    "`G:/常规文件/文件终版/12.管理/8、【其他】/【管理】产品企划部工作标准文档/"
    "【标准】UEI流程方案-20240820-V4.0.xlsx` 存在且当前进程对其有读权限；"
    "或通过 --source 指定可读的等效副本（SHA-256 "
    "3ac4727b218ed86ee212021039508f1a98cd45978fa8f4593ffb4b96b0624e26）后重跑。"
)

# Sheet 名（以 manifest 实测为准；同时兼容文档口径别名）
SHEET_ALIASES: dict[str, tuple[str, ...]] = {
    DICT_SOFTWARE: ("体验指标（软件）", "体验指标(软件)", "软件体验指标", "软件指标"),
    DICT_HARDWARE: ("体验指标（硬件）", "体验指标(硬件)", "硬件体验指标", "硬件指标"),
    DICT_HARDWARE_PRODUCT: ("硬件单品体验维度", "硬件单品体验维度表"),
    DICT_CONTROL_SOFTWARE: ("交互控件表", "交互控件表-软件"),
    DICT_CONTROL_HARDWARE: ("交互控件表-硬件", "交互控件表(硬件)"),
}

DICT_TYPE_LABELS: dict[str, str] = {
    DICT_SOFTWARE: "软件体验指标",
    DICT_HARDWARE: "硬件体验指标",
    DICT_HARDWARE_PRODUCT: "硬件单品体验维度",
    DICT_CONTROL_SOFTWARE: "交互控件（软件）",
    DICT_CONTROL_HARDWARE: "交互控件（硬件）",
}

# 等级 → 扣分（与模型常量保持一致：致命/严重/一般/轻微 = 5/3/2/1）
GRADE_ORDER: tuple[str, ...] = ("致命", "严重", "一般", "轻微")

# 期望计数中仅供说明、不参与逐项比对的键（文档口径留档）
_NON_COMPARED_KEYS: frozenset[str] = frozenset({"prd_documented_details", "prd_documented_note"})


# --------------------------------------------------------------------------- 清单


def load_manifest(path: Path | None = None) -> dict[str, Any]:
    """读取 T01 源清单（默认 backend/app/seeds/source_manifest.json）。"""
    target = Path(path) if path else MANIFEST_PATH
    with open(target, "r", encoding="utf-8") as handle:
        return json.load(handle)


def manifest_source_path(path: Path | None = None) -> str:
    """从清单取出源工作簿路径（默认取 SRC-UEI-WORKBOOK）。"""
    manifest = load_manifest(path)
    for source in manifest.get("sources", []):
        if source.get("source_id") == "SRC-UEI-WORKBOOK":
            return str(source.get("file", {}).get("path", ""))
    workbook = manifest.get("workbook", {})
    if workbook.get("path"):
        return str(workbook["path"])
    raise ValidationError("源清单中未找到 UEI 工作簿路径（SRC-UEI-WORKBOOK）")


def expected_counts(path: Path | None = None) -> dict[str, dict[str, Any]]:
    """期望计数（清单 + PRD/DESIGN 已确认口径）。

    - 软件：1 / 4 / 33 / 检查项 114（连续 1–114）    → PRD §9.1、manifest
    - 硬件：1 / 4 / 15                              → PRD §9.2
    - 硬件单品：4 / 41 / 56 / 数据行 224             → PRD §9.3、manifest
    - 交互控件（软件）：46 组件 / 136 细则（源表 182 行） → PRD §9.4、SOURCE_DIFFERENCES D-01
    - 交互控件（硬件）：5 组件 / 50 细则              → manifest
    """
    manifest = load_manifest(path)
    exp = manifest.get("dictionary_expectations", {})
    software = exp.get("software", {})
    hardware = exp.get("hardware_metrics", {})
    single_unit = exp.get("hardware_single_unit", {})
    control_sw = exp.get("interactive_controls_software", {})
    control_hw = exp.get("interactive_controls_hardware", {})
    return {
        DICT_SOFTWARE: {
            "l1": 1,
            "l2": 4,
            "l3": int(software.get("l3_names", 33)),
            "check_items": int(software.get("check_items", 114)),
            "item_min": 1,
            "item_max": 114,
            "continuous": True,
        },
        DICT_HARDWARE: {
            "l1": int(hardware.get("l1", 1)),
            "l2": int(hardware.get("l2", 4)),
            "l3": int(hardware.get("l3", 15)),
        },
        DICT_HARDWARE_PRODUCT: {
            "l1": int(single_unit.get("l1", 4)),
            "l2": int(single_unit.get("l2", 41)),
            "l3": int(single_unit.get("l3_dimensions", 56)),
            "data_rows": int(single_unit.get("grade_rows", 224)),
        },
        DICT_CONTROL_SOFTWARE: {
            "components": int(control_sw.get("components", 46)),
            # 细则 136 = 源表 182 行 − 46 条组件定义行（D-01）
            "details": int(control_sw.get("details", 136)),
            "source_rows": int(control_sw.get("source_rows", 182)),
        },
        DICT_CONTROL_HARDWARE: {
            "components": int(control_hw.get("components", 5)),
            "details": int(control_hw.get("details", 50)),
        },
    }


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_info(path: Path) -> dict[str, Any]:
    """源文件只读指纹：存在性、大小、SHA-256、修改时间（naive UTC）。"""
    info: dict[str, Any] = {
        "path": str(path),
        "exists": False,
        "size_bytes": 0,
        "sha256": "",
        "modified_at": None,
    }
    try:
        stat = path.stat()
    except OSError:
        return info
    info["exists"] = True
    info["size_bytes"] = int(stat.st_size)
    info["modified_at"] = _dt.datetime.fromtimestamp(stat.st_mtime, _dt.timezone.utc).replace(tzinfo=None)
    try:
        info["sha256"] = sha256_of(path)
    except OSError:
        info["exists"] = False
    return info


# --------------------------------------------------------------------------- 解析结构


@dataclass
class ParsedNode:
    dict_type: str
    level: int
    code: str
    name: str
    order_no: int
    parent_code: str | None = None
    severity: str = ""
    deduction: str = ""
    note: str = ""
    source_standard: str = ""
    example: str = ""
    image_meta: list[dict[str, Any]] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class ParsedItem:
    dict_type: str
    node_code: str
    item_no: int
    name: str
    description: str
    source_standard: str = ""
    example: str = ""
    image_meta: list[dict[str, Any]] = field(default_factory=list)
    severity: str = ""
    deduction: str = ""
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class ParsedWorkbook:
    nodes: list[ParsedNode]
    items: list[ParsedItem]
    counts: dict[str, dict[str, Any]]


# --------------------------------------------------------------------------- 工具


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _image_meta(cell_value: Any, anchored: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """图片引用元数据：仅记录单元格文本与内嵌图片锚点，不解析图片二进制。"""
    meta: list[dict[str, Any]] = []
    text = _text(cell_value)
    if text:
        meta.append({"kind": "cell_text", "value": text})
    meta.extend(anchored)
    return meta


def validate_item_sequence(numbers: Sequence[int]) -> dict[str, Any]:
    """校验检查项编号是否**连续无缺号无重号**。

    返回 ``{ok, count, missing, duplicates, item_min, item_max, continuous}``。
    缺号或重号时 ``ok=False``（供预检与测试使用）。
    """
    values = [int(n) for n in numbers]
    if not values:
        return {
            "ok": False,
            "count": 0,
            "missing": [],
            "duplicates": [],
            "item_min": None,
            "item_max": None,
            "continuous": False,
        }
    seen: dict[int, int] = {}
    for value in values:
        seen[value] = seen.get(value, 0) + 1
    duplicates = sorted(v for v, c in seen.items() if c > 1)
    item_min, item_max = min(values), max(values)
    missing = [n for n in range(item_min, item_max + 1) if n not in seen]
    continuous = not duplicates and not missing and len(values) == (item_max - item_min + 1)
    return {
        "ok": continuous,
        "count": len(values),
        "missing": missing,
        "duplicates": duplicates,
        "item_min": item_min,
        "item_max": item_max,
        "continuous": continuous,
    }


# --------------------------------------------------------------------------- 图片锚点


def _drawing_anchors(workbook_path: Path) -> dict[str, dict[int, list[dict[str, Any]]]]:
    """扫描工作簿内嵌图片锚点：sheet 名 → {0基行号 → [图片引用元数据]}。

    只读取 OOXML 关系与锚点坐标，**不读取图片二进制**。任何异常一律返回空映射，
    保证解析主流程不因图片结构差异而失败。
    """
    result: dict[str, dict[int, list[dict[str, Any]]]] = {}
    try:
        with ZipFile(workbook_path) as archive:
            names = set(archive.namelist())
            ns = {
                "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
                "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
                "pr": "http://schemas.openxmlformats.org/package/2006/relationships",
                "xdr": "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
                "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
            }
            sheet_targets: dict[str, str] = {}
            workbook_xml = ElementTree.fromstring(archive.read("xl/workbook.xml"))
            rels = ElementTree.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
            rel_map = {
                rel.get("Id"): rel.get("Target")
                for rel in rels.findall("pr:Relationship", ns)
            }
            for sheet in workbook_xml.findall("main:sheets/main:sheet", ns):
                rid = sheet.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
                target = rel_map.get(rid or "", "")
                if target:
                    sheet_targets[sheet.get("name", "")] = target.lstrip("/")

            for sheet_name, target in sheet_targets.items():
                rel_path = f"xl/{target}".replace("xl/xl/", "xl/")
                if rel_path.startswith("xl/worksheets"):
                    rels_path = rel_path.replace("worksheets/", "worksheets/_rels/") + ".rels"
                else:
                    continue
                if rels_path not in names:
                    continue
                sheet_rels = ElementTree.fromstring(archive.read(rels_path))
                drawing_target = ""
                for rel in sheet_rels.findall("pr:Relationship", ns):
                    if rel.get("Type", "").endswith("/drawing"):
                        drawing_target = rel.get("Target", "").lstrip("/")
                if not drawing_target:
                    continue
                drawing_path = f"xl/{drawing_target}".replace("xl/xl/", "xl/")
                if drawing_path not in names:
                    continue
                drawing_rels_path = drawing_path.replace("drawings/", "drawings/_rels/") + ".rels"
                media_by_rid: dict[str, str] = {}
                if drawing_rels_path in names:
                    for rel in ElementTree.fromstring(archive.read(drawing_rels_path)).findall(
                        "pr:Relationship", ns
                    ):
                        media_by_rid[rel.get("Id", "")] = rel.get("Target", "").split("/")[-1]

                drawing = ElementTree.fromstring(archive.read(drawing_path))
                anchors: dict[int, list[dict[str, Any]]] = {}
                for anchor in list(drawing):
                    from_row = anchor.find("xdr:from/xdr:row", ns)
                    blips = anchor.findall(".//a:blip", ns)
                    if from_row is None or not blips:
                        continue
                    row = int(from_row.text or -1)
                    for blip in blips:
                        embed = blip.get(
                            "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed"
                        )
                        media = media_by_rid.get(embed or "", "")
                        entry = {
                            "kind": "embedded_image",
                            "sheet": sheet_name,
                            "row": row + 1,
                            "media": media,
                            "drawing": drawing_path.split("/")[-1],
                        }
                        anchors.setdefault(row, []).append(entry)
                if anchors:
                    result[sheet_name] = anchors
    except (KeyError, BadZipFile, OSError, ElementTree.ParseError, ValueError):
        return {}
    return result


# --------------------------------------------------------------------------- 解析


def _resolve_sheet(workbook: Any, dict_type: str) -> Any:
    titles = set(workbook.sheetnames)
    for alias in SHEET_ALIASES[dict_type]:
        if alias in titles:
            return workbook[alias]
    raise ValidationError(
        f"源工作簿缺少「{DICT_TYPE_LABELS[dict_type]}」对应 Sheet；"
        f"已尝试：{'、'.join(SHEET_ALIASES[dict_type])}",
        field_errors=[
            {"field": "sheet", "message": f"未找到 Sheet：{SHEET_ALIASES[dict_type]}", "type": "value_error"}
        ],
    )


def _header_index(rows: Sequence[Sequence[Any]], token: str = "一级指标") -> int:
    for index, row in enumerate(rows):
        if row and _text(row[0]) == token:
            return index
    return 1


def _parse_software(workbook: Any, anchors: dict[int, list[dict[str, Any]]]) -> tuple[list[ParsedNode], list[ParsedItem], dict[str, Any]]:
    """软件体验指标：1/4/33 层级 + 连续编号 1–114 检查项。"""
    sheet = _resolve_sheet(workbook, DICT_SOFTWARE)
    rows = [tuple(r) for r in sheet.iter_rows(values_only=True)]
    start = _header_index(rows) + 1
    sheet_anchors = anchors.get(sheet.title, {})

    nodes: list[ParsedNode] = []
    items: list[ParsedItem] = []
    numbers: list[int] = []
    l1_code: str | None = None
    l1_name = ""
    l2_map: dict[str, ParsedNode] = {}
    cur_l2: ParsedNode | None = None
    l3_map: dict[tuple[str, str], ParsedNode] = {}
    cur_l3: ParsedNode | None = None

    for offset, row in enumerate(rows[start:]):
        if not row or not any(_text(c) for c in row):
            continue
        excel_row = start + offset + 1
        l1, l2, l3, seq = _text(row[0]), _text(row[1]), _text(row[2]), row[3]
        desc = _text(row[4]) if len(row) > 4 else ""
        source_std = _text(row[5]) if len(row) > 5 else ""
        example = _text(row[6]) if len(row) > 6 else ""
        image_cell = row[7] if len(row) > 7 else None

        if l1 and l1_code is None:
            l1_code, l1_name = "SW-L1", l1
            nodes.append(
                ParsedNode(
                    dict_type=DICT_SOFTWARE, level=1, code=l1_code, name=l1, order_no=1,
                    raw={"sheet": sheet.title, "excel_row": excel_row},
                )
            )
        if l2 and l2 not in l2_map:
            cur_l2 = ParsedNode(
                dict_type=DICT_SOFTWARE, level=2, code=f"SW-L2-{len(l2_map) + 1:02d}", name=l2,
                order_no=len(l2_map) + 1, parent_code=l1_code,
                raw={"sheet": sheet.title, "excel_row": excel_row},
            )
            l2_map[l2] = cur_l2
            nodes.append(cur_l2)
        elif l2:
            cur_l2 = l2_map[l2]
        if l3 and cur_l2 is not None:
            key = (cur_l2.code, l3)
            if key not in l3_map:
                cur_l3 = ParsedNode(
                    dict_type=DICT_SOFTWARE, level=3, code=f"SW-L3-{len(l3_map) + 1:03d}", name=l3,
                    order_no=len(l3_map) + 1, parent_code=cur_l2.code,
                    raw={"sheet": sheet.title, "excel_row": excel_row},
                )
                l3_map[key] = cur_l3
                nodes.append(cur_l3)
            else:
                cur_l3 = l3_map[key]

        if not _text(seq):
            continue
        item_no = int(float(seq))
        numbers.append(item_no)
        items.append(
            ParsedItem(
                dict_type=DICT_SOFTWARE,
                node_code=cur_l3.code if cur_l3 else (l1_code or "SW-L1"),
                item_no=item_no,
                name=cur_l3.name if cur_l3 else "",
                description=desc,
                source_standard=source_std,
                example=example,
                image_meta=_image_meta(image_cell, sheet_anchors.get(excel_row - 1, [])),
                raw={
                    "sheet": sheet.title,
                    "excel_row": excel_row,
                    "l2": cur_l2.name if cur_l2 else "",
                    "l3": l3 or "",
                },
            )
        )

    seq_check = validate_item_sequence(numbers)
    counts = {
        "l1": len([n for n in nodes if n.level == 1]),
        "l2": len([n for n in nodes if n.level == 2]),
        "l3": len([n for n in nodes if n.level == 3]),
        "check_items": len(items),
        "item_min": seq_check["item_min"],
        "item_max": seq_check["item_max"],
        "continuous": bool(seq_check["ok"]),
        "missing": seq_check["missing"],
        "duplicates": seq_check["duplicates"],
    }
    return nodes, items, counts


def _parse_hardware(workbook: Any, anchors: dict[int, list[dict[str, Any]]]) -> tuple[list[ParsedNode], list[ParsedItem], dict[str, Any]]:
    """硬件体验指标：1/4/15 层级；每组说明行作为该三级指标下的检查项保留。"""
    sheet = _resolve_sheet(workbook, DICT_HARDWARE)
    rows = [tuple(r) for r in sheet.iter_rows(values_only=True)]
    start = _header_index(rows) + 1
    sheet_anchors = anchors.get(sheet.title, {})

    nodes: list[ParsedNode] = []
    items: list[ParsedItem] = []
    l1_code: str | None = None
    l2_map: dict[str, ParsedNode] = {}
    cur_l2: ParsedNode | None = None
    l3_map: dict[tuple[str, str], ParsedNode] = {}
    cur_l3: ParsedNode | None = None
    node_item_count: dict[str, int] = {}

    for offset, row in enumerate(rows[start:]):
        if not row or not any(_text(c) for c in row):
            continue
        excel_row = start + offset + 1
        l1, l2, l3 = _text(row[0]), _text(row[1]), _text(row[2])
        desc = _text(row[3]) if len(row) > 3 else ""
        source_std = _text(row[4]) if len(row) > 4 else ""
        example = _text(row[5]) if len(row) > 5 else ""
        image_cell = row[6] if len(row) > 6 else None

        if l1 and l1_code is None:
            l1_code = "HW-L1"
            nodes.append(
                ParsedNode(
                    dict_type=DICT_HARDWARE, level=1, code=l1_code, name=l1, order_no=1,
                    raw={"sheet": sheet.title, "excel_row": excel_row},
                )
            )
        if l2 and l2 not in l2_map:
            cur_l2 = ParsedNode(
                dict_type=DICT_HARDWARE, level=2, code=f"HW-L2-{len(l2_map) + 1:02d}", name=l2,
                order_no=len(l2_map) + 1, parent_code=l1_code,
                raw={"sheet": sheet.title, "excel_row": excel_row},
            )
            l2_map[l2] = cur_l2
            nodes.append(cur_l2)
        elif l2:
            cur_l2 = l2_map[l2]
        if l3 and cur_l2 is not None:
            key = (cur_l2.code, l3)
            if key not in l3_map:
                cur_l3 = ParsedNode(
                    dict_type=DICT_HARDWARE, level=3, code=f"HW-L3-{len(l3_map) + 1:02d}", name=l3,
                    order_no=len(l3_map) + 1, parent_code=cur_l2.code,
                    raw={"sheet": sheet.title, "excel_row": excel_row},
                )
                l3_map[key] = cur_l3
                nodes.append(cur_l3)
            else:
                cur_l3 = l3_map[key]

        if cur_l3 is None:
            continue
        node_item_count[cur_l3.code] = node_item_count.get(cur_l3.code, 0) + 1
        items.append(
            ParsedItem(
                dict_type=DICT_HARDWARE,
                node_code=cur_l3.code,
                item_no=node_item_count[cur_l3.code],
                name=cur_l3.name,
                description=desc,
                source_standard=source_std,
                example=example,
                image_meta=_image_meta(image_cell, sheet_anchors.get(excel_row - 1, [])),
                raw={"sheet": sheet.title, "excel_row": excel_row},
            )
        )

    counts = {
        "l1": len([n for n in nodes if n.level == 1]),
        "l2": len([n for n in nodes if n.level == 2]),
        "l3": len([n for n in nodes if n.level == 3]),
        "check_items": len(items),
    }
    return nodes, items, counts


def _parse_hardware_product(workbook: Any, anchors: dict[int, list[dict[str, Any]]]) -> tuple[list[ParsedNode], list[ParsedItem], dict[str, Any]]:
    """硬件单品体验维度：4/41/56 层级 + 224 数据行（56 维度 × 4 等级，扣分 5/3/2/1）。

    口径说明：文档口径「二级 41」按**去重后二级指标名称**计数；源表中「接口」同时
    出现在一级指标「外观结构」与「操作」之下。为满足 41 口径，二级节点按名称去重
    （父节点取首次出现的一级指标），并在 ``raw_json`` 中保留全部出现位置，
    三级维度与 224 条等级行**一条不裁剪**。
    """
    sheet = _resolve_sheet(workbook, DICT_HARDWARE_PRODUCT)
    rows = [tuple(r) for r in sheet.iter_rows(values_only=True)]
    start = _header_index(rows) + 1

    nodes: list[ParsedNode] = []
    items: list[ParsedItem] = []
    l1_map: dict[str, ParsedNode] = {}
    l2_map: dict[str, ParsedNode] = {}
    l3_map: dict[tuple[str, str], ParsedNode] = {}
    l2_occurrences: dict[str, list[dict[str, Any]]] = {}
    cur_l1: ParsedNode | None = None
    cur_l2: ParsedNode | None = None
    cur_l3: ParsedNode | None = None
    node_item_count: dict[str, int] = {}

    for offset, row in enumerate(rows[start:]):
        if not row or not any(_text(c) for c in row):
            continue
        excel_row = start + offset + 1
        l1, l2, l3 = _text(row[0]), _text(row[1]), _text(row[2])
        grade = _text(row[3]) if len(row) > 3 else ""
        grade_desc = _text(row[4]) if len(row) > 4 else ""
        deduct = _text(row[5]) if len(row) > 5 else ""

        if l1:
            if l1 not in l1_map:
                cur_l1 = ParsedNode(
                    dict_type=DICT_HARDWARE_PRODUCT, level=1, code=f"HP-L1-{len(l1_map) + 1}", name=l1,
                    order_no=len(l1_map) + 1, raw={"sheet": sheet.title, "excel_row": excel_row},
                )
                l1_map[l1] = cur_l1
                nodes.append(cur_l1)
            else:
                cur_l1 = l1_map[l1]
        if l2:
            l2_occurrences.setdefault(l2, []).append(
                {"l1": cur_l1.name if cur_l1 else "", "excel_row": excel_row}
            )
            if l2 not in l2_map:
                cur_l2 = ParsedNode(
                    dict_type=DICT_HARDWARE_PRODUCT, level=2, code=f"HP-L2-{len(l2_map) + 1:02d}", name=l2,
                    order_no=len(l2_map) + 1, parent_code=cur_l1.code if cur_l1 else None,
                    raw={"sheet": sheet.title, "excel_row": excel_row},
                )
                l2_map[l2] = cur_l2
                nodes.append(cur_l2)
            else:
                cur_l2 = l2_map[l2]
        if l3 and cur_l2 is not None:
            key = (cur_l2.name, l3)
            if key not in l3_map:
                cur_l3 = ParsedNode(
                    dict_type=DICT_HARDWARE_PRODUCT, level=3, code=f"HP-L3-{len(l3_map) + 1:03d}", name=l3,
                    order_no=len(l3_map) + 1, parent_code=cur_l2.code,
                    raw={"sheet": sheet.title, "excel_row": excel_row, "l1": cur_l1.name if cur_l1 else ""},
                )
                l3_map[key] = cur_l3
                nodes.append(cur_l3)
            else:
                cur_l3 = l3_map[key]

        if cur_l3 is None or not grade:
            continue
        node_item_count[cur_l3.code] = node_item_count.get(cur_l3.code, 0) + 1
        items.append(
            ParsedItem(
                dict_type=DICT_HARDWARE_PRODUCT,
                node_code=cur_l3.code,
                item_no=node_item_count[cur_l3.code],
                name=grade,
                description=grade_desc,
                severity=grade,
                deduction=deduct,
                raw={
                    "sheet": sheet.title,
                    "excel_row": excel_row,
                    "grade": grade,
                    "l1": cur_l1.name if cur_l1 else "",
                },
            )
        )

    # 二级指标去重后的出现位置留档（不裁剪任何三级维度与等级行）
    for name, node in l2_map.items():
        occurrences = l2_occurrences.get(name, [])
        node.raw = {**node.raw, "occurrences": occurrences, "l1_list": sorted({o["l1"] for o in occurrences if o["l1"]})}
        if len(node.raw["l1_list"]) > 1:
            node.note = f"源表中该二级指标出现在多个一级指标下：{'、'.join(node.raw['l1_list'])}（按名称去重计数）"

    counts = {
        "l1": len([n for n in nodes if n.level == 1]),
        "l2": len([n for n in nodes if n.level == 2]),
        "l3": len([n for n in nodes if n.level == 3]),
        "data_rows": len(items),
    }
    return nodes, items, counts


def _parse_controls(workbook: Any, dict_type: str, code_prefix: str) -> tuple[list[ParsedNode], list[ParsedItem], dict[str, Any]]:
    sheet = _resolve_sheet(workbook, dict_type)
    rows = [tuple(r) for r in sheet.iter_rows(values_only=True)]
    start = _header_index(rows, token="组件") + 1

    nodes: list[ParsedNode] = []
    items: list[ParsedItem] = []
    current: ParsedNode | None = None
    # D-01 仅针对交互控件（软件）：46 条组件定义行单列，细则 = 182 − 46 = 136。
    # 硬件控件表按 DESIGN「5 组件 / 50 细则」口径，50 行全部计为细则。
    flag_definition_rows = dict_type == DICT_CONTROL_SOFTWARE

    for offset, row in enumerate(rows[start:]):
        if not row or not any(_text(c) for c in row):
            continue
        excel_row = start + offset + 1
        component = _text(row[0])
        detail = _text(row[1]) if len(row) > 1 else ""
        grade = _text(row[2]) if len(row) > 2 else ""
        is_component_row = bool(component)
        if component:
            node = ParsedNode(
                dict_type=dict_type,
                level=1,
                code=f"{code_prefix}-{len(nodes) + 1:02d}",
                name=component,
                order_no=len(nodes) + 1,
                raw={"sheet": sheet.title, "excel_row": excel_row},
            )
            nodes.append(node)
            current = node
        if current is None or not detail:
            continue
        item_no = len([i for i in items if i.node_code == current.code]) + 1
        items.append(
            ParsedItem(
                dict_type=dict_type,
                node_code=current.code,
                item_no=item_no,
                name=current.name,
                description=detail,
                severity=grade,
                raw={
                    "sheet": sheet.title,
                    "excel_row": excel_row,
                    # D-01：每组件首行为「组件定义行」，与细则行同表保留（46 + 136 = 182）
                    "is_component_definition": flag_definition_rows and is_component_row and item_no == 1,
                },
            )
        )

    definition_rows = sum(1 for item in items if item.raw.get("is_component_definition"))
    counts = {
        "components": len(nodes),
        # 细则 = 源表行数 − 组件定义行；不得把定义行重复计入细则
        "details": len(items) - definition_rows,
        "source_rows": len(items),
        "component_definition_rows": definition_rows,
    }
    return nodes, items, counts


def parse_workbook(source_path: str | Path) -> ParsedWorkbook:
    """只读解析源工作簿，返回 5 类字典的节点、检查项与实测计数。"""
    from openpyxl import load_workbook

    path = Path(source_path)
    if not path.exists():
        raise BlockedError(BLOCKED_REASON_UNREADABLE, code="source_unreadable", extra={"source_path": str(path)})

    anchors = _drawing_anchors(path)
    try:
        workbook = load_workbook(path, read_only=True, data_only=True)
    except Exception as exc:  # noqa: BLE001 - 统一转为可读阻塞
        raise BlockedError(
            f"{BLOCKED_REASON_UNREADABLE}（打开失败：{exc}）",
            code="source_unreadable",
            extra={"source_path": str(path)},
        ) from exc

    try:
        software_nodes, software_items, software_counts = _parse_software(workbook, anchors)
        hardware_nodes, hardware_items, hardware_counts = _parse_hardware(workbook, anchors)
        product_nodes, product_items, product_counts = _parse_hardware_product(workbook, anchors)
        control_sw_nodes, control_sw_items, control_sw_counts = _parse_controls(
            workbook, DICT_CONTROL_SOFTWARE, "CS-C"
        )
        control_hw_nodes, control_hw_items, control_hw_counts = _parse_controls(
            workbook, DICT_CONTROL_HARDWARE, "CH-C"
        )
        nodes = software_nodes + hardware_nodes + product_nodes + control_sw_nodes + control_hw_nodes
        items = software_items + hardware_items + product_items + control_sw_items + control_hw_items
        counts = {
            DICT_SOFTWARE: software_counts,
            DICT_HARDWARE: hardware_counts,
            DICT_HARDWARE_PRODUCT: product_counts,
            DICT_CONTROL_SOFTWARE: control_sw_counts,
            DICT_CONTROL_HARDWARE: control_hw_counts,
        }
        return ParsedWorkbook(nodes=nodes, items=items, counts=counts)
    finally:
        workbook.close()


def diff_counts(counts: dict[str, dict[str, Any]], expected: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """逐项比对实测计数与期望计数；不一致即 ``ok=False``。"""
    items: dict[str, dict[str, Any]] = {}
    ok = True
    for section, exp in expected.items():
        actual = counts.get(section, {})
        for key, want in exp.items():
            if key in _NON_COMPARED_KEYS:
                continue
            got = actual.get(key)
            match = got == want
            if not match:
                ok = False
            items[f"{section}.{key}"] = {"expected": want, "actual": got, "ok": match}
    return {"ok": ok, "items": items}


# --------------------------------------------------------------------------- 批次


def _new_batch(
    db: Session,
    *,
    source_path: str,
    info: dict[str, Any],
    dry_run: bool,
    actor_name: str,
    status: str = BATCH_PENDING,
    notes: str = "",
    blocked_reason: str = "",
    counts: dict[str, Any] | None = None,
    expected: dict[str, Any] | None = None,
    diff: dict[str, Any] | None = None,
) -> DictionaryBatch:
    batch = DictionaryBatch(
        id=new_id(),
        source_path=source_path,
        source_sha256=str(info.get("sha256") or ""),
        source_size_bytes=int(info.get("size_bytes") or 0),
        source_modified_at=info.get("modified_at"),
        status=status,
        dry_run=dry_run,
        counts_json=json.dumps(counts or {}, ensure_ascii=False),
        expected_json=json.dumps(expected or {}, ensure_ascii=False),
        diff_json=json.dumps(diff or {}, ensure_ascii=False),
        blocked_reason=blocked_reason,
        notes=notes,
        created_by_name=actor_name,
        finished_at=None,
    )
    db.add(batch)
    db.commit()
    db.refresh(batch)
    return batch


def run_precheck(
    db: Session,
    *,
    source_path: str | Path | None = None,
    actor_name: str = "",
) -> DictionaryBatch:
    """干跑预检：只读源、比对计数、写一条 ``pending``/``failed``/``blocked`` 批次。

    **不写入任何字典数据**。源不可读时批次 ``status=blocked`` 并抛 ``BlockedError``；
    计数不一致时批次 ``status=failed`` 并抛 ``ConflictError``。
    """
    resolved = str(source_path) if source_path else manifest_source_path()
    info = source_info(Path(resolved))
    expected = expected_counts()

    if not info["exists"]:
        batch = _new_batch(
            db,
            source_path=resolved,
            info=info,
            dry_run=True,
            actor_name=actor_name,
            status=BATCH_BLOCKED,
            notes="干跑预检：源工作簿不可读",
            blocked_reason=BLOCKED_REASON_UNREADABLE,
            expected=expected,
        )
        batch.finished_at = utcnow()
        db.commit()
        raise BlockedError(BLOCKED_REASON_UNREADABLE, code="source_unreadable", extra={"batch_id": batch.id})

    try:
        parsed = parse_workbook(resolved)
    except BlockedError as exc:
        batch = _new_batch(
            db,
            source_path=resolved,
            info=info,
            dry_run=True,
            actor_name=actor_name,
            status=BATCH_BLOCKED,
            notes="干跑预检：源工作簿解析失败",
            blocked_reason=exc.message,
            expected=expected,
        )
        batch.finished_at = utcnow()
        db.commit()
        raise BlockedError(exc.message, code="source_unreadable", extra={"batch_id": batch.id}) from exc

    diff = diff_counts(parsed.counts, expected)
    status = BATCH_PENDING if diff["ok"] else BATCH_FAILED
    batch = _new_batch(
        db,
        source_path=resolved,
        info=info,
        dry_run=True,
        actor_name=actor_name,
        status=status,
        notes="干跑预检通过，未写入字典数据" if diff["ok"] else "干跑预检计数不一致，已阻止落库",
        counts=parsed.counts,
        expected=expected,
        diff=diff,
    )
    batch.finished_at = utcnow()
    if not diff["ok"]:
        batch.blocked_reason = "实测计数与期望计数不一致，--apply 拒绝执行"
        db.commit()
        raise ConflictError(
            "字典计数与期望不一致，已拒绝导入",
            code="count_mismatch",
            extra={"batch_id": batch.id, "diff": diff},
        )
    db.commit()
    return batch


def run_import(
    db: Session,
    *,
    source_path: str | Path | None = None,
    actor_name: str = "",
) -> DictionaryBatch:
    """真实导入（幂等）：先建新批次，落库成功后置旧批次条目停用（不物理删除）。"""
    resolved = str(source_path) if source_path else manifest_source_path()
    info = source_info(Path(resolved))
    expected = expected_counts()

    if not info["exists"]:
        batch = _new_batch(
            db,
            source_path=resolved,
            info=info,
            dry_run=False,
            actor_name=actor_name,
            status=BATCH_BLOCKED,
            notes="真实导入：源工作簿不可读",
            blocked_reason=BLOCKED_REASON_UNREADABLE,
            expected=expected,
        )
        batch.finished_at = utcnow()
        db.commit()
        raise BlockedError(BLOCKED_REASON_UNREADABLE, code="source_unreadable", extra={"batch_id": batch.id})

    try:
        parsed = parse_workbook(resolved)
    except BlockedError as exc:
        batch = _new_batch(
            db,
            source_path=resolved,
            info=info,
            dry_run=False,
            actor_name=actor_name,
            status=BATCH_BLOCKED,
            notes="真实导入：源工作簿解析失败",
            blocked_reason=exc.message,
            expected=expected,
        )
        batch.finished_at = utcnow()
        db.commit()
        raise

    diff = diff_counts(parsed.counts, expected)
    if not diff["ok"]:
        batch = _new_batch(
            db,
            source_path=resolved,
            info=info,
            dry_run=False,
            actor_name=actor_name,
            status=BATCH_FAILED,
            notes="真实导入：计数不一致，拒绝落库",
            blocked_reason="实测计数与期望计数不一致",
            counts=parsed.counts,
            expected=expected,
            diff=diff,
        )
        batch.finished_at = utcnow()
        db.commit()
        raise ConflictError(
            "字典计数与期望不一致，已拒绝导入",
            code="count_mismatch",
            extra={"batch_id": batch.id, "diff": diff},
        )

    batch = _new_batch(
        db,
        source_path=resolved,
        info=info,
        dry_run=False,
        actor_name=actor_name,
        status=BATCH_PENDING,
        notes="真实导入进行中",
        counts=parsed.counts,
        expected=expected,
        diff=diff,
    )
    stats = persist_parsed(db, parsed, batch_id=batch.id)
    batch.status = BATCH_IMPORTED
    batch.notes = f"真实导入完成：节点 {stats['nodes_created'] + stats['nodes_updated']} 个、检查项 {stats['items_created'] + stats['items_updated']} 条"
    batch.finished_at = utcnow()
    db.commit()
    db.refresh(batch)
    return batch


# --------------------------------------------------------------------------- 落库


def persist_parsed(db: Session, parsed: ParsedWorkbook, *, batch_id: str) -> dict[str, int]:
    """幂等落库：``(dict_type, code)`` 去重节点、``(dict_type, node_id, item_no)`` 去重检查项。"""
    dict_types = sorted({node.dict_type for node in parsed.nodes} | {item.dict_type for item in parsed.items})

    existing_nodes: dict[tuple[str, str], str] = {}
    node_rows = db.execute(
        select(DictionaryNode.dict_type, DictionaryNode.code, DictionaryNode.id).where(
            DictionaryNode.dict_type.in_(dict_types)
        )
    ).all()
    for dict_type, code, node_id in node_rows:
        existing_nodes[(dict_type, code)] = node_id

    code_to_id: dict[tuple[str, str], str] = dict(existing_nodes)
    parsed_by_key = {(node.dict_type, node.code): node for node in parsed.nodes}

    def _full_path(node: ParsedNode) -> str:
        chain = [node.code]
        cursor = node
        while cursor.parent_code:
            cursor = parsed_by_key.get((cursor.dict_type, cursor.parent_code))
            if cursor is None:
                break
            chain.append(cursor.code)
        return "/" + "/".join(reversed(chain))

    nodes_created = nodes_updated = 0
    for node in sorted(parsed.nodes, key=lambda n: (n.level, n.order_no)):
        key = (node.dict_type, node.code)
        parent_id = code_to_id.get((node.dict_type, node.parent_code)) if node.parent_code else None
        payload = {
            "dict_type": node.dict_type,
            "batch_id": batch_id,
            "parent_id": parent_id,
            "level": node.level,
            "path": _full_path(node),
            "code": node.code,
            "name": node.name,
            "order_no": node.order_no,
            "severity": node.severity,
            "deduction": node.deduction,
            "note": node.note,
            "source_standard": node.source_standard,
            "example": node.example,
            "image_meta_json": json.dumps(node.image_meta, ensure_ascii=False),
            "raw_json": json.dumps(node.raw, ensure_ascii=False),
            "is_active": True,
        }
        if key in existing_nodes:
            db.execute(update(DictionaryNode).where(DictionaryNode.id == existing_nodes[key]).values(**payload))
            nodes_updated += 1
        else:
            node_id = new_id()
            db.execute(insert(DictionaryNode).values(id=node_id, reference_count=0, **payload))
            existing_nodes[key] = node_id
            code_to_id[key] = node_id
            nodes_created += 1
    db.flush()

    item_rows = db.execute(
        select(CheckItem.dict_type, CheckItem.node_id, CheckItem.item_no, CheckItem.id).where(
            CheckItem.dict_type.in_(dict_types)
        )
    ).all()
    existing_items = {(dt, nid, no): iid for dt, nid, no, iid in item_rows}

    items_created = items_updated = 0
    seen: set[tuple[str, str, int]] = set()
    for item in parsed.items:
        node_id = code_to_id.get((item.dict_type, item.node_code))
        if node_id is None:
            continue
        key = (item.dict_type, node_id, item.item_no)
        if key in seen:
            continue
        seen.add(key)
        payload = {
            "dict_type": item.dict_type,
            "node_id": node_id,
            "batch_id": batch_id,
            "item_no": item.item_no,
            "name": item.name,
            "description": item.description,
            "source_standard": item.source_standard,
            "example": item.example,
            "image_meta_json": json.dumps(item.image_meta, ensure_ascii=False),
            "severity": item.severity,
            "deduction": item.deduction,
            "raw_json": json.dumps(item.raw, ensure_ascii=False),
            "is_active": True,
        }
        if key in existing_items:
            db.execute(update(CheckItem).where(CheckItem.id == existing_items[key]).values(**payload))
            items_updated += 1
        else:
            db.execute(insert(CheckItem).values(id=new_id(), reference_count=0, **payload))
            items_created += 1
    db.flush()

    # 旧批次条目停用（不物理删除）：本批次之外的、来自历史批次的条目
    for model in (DictionaryNode, CheckItem):
        db.execute(
            update(model)
            .where(
                model.dict_type.in_(dict_types),
                model.batch_id.is_not(None),
                model.batch_id != batch_id,
                model.is_active.is_(True),
            )
            .values(is_active=False)
        )
    db.commit()

    return {
        "nodes_created": nodes_created,
        "nodes_updated": nodes_updated,
        "items_created": items_created,
        "items_updated": items_updated,
    }


# --------------------------------------------------------------------------- 查询


def ensure_dict_type(dict_type: str) -> str:
    if dict_type not in DICT_TYPES:
        raise ValidationError(
            f"未知字典类型：{dict_type}",
            field_errors=[
                {"field": "dict_type", "message": f"仅支持 {'、'.join(DICT_TYPES)}", "type": "value_error"}
            ],
        )
    return dict_type


def get_tree(
    db: Session,
    dict_type: str,
    *,
    parent_id: str | None = None,
    q: str | None = None,
    include_inactive: bool = True,
    limit: int = 500,
) -> list[dict[str, Any]]:
    """左树：默认返回一层节点；给定 ``parent_id`` 懒加载其子节点；``q`` 按名称搜索。"""
    ensure_dict_type(dict_type)
    columns = (
        DictionaryNode.id,
        DictionaryNode.parent_id,
        DictionaryNode.level,
        DictionaryNode.code,
        DictionaryNode.name,
        DictionaryNode.order_no,
        DictionaryNode.is_active,
        DictionaryNode.reference_count,
        DictionaryNode.path,
    )
    stmt = select(*columns).where(DictionaryNode.dict_type == dict_type)
    if not include_inactive:
        stmt = stmt.where(DictionaryNode.is_active.is_(True))
    if q and q.strip():
        keyword = f"%{q.strip()}%"
        stmt = stmt.where(DictionaryNode.name.like(keyword) | DictionaryNode.code.like(keyword))
    elif parent_id:
        stmt = stmt.where(DictionaryNode.parent_id == parent_id)
    else:
        stmt = stmt.where(DictionaryNode.parent_id.is_(None))
    stmt = stmt.order_by(DictionaryNode.level, DictionaryNode.order_no).limit(max(1, min(limit, 2000)))
    rows = db.execute(stmt).all()

    child_counts = dict(
        db.execute(
            select(DictionaryNode.parent_id, func.count())
            .where(DictionaryNode.dict_type == dict_type)
            .group_by(DictionaryNode.parent_id)
        ).all()
    )

    return [
        {
            "id": row[0],
            "dict_type": dict_type,
            "parent_id": row[1],
            "level": row[2],
            "code": row[3],
            "name": row[4],
            "order_no": row[5],
            "is_active": bool(row[6]),
            "reference_count": int(row[7] or 0),
            "path": row[8],
            "child_count": int(child_counts.get(row[0], 0)),
            "has_children": int(child_counts.get(row[0], 0)) > 0,
        }
        for row in rows
    ]


def list_items(
    db: Session,
    dict_type: str,
    *,
    node_id: str | None = None,
    level: int | None = None,
    keyword: str | None = None,
    status: str = "all",
    item_no_min: int | None = None,
    item_no_max: int | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[dict[str, Any]], int]:
    """右表分页：支持 node_id、level、keyword、status 与 item_no 区间过滤。"""
    ensure_dict_type(dict_type)
    page = max(1, page)
    page_size = min(max(1, page_size), 200)

    conditions = [CheckItem.dict_type == dict_type]
    if node_id:
        conditions.append(CheckItem.node_id == node_id)
    if level is not None:
        sub = select(DictionaryNode.id).where(
            DictionaryNode.dict_type == dict_type, DictionaryNode.level == level
        )
        conditions.append(CheckItem.node_id.in_(sub))
    if status == "active":
        conditions.append(CheckItem.is_active.is_(True))
    elif status == "inactive":
        conditions.append(CheckItem.is_active.is_(False))
    if keyword and keyword.strip():
        like = f"%{keyword.strip()}%"
        conditions.append(
            CheckItem.name.like(like) | CheckItem.description.like(like) | CheckItem.source_standard.like(like)
        )
    if item_no_min is not None:
        conditions.append(CheckItem.item_no >= int(item_no_min))
    if item_no_max is not None:
        conditions.append(CheckItem.item_no <= int(item_no_max))

    total = int(
        db.execute(select(func.count()).select_from(CheckItem).where(*conditions)).scalar() or 0
    )
    rows = db.execute(
        select(
            CheckItem.id,
            CheckItem.node_id,
            CheckItem.item_no,
            CheckItem.name,
            CheckItem.description,
            CheckItem.source_standard,
            CheckItem.example,
            CheckItem.image_meta_json,
            CheckItem.severity,
            CheckItem.deduction,
            CheckItem.is_active,
            CheckItem.reference_count,
        )
        .where(*conditions)
        .order_by(CheckItem.item_no, CheckItem.node_id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()

    items = [
        {
            "id": row[0],
            "dict_type": dict_type,
            "node_id": row[1],
            "item_no": row[2],
            "name": row[3],
            "description": row[4],
            "source_standard": row[5],
            "example": row[6],
            "image_meta": _json_list(row[7]),
            "severity": row[8],
            "deduction": row[9],
            "is_active": bool(row[10]),
            "reference_count": int(row[11] or 0),
        }
        for row in rows
    ]
    return items, total


def _json_list(raw: str | None) -> list[Any]:
    try:
        value = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    return value if isinstance(value, list) else []


def summarize(db: Session, dict_type: str) -> dict[str, Any]:
    """层级计数与检查项计数（用于数量验收）。"""
    ensure_dict_type(dict_type)
    level_rows = db.execute(
        select(DictionaryNode.level, func.count())
        .where(DictionaryNode.dict_type == dict_type)
        .group_by(DictionaryNode.level)
    ).all()
    nodes_by_level = {int(level): int(count) for level, count in level_rows}

    active_nodes = int(
        db.execute(
            select(func.count())
            .select_from(DictionaryNode)
            .where(DictionaryNode.dict_type == dict_type, DictionaryNode.is_active.is_(True))
        ).scalar()
        or 0
    )
    check_items = int(
        db.execute(
            select(func.count()).select_from(CheckItem).where(CheckItem.dict_type == dict_type)
        ).scalar()
        or 0
    )
    active_items = int(
        db.execute(
            select(func.count())
            .select_from(CheckItem)
            .where(CheckItem.dict_type == dict_type, CheckItem.is_active.is_(True))
        ).scalar()
        or 0
    )
    numbers = [
        row[0]
        for row in db.execute(
            select(CheckItem.item_no)
            .where(CheckItem.dict_type == dict_type)
            .order_by(CheckItem.item_no)
        ).all()
    ]
    sequence = validate_item_sequence(numbers) if dict_type == DICT_SOFTWARE else None

    counts: dict[str, Any] = {
        "nodes_by_level": nodes_by_level,
        "nodes_total": sum(nodes_by_level.values()),
        "nodes_active": active_nodes,
        "check_items": check_items,
        "check_items_active": active_items,
    }
    if sequence is not None:
        counts["item_min"] = sequence["item_min"]
        counts["item_max"] = sequence["item_max"]
        counts["continuous"] = sequence["continuous"]
        counts["missing"] = sequence["missing"]
        counts["duplicates"] = sequence["duplicates"]
    if dict_type in (DICT_CONTROL_SOFTWARE, DICT_CONTROL_HARDWARE):
        definition_rows = 0
        for (raw,) in db.execute(
            select(CheckItem.raw_json).where(CheckItem.dict_type == dict_type)
        ).all():
            try:
                if json.loads(raw or "{}").get("is_component_definition"):
                    definition_rows += 1
            except (TypeError, ValueError):
                continue
        counts["components"] = nodes_by_level.get(1, 0)
        counts["source_rows"] = check_items
        counts["component_definition_rows"] = definition_rows
        # 细则 = 源表行数 − 组件定义行（46 定义 + 136 细则 = 182 行，D-01）
        counts["details"] = check_items - definition_rows
    if dict_type == DICT_HARDWARE_PRODUCT:
        counts["data_rows"] = check_items

    return {
        "dict_type": dict_type,
        "label": DICT_TYPE_LABELS.get(dict_type, dict_type),
        "counts": counts,
        "expected": expected_counts().get(dict_type, {}),
        "grades": list(GRADE_ORDER),
        "deductions": dict(HARDWARE_SEVERITY_DEDUCTION),
    }


def list_batches(db: Session, *, limit: int = 50) -> list[dict[str, Any]]:
    rows = db.execute(
        select(DictionaryBatch).order_by(DictionaryBatch.created_at.desc(), DictionaryBatch.id).limit(max(1, min(limit, 200)))
    ).scalars().all()
    return [serialize_batch(row) for row in rows]


def serialize_batch(batch: DictionaryBatch) -> dict[str, Any]:
    return {
        "id": batch.id,
        "source_path": batch.source_path,
        "source_sha256": batch.source_sha256,
        "source_size_bytes": batch.source_size_bytes,
        "source_modified_at": _iso(batch.source_modified_at),
        "status": batch.status,
        "dry_run": bool(batch.dry_run),
        "counts": _json_dict(batch.counts_json),
        "expected": _json_dict(batch.expected_json),
        "diff": _json_dict(batch.diff_json),
        "blocked_reason": batch.blocked_reason,
        "notes": batch.notes,
        "created_by_name": batch.created_by_name,
        "created_at": _iso(batch.created_at),
        "finished_at": _iso(batch.finished_at),
    }


def _json_dict(raw: str | None) -> dict[str, Any]:
    try:
        value = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _iso(value: _dt.datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is not None:
        value = value.astimezone(_dt.timezone.utc).replace(tzinfo=None)
    return value.isoformat(timespec="seconds") + "Z"


# --------------------------------------------------------------------------- 维护


def _apply_updates(entity: Any, payload: dict[str, Any], allowed: Iterable[str]) -> dict[str, Any]:
    changed: dict[str, Any] = {}
    for key in allowed:
        if key in payload and payload[key] is not None:
            setattr(entity, key, payload[key])
            changed[key] = payload[key]
    return changed


def update_node(db: Session, node_id: str, payload: dict[str, Any]) -> tuple[DictionaryNode, str]:
    node = db.get(DictionaryNode, node_id)
    if node is None:
        raise NotFoundError(f"字典节点不存在：{node_id}")
    changed = _apply_updates(node, payload, ("name", "note", "source_standard", "example", "is_active"))
    db.commit()
    db.refresh(node)
    message = "已更新字典节点"
    if changed.get("is_active") is False:
        if node.reference_count > 0:
            message = f"已停用；该节点被 {node.reference_count} 处历史引用保留，被引用条目不能物理删除，只能停用。"
        else:
            message = "已停用；条目仍保留在库中（未物理删除），可再次启用。"
    return node, message


def update_item(db: Session, item_id: str, payload: dict[str, Any]) -> tuple[CheckItem, str]:
    item = db.get(CheckItem, item_id)
    if item is None:
        raise NotFoundError(f"检查项不存在：{item_id}")
    changed = _apply_updates(
        item,
        payload,
        ("name", "description", "source_standard", "example", "severity", "deduction", "is_active"),
    )
    db.commit()
    db.refresh(item)
    message = "已更新检查项"
    if changed.get("is_active") is False:
        if item.reference_count > 0:
            message = f"已停用；该检查项被 {item.reference_count} 处历史引用保留，被引用条目不能物理删除，只能停用。"
        else:
            message = "已停用；条目仍保留在库中（未物理删除），可再次启用。"
    return item, message


def serialize_node(node: DictionaryNode) -> dict[str, Any]:
    return {
        "id": node.id,
        "dict_type": node.dict_type,
        "parent_id": node.parent_id,
        "level": node.level,
        "code": node.code,
        "name": node.name,
        "order_no": node.order_no,
        "path": node.path,
        "severity": node.severity,
        "deduction": node.deduction,
        "note": node.note,
        "source_standard": node.source_standard,
        "example": node.example,
        "image_meta": _json_list(node.image_meta_json),
        "is_active": bool(node.is_active),
        "reference_count": int(node.reference_count or 0),
    }


def serialize_item(item: CheckItem) -> dict[str, Any]:
    return {
        "id": item.id,
        "dict_type": item.dict_type,
        "node_id": item.node_id,
        "item_no": item.item_no,
        "name": item.name,
        "description": item.description,
        "source_standard": item.source_standard,
        "example": item.example,
        "image_meta": _json_list(item.image_meta_json),
        "severity": item.severity,
        "deduction": item.deduction,
        "is_active": bool(item.is_active),
        "reference_count": int(item.reference_count or 0),
    }
