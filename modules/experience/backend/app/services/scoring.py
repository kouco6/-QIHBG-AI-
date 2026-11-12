"""UEI 评分方案、逐问题可解释计算、L1 预览与不可变快照（T08）。

核心口径（PRD §8.1–§8.6 / DESIGN §7）：

- 矩阵是**数据**：业务计算只读 ``scoring_scheme_cell``，不读 ``domain.scoring.MATRIX``；
- 单问题扣分**已含业务权重**，任何情况下**不得二次乘 80%/20%**；
- 全程 ``decimal.Decimal`` 十进制定点运算，展示保留 1 位小数（``quantize``）；
- UEI 允许为负；「最低封 0」为系统设置 ``uei.clamp_zero``（默认 **关闭**，运行期读取，
  不得硬编码）；快照同时保存 ``raw_uei``（数学值）与 ``display_uei``（展示值）；
- 快照**追加写、不可变**：不提供更新/删除动作；
- 产品归属多条产品线且绑定方案不同 → **方案冲突**：预览标记，且**禁止创建新的有效快照**。
"""

from __future__ import annotations

import datetime as _dt
import json
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import RequestContext
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.core.security import new_id
from app.core.timeutil import iso_z, utcnow
from app.domain import scoring as sc
from app.models.account import Account
from app.models.flow import Project
from app.models.issue import Issue
from app.models.systems import SYSTEM_ACTIVE, System
from app.models.scoring import (
    SNAPSHOT_SCOPE_PROJECT,
    ProjectScoreSnapshot,
    ScoringScheme,
    ScoringSchemeCell,
    SnapshotIssue,
)
from app.models.system import SystemSetting
from app.seeds.scoring_schemes import default_scheme, scheme_cell_map
from app.services.common import audit_business, get_or_404
from app.services.score_library import record_entry

CLAMP_ZERO_KEY = "uei.clamp_zero"

SCHEME_SOURCE_LABELS: dict[str, str] = {
    "explicit": "显式指定方案",
    "system": "系统绑定方案",
    "default": "默认方案",
    "conflict": "多线方案冲突（暂用默认方案预览）",
}

CALIBER_NOTE = (
    "单产品 UEI = 100 −（核心业务扣分 + 非核心业务扣分）；"
    "每条问题按「业务等级 × 问题等级」命中唯一矩阵单元，矩阵值已含业务权重，不再乘业务比。"
)


# --------------------------------------------------------------------------- 十进制工具


def parse_decimal(value: Any, *, field: str, label: str) -> Decimal:
    """解析十进制字符串；非法或负数抛 422（含字段级错误）。"""
    try:
        parsed = Decimal(str(value).strip())
    except (InvalidOperation, ValueError, TypeError):
        raise ValidationError(
            f"{label}必须为十进制数字",
            field_errors=[{"field": field, "message": f"请填写合法的十进制{label}", "type": "value_error"}],
        ) from None
    if not parsed.is_finite():
        raise ValidationError(
            f"{label}必须为有限十进制数字",
            field_errors=[{"field": field, "message": "不允许 NaN / Infinity", "type": "value_error"}],
        )
    return parsed


def _fmt(score: Decimal) -> str:
    return sc.format_score(score)


# --------------------------------------------------------------------------- 系统设置


def read_clamp_zero(db: Session) -> bool:
    """读取「最低封 0」开关（默认关闭；运行期从 ``system_setting`` 读取，不硬编码）。"""
    row = db.get(SystemSetting, CLAMP_ZERO_KEY)
    if row is None:
        from app.core.config import settings as app_settings

        return bool(app_settings.uei_clamp_zero_default)
    return str(row.value).strip().lower() in {"1", "true", "yes", "on"}


# --------------------------------------------------------------------------- 方案读取


def scheme_cells(db: Session, scheme_id: str) -> list[ScoringSchemeCell]:
    return (
        db.execute(
            select(ScoringSchemeCell)
            .where(ScoringSchemeCell.scheme_id == scheme_id)
            .order_by(ScoringSchemeCell.cell_order)
        )
        .scalars()
        .all()
    )


def scheme_reference_counts(db: Session, scheme_id: str) -> dict[str, int]:
    """方案引用数：L1 快照 / 产品线绑定 / L2 快照。"""
    from app.models.systems import SystemSnapshot

    snapshots = int(
        db.execute(
            select(func.count())
            .select_from(ProjectScoreSnapshot)
            .where(ProjectScoreSnapshot.scheme_id == scheme_id)
        ).scalar()
        or 0
    )
    lines = int(
        db.execute(
            select(func.count()).select_from(System).where(System.scheme_id == scheme_id)
        ).scalar()
        or 0
    )
    line_snapshots = int(
        db.execute(
            select(func.count())
            .select_from(SystemSnapshot)
            .where(SystemSnapshot.scheme_id == scheme_id)
        ).scalar()
        or 0
    )
    return {
        "snapshot_reference_count": snapshots,
        "line_reference_count": lines,
        "line_snapshot_reference_count": line_snapshots,
        "reference_count": snapshots + lines + line_snapshots,
    }


def scheme_payload(db: Session, scheme: ScoringScheme, *, with_cells: bool) -> dict[str, Any]:
    cells = scheme_cells(db, scheme.id)
    counts = scheme_reference_counts(db, scheme.id)
    referenced = counts["reference_count"] > 0
    payload: dict[str, Any] = {
        "id": scheme.id,
        "code": scheme.code,
        "name": scheme.name,
        "business_ratio": scheme.business_ratio,
        "problem_ratio": scheme.problem_ratio,
        "scheme_version": scheme.scheme_version,
        "is_default": scheme.is_default,
        "is_active": scheme.is_active,
        "is_builtin": scheme.is_builtin,
        "note": scheme.note,
        "cell_count": len(cells),
        "reference_count": counts["reference_count"],
        "snapshot_reference_count": counts["snapshot_reference_count"],
        "line_reference_count": counts["line_reference_count"],
        "is_referenced": referenced,
        "read_only": referenced,
        "read_only_reason": "被引用的方案版本不可修改，请复制新版本" if referenced else "",
        "created_at": iso_z(scheme.created_at),
        "updated_at": iso_z(scheme.updated_at),
        "cells": [],
    }
    if with_cells:
        payload["cells"] = [
            {
                "cell_key": cell.cell_key,
                "business_level": cell.business_level,
                "severity": cell.severity,
                "cell_order": cell.cell_order,
                "deduction": cell.deduction,
                "display_deduction": _fmt(Decimal(cell.deduction)),
            }
            for cell in cells
        ]
    return payload


def list_schemes(
    db: Session,
    *,
    keyword: str | None = None,
    include_inactive: bool = True,
    with_cells: bool = False,
) -> list[dict[str, Any]]:
    stmt = select(ScoringScheme)
    if not include_inactive:
        stmt = stmt.where(ScoringScheme.is_active.is_(True))
    if keyword:
        like = f"%{keyword.strip()}%"
        stmt = stmt.where(ScoringScheme.name.like(like) | ScoringScheme.code.like(like))
    rows = db.execute(stmt.order_by(ScoringScheme.business_ratio, ScoringScheme.problem_ratio)).scalars().all()
    return [scheme_payload(db, row, with_cells=with_cells) for row in rows]


# --------------------------------------------------------------------------- 方案写入


def _validate_cells(cells: list[Any]) -> dict[str, Decimal]:
    """校验 8 个单元：键完整且唯一、扣分为非负十进制。"""
    if len(cells) != len(sc.CELL_KEYS):
        raise ValidationError(
            f"方案必须提供完整的 {len(sc.CELL_KEYS)} 个矩阵单元",
            field_errors=[
                {
                    "field": "cells",
                    "message": f"需要 {len(sc.CELL_KEYS)} 个单元，实际 {len(cells)} 个",
                    "type": "value_error",
                }
            ],
        )
    parsed: dict[str, Decimal] = {}
    for item in cells:
        key = str(getattr(item, "cell_key", "")).strip()
        if key not in sc.CELL_KEYS:
            raise ValidationError(
                "矩阵单元键不合法",
                field_errors=[{"field": "cells", "message": f"未知的矩阵单元：{key}", "type": "value_error"}],
            )
        if key in parsed:
            raise ValidationError(
                "业务等级与问题等级组合必须唯一",
                field_errors=[{"field": "cells", "message": f"矩阵单元重复：{key}", "type": "value_error"}],
            )
        value = parse_decimal(getattr(item, "deduction", None), field="cells", label="扣分值")
        if value < 0:
            raise ValidationError(
                "矩阵单元扣分不得为负",
                field_errors=[
                    {"field": "cells", "message": f"单元 {key} 的扣分值不能为负", "type": "value_error"}
                ],
            )
        parsed[key] = value
    if set(parsed) != set(sc.CELL_KEYS):
        raise ValidationError(
            "矩阵单元不完整",
            field_errors=[
                {"field": "cells", "message": "必须覆盖 8 个「业务等级 × 问题等级」组合", "type": "value_error"}
            ],
        )
    return parsed


def _write_cells(db: Session, scheme_id: str, cells: dict[str, Decimal]) -> None:
    now = utcnow()
    for order, ((business_level, severity), key) in enumerate(zip(sc.CELL_ORDER, sc.CELL_KEYS, strict=True)):
        db.add(
            ScoringSchemeCell(
                id=new_id(),
                scheme_id=scheme_id,
                cell_key=key,
                business_level=business_level,
                severity=severity,
                cell_order=order,
                deduction=str(cells[key]),
                created_at=now,
                updated_at=now,
            )
        )


def create_scheme(
    db: Session,
    *,
    payload: Any,
    account: Account,
    ctx: RequestContext | None,
) -> dict[str, Any]:
    """创建方案 / 新方案版本（仅首账号，鉴权在 API 层）。"""
    code = (payload.code or "").strip() or sc.scheme_code(payload.business_ratio, payload.problem_ratio)
    if db.execute(select(ScoringScheme).where(ScoringScheme.code == code)).scalars().first() is not None:
        raise ConflictError(f"方案编码已存在：{code}", code="duplicate_code")

    duplicate = (
        db.execute(
            select(ScoringScheme).where(
                ScoringScheme.business_ratio == payload.business_ratio,
                ScoringScheme.problem_ratio == payload.problem_ratio,
                ScoringScheme.is_builtin.is_(False),
            )
        )
        .scalars()
        .first()
    )
    if duplicate is not None:
        raise ConflictError(
            f"业务比 / 问题比组合已存在：{payload.business_ratio} / {payload.problem_ratio}",
            code="duplicate_combination",
            extra={"existing_scheme_id": duplicate.id, "existing_scheme_code": duplicate.code},
        )

    cells = _validate_cells(list(payload.cells))
    now = utcnow()
    scheme = ScoringScheme(
        id=new_id(),
        code=code,
        name=payload.name,
        business_ratio=payload.business_ratio,
        problem_ratio=payload.problem_ratio,
        scheme_version=1,
        is_default=False,
        is_active=True,
        is_builtin=False,
        note=payload.note,
        created_by=account.id,
        created_by_name=account.name,
        updated_by=account.id,
        updated_by_name=account.name,
        row_version=1,
        created_at=now,
        updated_at=now,
    )
    db.add(scheme)
    _write_cells(db, scheme.id, cells)
    db.commit()
    db.refresh(scheme)

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="scoring_scheme_created",
        target_type="scoring_scheme",
        target_id=scheme.id,
        summary=f"创建评分方案 {scheme.code}（{scheme.business_ratio} / {scheme.problem_ratio}）",
        detail={"code": scheme.code, "business_ratio": scheme.business_ratio, "problem_ratio": scheme.problem_ratio},
    )
    return scheme_payload(db, scheme, with_cells=True)


def update_scheme(
    db: Session,
    *,
    scheme_id: str,
    payload: Any,
    account: Account,
    ctx: RequestContext | None,
) -> dict[str, Any]:
    scheme = get_or_404(db, ScoringScheme, scheme_id, "评分方案")
    counts = scheme_reference_counts(db, scheme.id)
    if counts["reference_count"] > 0:
        raise ConflictError(
            "被引用的方案版本不可修改，请复制新版本",
            code="scheme_referenced",
            extra={"scheme_id": scheme.id, "reference_count": counts["reference_count"]},
        )

    if payload.name is not None:
        scheme.name = payload.name
    if payload.note is not None:
        scheme.note = payload.note
    if payload.is_active is not None:
        if not payload.is_active and scheme.is_default:
            raise ConflictError("默认方案不可停用，请先切换默认方案", code="default_scheme_readonly")
        scheme.is_active = payload.is_active
    if payload.cells is not None:
        cells = _validate_cells(list(payload.cells))
        for row in scheme_cells(db, scheme.id):
            db.delete(row)
        db.flush()
        _write_cells(db, scheme.id, cells)

    scheme.updated_by = account.id
    scheme.updated_by_name = account.name
    scheme.row_version = int(scheme.row_version or 0) + 1
    scheme.updated_at = utcnow()
    db.commit()
    db.refresh(scheme)

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="scoring_scheme_updated",
        target_type="scoring_scheme",
        target_id=scheme.id,
        summary=f"修改评分方案 {scheme.code}",
        detail={"code": scheme.code},
    )
    return scheme_payload(db, scheme, with_cells=True)


def set_default_scheme(
    db: Session,
    *,
    scheme_id: str,
    account: Account,
    ctx: RequestContext | None,
) -> dict[str, Any]:
    scheme = get_or_404(db, ScoringScheme, scheme_id, "评分方案")
    if not scheme.is_active:
        raise ConflictError("已停用的方案不能设为默认", code="scheme_inactive")
    for row in db.execute(select(ScoringScheme).where(ScoringScheme.is_default.is_(True))).scalars().all():
        row.is_default = False
    scheme.is_default = True
    scheme.updated_by = account.id
    scheme.updated_by_name = account.name
    scheme.updated_at = utcnow()
    db.commit()
    db.refresh(scheme)

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="scoring_scheme_set_default",
        target_type="scoring_scheme",
        target_id=scheme.id,
        summary=f"将 {scheme.code} 设为默认评分方案",
        detail={"code": scheme.code},
    )
    return scheme_payload(db, scheme, with_cells=True)


def archive_scheme(
    db: Session,
    *,
    scheme_id: str,
    account: Account,
    ctx: RequestContext | None,
    reason: str | None = None,
) -> dict[str, Any]:
    scheme = get_or_404(db, ScoringScheme, scheme_id, "评分方案")
    if scheme.is_default:
        raise ConflictError("默认方案不可停用，请先切换默认方案", code="default_scheme_readonly")
    scheme.is_active = False
    scheme.updated_by = account.id
    scheme.updated_by_name = account.name
    scheme.updated_at = utcnow()
    db.commit()
    db.refresh(scheme)

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="scoring_scheme_archived",
        target_type="scoring_scheme",
        target_id=scheme.id,
        summary=f"停用评分方案 {scheme.code}（不物理删除）",
        detail={"code": scheme.code, "reason": reason or ""},
    )
    return scheme_payload(db, scheme, with_cells=True)


# --------------------------------------------------------------------------- 方案解析


def system_of_project(db: Session, project_id: str | None) -> System | None:
    """项目所属的活动系统（v1.1：项目直挂系统，产品层已取消）。"""
    if not project_id:
        return None
    project = db.get(Project, project_id)
    if project is None:
        return None
    system = project.system
    if system is not None and system.status == SYSTEM_ACTIVE:
        return system
    return None


def resolve_scheme(
    db: Session,
    *,
    project_id: str | None,
    scheme_id: str | None = None,
) -> tuple[ScoringScheme, dict[str, Any]]:
    """解析计算所用方案。

    规则（v1.1：项目直挂系统）：

    1. 显式传 ``scheme_id`` → 优先使用；
    2. 否则项目所属系统绑定方案 → 用系统绑定方案；
    3. 未挂系统（或系统已停用）→ 默认方案。
    """
    if scheme_id:
        scheme = get_or_404(db, ScoringScheme, scheme_id, "评分方案")
        return scheme, {
            "source": "explicit",
            "scheme_conflict": False,
            "conflict_lines": [],
            "lines": [],
        }

    system = system_of_project(db, project_id)
    if system is not None:
        scheme = db.get(ScoringScheme, system.scheme_id)
        if scheme is not None:
            return scheme, {
                "source": "system",
                "scheme_conflict": False,
                "conflict_lines": [],
                "lines": [],
            }

    fallback = default_scheme(db)
    if fallback is None:
        raise ConflictError("缺少默认评分方案，无法预览", code="no_default_scheme")
    return fallback, {"source": "default", "scheme_conflict": False, "conflict_lines": [], "lines": []}


# --------------------------------------------------------------------------- 问题分类


def effective_classification(issue: Issue) -> tuple[str | None, str | None, str]:
    """问题的有效分类：优先评审后最终分类，未确认时退回当前分类。"""
    final_business = (issue.final_business_level or "").strip()
    final_severity = (issue.final_severity or "").strip()
    if final_business in sc.BUSINESS_LEVELS and final_severity in sc.SEVERITY_LEVELS:
        return final_business, final_severity, "final"

    business = (issue.business_level or "").strip()
    severity = (issue.severity or "").strip()
    if business in sc.BUSINESS_LEVELS and severity in sc.SEVERITY_LEVELS:
        return business, severity, "current"
    return None, None, "invalid"


def load_classified_issues(
    db: Session, *, project_id: str, version_code: str | None = None
) -> tuple[list[dict[str, Any]], int]:
    """取出项目下具有完整分类的问题；返回 ``(entries, excluded_count)``。

    ``version_code`` 目前仅预留（v1.1 问题无独立版本维度，全部纳入）。
    """
    del version_code
    rows = db.execute(select(Issue).where(Issue.project_id == project_id).order_by(Issue.code)).scalars().all()
    entries: list[dict[str, Any]] = []
    excluded = 0
    for issue in rows:
        business, severity, source = effective_classification(issue)
        if business is None or severity is None:
            excluded += 1
            continue
        entries.append(
            {
                "issue": issue,
                "business_level": business,
                "severity": severity,
                "classification_source": source,
            }
        )
    return entries, excluded


# --------------------------------------------------------------------------- 计算


def compute_from_classifications(
    entries: list[dict[str, Any]], cell_map: dict[str, str]
) -> dict[str, Any]:
    """按矩阵单元计算扣分与 UEI（Decimal 全程）。

    ``entries`` 每项需含 ``business_level`` / ``severity``；``deduction`` 命中单元。
    """
    counts: dict[str, int] = {key: 0 for key in sc.CELL_KEYS}
    core = Decimal("0")
    non_core = Decimal("0")
    items: list[dict[str, Any]] = []
    for entry in entries:
        business = entry["business_level"]
        severity = entry["severity"]
        key = sc.cell_key(business, severity)
        if key not in cell_map:
            raise ConflictError(
                f"方案缺少矩阵单元 {key}，无法计算",
                code="scheme_cell_missing",
                extra={"cell_key": key},
            )
        deduction = Decimal(str(cell_map[key]))
        counts[key] += 1
        if key.startswith("core_"):
            core += deduction
        else:
            non_core += deduction
        items.append(
            {
                "cell_key": key,
                "business_level": business,
                "severity": severity,
                "deduction": deduction,
            }
        )
    total = core + non_core
    raw = sc.BASE_SCORE - total
    return {
        "cell_counts": counts,
        "core_deduction": core,
        "non_core_deduction": non_core,
        "total_deduction": total,
        "raw_uei": raw,
        "items": items,
    }


def _issue_trace_item(entry: dict[str, Any], computed: dict[str, Any]) -> dict[str, Any]:
    issue: Issue = entry["issue"]
    return {
        "issue_id": issue.id,
        "issue_code": issue.code,
        "description": issue.description,
        "business_level": entry["business_level"],
        "severity": entry["severity"],
        "cell_key": computed["cell_key"],
        "deduction": str(computed["deduction"]),
        "module": issue.module,
        "metric_l1": issue.metric_l1,
        "classification_source": entry["classification_source"],
    }


# --------------------------------------------------------------------------- 预览


def preview_score(
    db: Session,
    *,
    project_id: str,
    scheme_id: str | None = None,
    version_id: str | None = None,
) -> dict[str, Any]:
    del version_id  # v1.1 版本号在项目上；参数保留以兼容调用方
    project = get_or_404(db, Project, project_id, "项目")
    system = project.system
    scheme, meta = resolve_scheme(db, project_id=project.id, scheme_id=scheme_id)
    cell_map = scheme_cell_map(db, scheme.id)
    entries, excluded = load_classified_issues(db, project_id=project.id)
    result = compute_from_classifications(entries, cell_map)

    clamp = read_clamp_zero(db)
    raw = result["raw_uei"]
    display = sc.apply_clamp_zero(raw, clamp)

    issues: list[dict[str, Any]] = []
    for entry, computed in zip(entries, result["items"], strict=True):
        issues.append(_issue_trace_item(entry, computed))

    version_code = project.version_code

    return {
        "project_id": project.id,
        "system_id": project.system_id,
        "system_name": system.name if system else "",
        "version_code": version_code,
        "division_id": project.division_id or (system.division_id if system else None),
        "scheme": {
            "id": scheme.id,
            "code": scheme.code,
            "name": scheme.name,
            "business_ratio": scheme.business_ratio,
            "problem_ratio": scheme.problem_ratio,
            "scheme_version": scheme.scheme_version,
        },
        "scheme_source": meta["source"],
        "scheme_source_label": SCHEME_SOURCE_LABELS.get(meta["source"], meta["source"]),
        "scheme_conflict": meta["scheme_conflict"],
        "conflict_lines": meta["conflict_lines"],
        "cell_counts": result["cell_counts"],
        "cell_labels": dict(sc.CELL_LABELS),
        "issues": issues,
        "core_deduction": _fmt(result["core_deduction"]),
        "non_core_deduction": _fmt(result["non_core_deduction"]),
        "total_deduction": _fmt(result["total_deduction"]),
        "raw_uei": _fmt(raw),
        "display_uei": _fmt(display),
        "clamp_zero": clamp,
        "issue_count": len(entries),
        "excluded_issue_count": excluded,
        "caliber_note": CALIBER_NOTE,
    }


# --------------------------------------------------------------------------- L1 快照


def create_l1_snapshot(
    db: Session,
    *,
    project_id: str,
    scheme_id: str | None,
    version_id: str | None,
    account: Account,
    ctx: RequestContext | None,
) -> dict[str, Any]:
    """创建 L1 快照（追加写、不可变）。冲突方案 → 409。"""
    preview = preview_score(db, project_id=project_id, scheme_id=scheme_id, version_id=version_id)
    if preview["scheme_conflict"]:
        raise ConflictError(
            "方案冲突，禁止创建新的有效快照",
            code="scheme_conflict",
            extra={"conflict_lines": preview["conflict_lines"]},
        )

    project = get_or_404(db, Project, project_id, "项目")
    system = project.system
    scheme_id_resolved = preview["scheme"]["id"]
    scheme = get_or_404(db, ScoringScheme, scheme_id_resolved, "评分方案")
    cell_map = scheme_cell_map(db, scheme.id)

    version_code = preview["version_code"]
    division_id = preview["division_id"]

    now = utcnow()
    snapshot = ProjectScoreSnapshot(
        id=new_id(),
        scope=SNAPSHOT_SCOPE_PROJECT,
        project_id=project.id,
        project_name=project.name,
        version_code=version_code,
        division_id=division_id,
        scheme_id=scheme.id,
        scheme_code=scheme.code,
        scheme_business_ratio=scheme.business_ratio,
        scheme_problem_ratio=scheme.problem_ratio,
        issue_count=preview["issue_count"],
        core_issue_count=sum(count for key, count in preview["cell_counts"].items() if key.startswith("core_")),
        non_core_issue_count=sum(
            count for key, count in preview["cell_counts"].items() if key.startswith("non_core_")
        ),
        severity_counts_json=json.dumps(preview["cell_counts"], ensure_ascii=False),
        core_deduction=preview["core_deduction"],
        non_core_deduction=preview["non_core_deduction"],
        total_deduction=preview["total_deduction"],
        raw_uei=preview["raw_uei"],
        display_uei=preview["display_uei"],
        clamp_zero=preview["clamp_zero"],
        is_effective=True,
        input_manifest_json=json.dumps(
            {
                "project_id": project.id,
                "system_id": project.system_id,
                "version_code": version_code,
                "scheme_id": scheme.id,
                "scheme_source": preview["scheme_source"],
                "issue_ids": [item["issue_id"] for item in preview["issues"]],
                "excluded_issue_count": preview["excluded_issue_count"],
            },
            ensure_ascii=False,
        ),
        calc_trace_json=json.dumps(
            {
                "formula": "UEI = 100 − Σ逐问题单项扣分（矩阵值已含业务权重，不二次乘业务权重）",
                "cell_map": cell_map,
                "cell_counts": preview["cell_counts"],
                "core_deduction": preview["core_deduction"],
                "non_core_deduction": preview["non_core_deduction"],
                "total_deduction": preview["total_deduction"],
                "raw_uei": preview["raw_uei"],
                "display_uei": preview["display_uei"],
                "clamp_zero": preview["clamp_zero"],
                "issue_trace": [
                    {
                        "issue_id": item["issue_id"],
                        "cell_key": item["cell_key"],
                        "deduction": item["deduction"],
                    }
                    for item in preview["issues"]
                ],
            },
            ensure_ascii=False,
        ),
        created_by=account.id,
        created_by_name=account.name,
        snapshot_at=now,
    )
    db.add(snapshot)
    for item in preview["issues"]:
        db.add(
            SnapshotIssue(
                id=new_id(),
                snapshot_id=snapshot.id,
                issue_id=item["issue_id"],
                issue_code=item["issue_code"],
                business_level=item["business_level"],
                severity=item["severity"],
                cell_key=item["cell_key"],
                deduction=item["deduction"],
                module=item["module"],
                metric_l1=item["metric_l1"],
                description_digest=(item["description"] or "")[:255],
                source_snapshot_id=None,
                created_at=now,
                updated_at=now,
            )
        )
    db.commit()
    db.refresh(snapshot)

    record_entry(
        db,
        level="L1",
        object_type="project",
        object_id=snapshot.project_id,
        object_name=snapshot.project_name,
        source_type="project_score_snapshot",
        source_snapshot_id=snapshot.id,
        score=Decimal(snapshot.raw_uei),
        display_score=Decimal(snapshot.display_uei),
        version_code=snapshot.version_code,
        project_id=snapshot.project_id,
        division_id=snapshot.division_id,
        scheme_ref=snapshot.scheme_code,
        issue_count=snapshot.issue_count,
        snapshot_at=snapshot.snapshot_at,
        created_by_name=account.name,
        extra={"project_id": project.id, "scope": "project"},
    )

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="l1_snapshot_created",
        target_type="project_score_snapshot",
        target_id=snapshot.id,
        summary=f"创建 L1 快照：{snapshot.project_name} {snapshot.version_code} UEI {snapshot.display_uei}",
        detail={
            "scheme_code": snapshot.scheme_code,
            "issue_count": snapshot.issue_count,
            "display_uei": snapshot.display_uei,
        },
    )
    return snapshot_payload(db, snapshot, with_issues=True, with_trace=True)


# --------------------------------------------------------------------------- 快照读取


def _snapshot_issue_rows(db: Session, snapshot_id: str) -> list[SnapshotIssue]:
    return (
        db.execute(select(SnapshotIssue).where(SnapshotIssue.snapshot_id == snapshot_id).order_by(SnapshotIssue.issue_code))
        .scalars()
        .all()
    )


def snapshot_summary(snapshot: ProjectScoreSnapshot) -> dict[str, Any]:
    return {
        "id": snapshot.id,
        "scope": snapshot.scope,
        "project_id": snapshot.project_id,
        "project_name": snapshot.project_name,
        "version_code": snapshot.version_code,
        "division_id": snapshot.division_id,
        "scheme_id": snapshot.scheme_id,
        "scheme_code": snapshot.scheme_code,
        "scheme_business_ratio": snapshot.scheme_business_ratio,
        "scheme_problem_ratio": snapshot.scheme_problem_ratio,
        "issue_count": snapshot.issue_count,
        "core_issue_count": snapshot.core_issue_count,
        "non_core_issue_count": snapshot.non_core_issue_count,
        "cell_counts": json.loads(snapshot.severity_counts_json or "{}"),
        "core_deduction": snapshot.core_deduction,
        "non_core_deduction": snapshot.non_core_deduction,
        "total_deduction": snapshot.total_deduction,
        "raw_uei": snapshot.raw_uei,
        "display_uei": snapshot.display_uei,
        "clamp_zero": snapshot.clamp_zero,
        "is_effective": snapshot.is_effective,
        "created_by_name": snapshot.created_by_name,
        "snapshot_at": iso_z(snapshot.snapshot_at),
    }


def snapshot_payload(
    db: Session,
    snapshot: ProjectScoreSnapshot,
    *,
    with_issues: bool = True,
    with_trace: bool = False,
) -> dict[str, Any]:
    payload = snapshot_summary(snapshot)
    payload["immutable"] = True
    payload["caliber_note"] = CALIBER_NOTE
    payload["issues"] = [
        {
            "issue_id": row.issue_id,
            "issue_code": row.issue_code,
            "business_level": row.business_level,
            "severity": row.severity,
            "cell_key": row.cell_key,
            "deduction": row.deduction,
            "module": row.module,
            "metric_l1": row.metric_l1,
            "description_digest": row.description_digest,
        }
        for row in _snapshot_issue_rows(db, snapshot.id)
    ] if with_issues else []
    if with_trace:
        payload["input_manifest"] = json.loads(snapshot.input_manifest_json or "{}")
        payload["calc_trace"] = json.loads(snapshot.calc_trace_json or "{}")
    else:
        payload["input_manifest"] = {}
        payload["calc_trace"] = {}
    return payload


def list_snapshots(
    db: Session,
    *,
    project_id: str | None = None,
    scheme_id: str | None = None,
    is_effective: bool | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[ProjectScoreSnapshot], int]:
    stmt = select(ProjectScoreSnapshot).where(ProjectScoreSnapshot.scope == SNAPSHOT_SCOPE_PROJECT)
    if project_id:
        stmt = stmt.where(ProjectScoreSnapshot.project_id == project_id)
    if scheme_id:
        stmt = stmt.where(ProjectScoreSnapshot.scheme_id == scheme_id)
    if is_effective is not None:
        stmt = stmt.where(ProjectScoreSnapshot.is_effective.is_(is_effective))
    total = int(db.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0)
    rows = (
        db.execute(
            stmt.order_by(ProjectScoreSnapshot.snapshot_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        .scalars()
        .all()
    )
    return rows, total


def get_snapshot(db: Session, snapshot_id: str) -> ProjectScoreSnapshot:
    return get_or_404(db, ProjectScoreSnapshot, snapshot_id, "评分快照")


def latest_effective_snapshot(db: Session, project_id: str) -> ProjectScoreSnapshot | None:
    """项目最新一条有效 L1 快照（按 snapshot_at 降序第一条）。"""
    return (
        db.execute(
            select(ProjectScoreSnapshot)
            .where(
                ProjectScoreSnapshot.project_id == project_id,
                ProjectScoreSnapshot.scope == SNAPSHOT_SCOPE_PROJECT,
                ProjectScoreSnapshot.is_effective.is_(True),
            )
            .order_by(ProjectScoreSnapshot.snapshot_at.desc(), ProjectScoreSnapshot.created_at.desc())
        )
        .scalars()
        .first()
    )


__all__ = [
    "CALIBER_NOTE",
    "CLAMP_ZERO_KEY",
    "SCHEME_SOURCE_LABELS",
    "system_of_project",
    "archive_scheme",
    "compute_from_classifications",
    "create_l1_snapshot",
    "create_scheme",
    "effective_classification",
    "get_snapshot",
    "latest_effective_snapshot",
    "list_schemes",
    "list_snapshots",
    "load_classified_issues",
    "parse_decimal",
    "preview_score",
    "read_clamp_zero",
    "resolve_scheme",
    "scheme_cells",
    "scheme_payload",
    "scheme_reference_counts",
    "set_default_scheme",
    "snapshot_payload",
    "snapshot_summary",
    "update_scheme",
]
