#!/usr/bin/env python
"""UEI 源工作簿字典导入（T06）。

用法（在**仓库根**执行）::

    python scripts/import_uei_workbook.py --dry-run            # 默认：干跑预检，不写字典数据
    python scripts/import_uei_workbook.py --apply              # 真实导入（幂等）
    python scripts/import_uei_workbook.py --apply --source "G:/.../x.xlsx"
    python scripts/import_uei_workbook.py --dry-run --db-url "sqlite:///E:/tmp/x.db"

行为约定
--------
- 源工作簿**只读**打开；记录源路径、大小、SHA-256、mtime 到 ``DictionaryBatch``。
- 干跑把实测计数与期望计数（33/114/15/224/46 组件 + 136 细则/182 源行）逐项比对写入
  ``counts_json``/``expected_json``/``diff_json``；不一致时 ``status=failed`` 且
  ``--apply`` 拒绝执行（退出码 1）。
- 源不可读时批次 ``status=blocked``，``blocked_reason`` 写明解除条件，退出码 2；
  **不写入任何伪造数据**。
- 幂等：节点按 ``(dict_type, code)``、检查项按 ``(dict_type, node_id, item_no)``
  去重，重复执行不产生重复行；旧批次条目只停用不物理删除。

退出码：0 成功；1 计数不一致/导入失败；2 源不可读（BLOCKED）；3 环境不可用。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Sequence

# --- 允许在仓库根直接执行：把 backend 加入模块搜索路径 ---
REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_BLOCKED = 2
EXIT_ENV_ERROR = 3

SOURCE_UNAVAILABLE_HINT = (
    "BLOCKED：源工作簿不可读。解除条件：确认 G 盘源文件存在且当前进程有读权限，"
    "或用 --source 指定可读的等效副本（SHA-256 "
    "3ac4727b218ed86ee212021039508f1a98cd45978fa8f4593ffb4b96b0624e26）。"
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="import_uei_workbook",
        description="从只读 UEI 源工作簿导入 5 类体验字典（T06）",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="干跑预检（默认）：只读源、比对计数、不写字典数据")
    mode.add_argument("--apply", action="store_true", help="真实导入（幂等）")
    parser.add_argument("--db-url", default="", help="数据库 URL；默认读取应用配置（settings.database_url）")
    parser.add_argument("--source", default="", help="源工作簿绝对路径；默认取源清单 SRC-UEI-WORKBOOK")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出结果")
    parser.add_argument("--actor", default="cli:import_uei_workbook", help="写入批次的创建人标识")
    return parser


def _load_app():
    """延迟导入应用模块（保证 backend 已在 sys.path 上）。"""
    from app.core.config import settings  # noqa: PLC0415
    from app.services import dictionary as service  # noqa: PLC0415

    return settings, service


def _make_engine(db_url: str):
    from sqlalchemy import create_engine, event

    engine = create_engine(
        db_url,
        echo=False,
        future=True,
        pool_pre_ping=True,
        connect_args={"check_same_thread": False, "timeout": 30} if db_url.startswith("sqlite") else {},
    )
    if db_url.startswith("sqlite"):
        @event.listens_for(engine, "connect")
        def _pragmas(dbapi_connection, _record):  # noqa: ANN001
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA busy_timeout=30000")
            cursor.close()

    # 幂等补齐字典表（迁移未执行时仍可安全运行）
    from app.models import Base  # noqa: PLC0415

    Base.metadata.create_all(engine, checkfirst=True)
    return engine


def resolve_source(explicit: str, service: Any) -> str:
    """解析源路径：显式参数优先，否则读源清单。"""
    if explicit:
        return explicit
    return service.manifest_source_path()


def run(*, db_url: str, source: str, apply: bool, actor: str) -> tuple[int, dict[str, Any]]:
    """执行预检或导入，返回 ``(退出码, 结果)``。"""
    from app.core.errors import AppError, BlockedError

    settings, service = _load_app()
    url = db_url or settings.database_url
    mode = "apply" if apply else "dry-run"

    engine = _make_engine(url)
    from sqlalchemy.orm import Session  # noqa: PLC0415

    try:
        with Session(engine) as db:
            try:
                batch = (
                    service.run_import(db, source_path=source, actor_name=actor)
                    if apply
                    else service.run_precheck(db, source_path=source, actor_name=actor)
                )
            except BlockedError as exc:
                return EXIT_BLOCKED, {
                    "mode": mode,
                    "status": "blocked",
                    "source": source,
                    "db_url": url,
                    "blocked_reason": exc.message,
                    "hint": SOURCE_UNAVAILABLE_HINT,
                    "counts": {},
                    "expected": service.expected_counts(),
                    "exit_code": EXIT_BLOCKED,
                }
            except AppError as exc:
                return EXIT_FAILED, {
                    "mode": mode,
                    "status": "failed",
                    "source": source,
                    "db_url": url,
                    "error": {"code": exc.code, "message": exc.message},
                    "counts": exc.extra.get("diff", {}),
                    "exit_code": EXIT_FAILED,
                }
            serialized = service.serialize_batch(batch)
            return EXIT_OK, {
                "mode": mode,
                "status": serialized["status"],
                "batch_id": serialized["id"],
                "source": serialized["source_path"],
                "source_sha256": serialized["source_sha256"],
                "source_size_bytes": serialized["source_size_bytes"],
                "db_url": url,
                "counts": serialized["counts"],
                "expected": serialized["expected"],
                "diff": serialized["diff"],
                "notes": serialized["notes"],
                "exit_code": EXIT_OK,
            }
    finally:
        engine.dispose()


def emit(result: dict[str, Any], as_json: bool) -> None:
    if as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return
    status = result.get("status", "unknown")
    print(f"字典导入[{result.get('mode')}] status={status}")
    print(f"  源：{result.get('source')}")
    if result.get("source_sha256"):
        print(f"  SHA-256：{result['source_sha256']}（大小 {result.get('source_size_bytes')} B）")
    counts = result.get("counts") or {}
    if counts and counts.get("ok") is not None:
        print(f"  计数核对：{'通过' if counts.get('ok') else '不一致'}")
    elif isinstance(counts, dict) and counts:
        printable = {k: v for k, v in counts.items() if k in {"software", "hardware", "hardware_product", "control_software", "control_hardware"}}
        if printable:
            print("  实测计数：" + json.dumps(printable, ensure_ascii=False))
    if status == "blocked":
        print(f"  阻塞原因：{result.get('blocked_reason')}")
        print(f"  {result.get('hint')}")
    if status == "failed":
        print(f"  失败原因：{json.dumps(result.get('error'), ensure_ascii=False)}")
        print(f"  差异：{json.dumps(result.get('counts'), ensure_ascii=False)}")
    print(f"  退出码：{result.get('exit_code')}")


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    apply_mode = bool(args.apply)
    try:
        explicit_source = args.source
        _settings, service = _load_app()
        source = resolve_source(explicit_source, service)
    except Exception as exc:  # noqa: BLE001 - 环境不可用统一退出码 3
        print(json.dumps({"status": "env_error", "error": str(exc), "exit_code": EXIT_ENV_ERROR}, ensure_ascii=False))
        return EXIT_ENV_ERROR

    try:
        code, result = run(db_url=args.db_url, source=source, apply=apply_mode, actor=args.actor)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"status": "env_error", "error": str(exc), "exit_code": EXIT_ENV_ERROR}, ensure_ascii=False))
        return EXIT_ENV_ERROR

    emit(result, args.json)
    return code


if __name__ == "__main__":
    sys.exit(main())
