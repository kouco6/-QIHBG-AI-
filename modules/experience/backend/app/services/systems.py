"""系统管理与系统合并 UEI（原产品线 L2，v1.1 层级合并）。

层级：事业部 → **系统** → 产品项目（project.system_id 直接挂系统，产品层已取消）。

核心口径：

- 项目通过 ``system_id`` 直挂系统，一个项目只属于一个系统；``project.weight`` 为
  系统合并 UEI 的加权权重（默认 1，可在系统详情调整）；
- 每个系统**绑定一个评分方案版本**；换方案会**自增绑定版本**（``scheme_version``）并留审计，
  历史快照不受影响；
- 系统合并 UEI 提供**三个口径**并列：
  1. 权威口径：系统内每个项目**最新有效 L1 快照**（或按时间窗口 / 版本区间），
     把来源快照的 ``SnapshotIssue`` 按**问题 ID 去重**后，用**系统绑定方案**重算；
  2. **权重加权平均（默认展示口径）**：Σ(项目 UEI × 项目权重) / Σ权重；
  3. 木桶分：系统内项目 UEI 最低值；
- 项目原 L1 快照所用方案 ≠ 系统方案 → 标记「口径外」（仍纳入重算并提示）；
- 样本不足（有效项目 < 2 或去重问题 < 5）→ 输出分值但标注「样本不足」，**不排名、不给结论**；
- 系统快照**筛选条件随快照保存**（``filters_json``），追加写、不可变。
"""

from __future__ import annotations

import datetime as _dt
import json
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import RequestContext
from app.core.errors import ConflictError, ValidationError
from app.core.security import new_id
from app.core.timeutil import iso_z, to_naive_utc, utcnow
from app.domain import scoring as sc
from app.models.account import Account
from app.models.flow import Project
from app.models.scoring import ProjectScoreSnapshot, ScoringScheme, SnapshotIssue
from app.models.systems import (
    SELECTION_LABELS,
    SELECTION_LATEST,
    SELECTION_MODES,
    SELECTION_VERSION,
    SELECTION_WINDOW,
    SYSTEM_ACTIVE,
    SYSTEM_ARCHIVED,
    System,
    SystemSnapshot,
    SystemSnapshotSource,
)
from app.seeds.scoring_schemes import scheme_cell_map
from app.services.common import audit_business, find_by, get_or_404
from app.services.score_library import record_entry
from app.services.scoring import latest_effective_snapshot, read_clamp_zero

SYSTEM_STATUS_LABELS = {SYSTEM_ACTIVE: "启用", SYSTEM_ARCHIVED: "已停用"}

CALIBER_AUTHORITATIVE = (
    "系统 UEI（去重重算，权威）：系统内纳入项目的 SnapshotIssue 并集按问题 ID 去重后，"
    "用系统绑定方案重算；不叠加、不二次乘业务权重。"
)
CALIBER_WEIGHTED = (
    "权重加权平均（默认展示口径）：Σ(项目 UEI × 项目权重) / Σ权重；权重在项目上可配，默认等权。"
)
CALIBER_BUCKET = "木桶分（非权威参考）：系统内项目 UEI 最低值"
CALIBER_CROSS_NOTE = (
    "跨系统对比仅在**同一口径**下进行：均为系统绑定方案的并集重算结果；"
    "不同系统与单项目 L1、事业部 L3 分值不可跨层比较。"
)


def _dec_weight(value: str | None) -> Decimal:
    try:
        w = Decimal(str(value if value is not None else "1"))
    except (InvalidOperation, TypeError):
        return Decimal("1")
    return w if w > 0 else Decimal("1")


# --------------------------------------------------------------------------- 成员（项目）


def active_members(db: Session, system_id: str) -> list[Project]:
    """系统内活跃项目（参与合并 UEI 计算）。"""
    return (
        db.execute(
            select(Project)
            .where(Project.system_id == system_id, Project.status == "active")
            .order_by(Project.created_at)
        )
        .scalars()
        .all()
    )


def all_members(db: Session, system_id: str) -> list[Project]:
    return (
        db.execute(
            select(Project).where(Project.system_id == system_id).order_by(Project.created_at)
        )
        .scalars()
        .all()
    )


def member_payload(db: Session, project: Project, *, with_versions: bool = False) -> dict[str, Any]:
    del with_versions  # v1.1 版本号在项目上，无版本表；参数保留以兼容调用方
    node = None
    for node_candidate in sorted(project.nodes, key=lambda n: n.node_order):
        if node_candidate.status == "in_progress":
            node = node_candidate
            break
    return {
        "id": project.id,
        "system_id": project.system_id,
        "project_id": project.id,
        "project_name": project.name,
        "code": project.code,
        "version_code": project.version_code,
        "weight": project.weight,
        "project_type": project.project_type,
        "owner_text": project.owner_text,
        "status": project.status,
        "current_node_name": node.name if node else "",
    }


# --------------------------------------------------------------------------- 系统读取


def _scheme_binding(db: Session, scheme_id: str) -> dict[str, Any] | None:
    scheme = db.get(ScoringScheme, scheme_id)
    if scheme is None:
        return None
    return {
        "id": scheme.id,
        "code": scheme.code,
        "name": scheme.name,
        "business_ratio": scheme.business_ratio,
        "problem_ratio": scheme.problem_ratio,
        "scheme_version": scheme.scheme_version,
    }


def system_payload(db: Session, system: System) -> dict[str, Any]:
    binding = _scheme_binding(db, system.scheme_id)
    active = active_members(db, system.id)
    return {
        "id": system.id,
        "code": system.code,
        "name": system.name,
        "owner_text": system.owner_text,
        "division_id": system.division_id,
        "status": system.status,
        "status_label": SYSTEM_STATUS_LABELS.get(system.status, system.status),
        "scheme_id": system.scheme_id,
        "scheme_version": system.scheme_version,
        "scheme_code": binding["code"] if binding else "",
        "scheme_name": binding["name"] if binding else "",
        "scheme": binding,
        "note": system.note,
        "member_count": len(all_members(db, system.id)),
        "effective_project_count": len(active),
        "created_at": iso_z(system.created_at),
        "updated_at": iso_z(system.updated_at),
        "updated_by_name": system.updated_by_name,
    }


def list_systems(
    db: Session,
    *,
    keyword: str | None = None,
    status: str | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[System], int]:
    stmt = select(System)
    if keyword:
        like = f"%{keyword.strip()}%"
        stmt = stmt.where(System.name.like(like) | System.code.like(like))
    if status:
        stmt = stmt.where(System.status == status)
    total = int(db.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0)
    rows = (
        db.execute(stmt.order_by(System.updated_at.desc()).offset((page - 1) * page_size).limit(page_size))
        .scalars()
        .all()
    )
    return rows, total


def system_alerts(db: Session, system: System) -> list[dict[str, Any]]:
    """口径外提示。"""
    alerts: list[dict[str, Any]] = []
    for project in active_members(db, system.id):
        snapshot = latest_effective_snapshot(db, project.id)
        if snapshot is not None and snapshot.scheme_id != system.scheme_id:
            alerts.append(
                {
                    "level": "warning",
                    "kind": "out_of_scope",
                    "message": (
                        f"项目「{project.name}」的原 L1 快照使用方案 {snapshot.scheme_code or '未知'}，"
                        f"与系统绑定方案不一致，属口径外；重算时仍按系统绑定方案纳入并集。"
                    ),
                    "project_id": project.id,
                    "project_name": project.name,
                    "system_id": system.id,
                    "system_name": system.name,
                }
            )
    return alerts


def system_detail(db: Session, system: System) -> dict[str, Any]:
    payload = system_payload(db, system)
    payload["members"] = [member_payload(db, row, with_versions=True) for row in all_members(db, system.id)]
    payload["active_members"] = [member_payload(db, row, with_versions=True) for row in active_members(db, system.id)]
    payload["alerts"] = system_alerts(db, system)
    payload["snapshot_history"] = [
        l2_snapshot_summary(row) for row in _recent_snapshots(db, system.id, limit=20)
    ]
    return payload


# --------------------------------------------------------------------------- 系统写入


def create_system(
    db: Session,
    *,
    code: str,
    name: str,
    scheme_id: str,
    owner_text: str = "",
    division_id: str | None = None,
    note: str = "",
    account: Account,
    ctx: RequestContext | None,
) -> System:
    if find_by(db, System, code=code) is not None:
        raise ConflictError(f"系统编码已存在：{code}", code="duplicate_code")
    get_or_404(db, ScoringScheme, scheme_id, "评分方案")
    now = utcnow()
    system = System(
        id=new_id(),
        code=code,
        name=name,
        owner_text=owner_text,
        division_id=division_id,
        scheme_id=scheme_id,
        scheme_version=1,
        status=SYSTEM_ACTIVE,
        note=note,
        created_by=account.id,
        created_by_name=account.name,
        updated_by=account.id,
        updated_by_name=account.name,
        row_version=1,
        created_at=now,
        updated_at=now,
    )
    db.add(system)
    db.commit()
    db.refresh(system)
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="system_created",
        target_type="system",
        target_id=system.id,
        summary=f"创建系统 {system.code}（{system.name}）",
        detail={"code": system.code, "scheme_id": scheme_id},
    )
    return system


def update_system(
    db: Session,
    *,
    system: System,
    payload: Any,
    account: Account,
    ctx: RequestContext | None,
) -> System:
    if payload.name is not None:
        system.name = payload.name
    if payload.owner_text is not None:
        system.owner_text = payload.owner_text
    if payload.division_id is not None:
        system.division_id = payload.division_id
    if payload.note is not None:
        system.note = payload.note
    system.updated_by = account.id
    system.updated_by_name = account.name
    system.row_version = int(system.row_version or 0) + 1
    system.updated_at = utcnow()
    db.commit()
    db.refresh(system)
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="system_updated",
        target_type="system",
        target_id=system.id,
        summary=f"修改系统 {system.code}",
        detail={"code": system.code},
    )
    return system


def archive_system(
    db: Session,
    *,
    system: System,
    reason: str | None,
    account: Account,
    ctx: RequestContext | None,
) -> System:
    active = active_members(db, system.id)
    if active:
        raise ConflictError(
            f"系统下仍有 {len(active)} 个进行中的项目，请先转移或归档项目",
            code="system_has_active_projects",
            extra={"active_project_count": len(active)},
        )
    system.status = SYSTEM_ARCHIVED
    system.updated_by = account.id
    system.updated_by_name = account.name
    system.row_version = int(system.row_version or 0) + 1
    system.updated_at = utcnow()
    db.commit()
    db.refresh(system)
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="system_archived",
        target_type="system",
        target_id=system.id,
        summary=f"停用系统 {system.code}（历史与快照保留）",
        detail={"code": system.code, "reason": reason or ""},
    )
    return system


def attach_project(
    db: Session,
    *,
    system: System,
    project_id: str,
    weight: str | None,
    account: Account,
    ctx: RequestContext | None,
) -> Project:
    """把项目挂到系统下（可携权重；项目已在其他系统时视为转移并留审计）。"""
    project = get_or_404(db, Project, project_id, "项目")
    previous_system_id = project.system_id
    previous = db.get(System, previous_system_id) if previous_system_id else None
    project.system_id = system.id
    if weight is not None:
        w = _dec_weight(weight)
        if w <= 0:
            raise ValidationError(
                "权重必须为正数",
                field_errors=[{"field": "weight", "message": "权重必须为大于 0 的数值", "type": "value_error"}],
            )
        project.weight = str(w)
    project.updated_by = account.id
    project.updated_by_name = account.name
    project.row_version = int(project.row_version or 0) + 1
    project.updated_at = utcnow()
    db.commit()
    db.refresh(project)
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="system_project_attached",
        target_type="system",
        target_id=system.id,
        summary=(
            f"项目「{project.name}」挂入系统 {system.code}（权重 {project.weight}）"
            if previous is None or previous.id == system.id
            else f"项目「{project.name}」从系统 {previous.code} 转入 {system.code}（权重 {project.weight}）"
        ),
        detail={"system_id": system.id, "project_id": project_id, "weight": project.weight,
                "previous_system_id": previous_system_id or ""},
    )
    return project


def set_member_weight(
    db: Session,
    *,
    system: System,
    project_id: str,
    weight: str,
    account: Account,
    ctx: RequestContext | None,
) -> Project:
    """调整系统内项目权重（影响后续权重加权口径与快照）。"""
    project = get_or_404(db, Project, project_id, "项目")
    if project.system_id != system.id:
        raise ConflictError("该项目不属于此系统", code="member_system_mismatch")
    try:
        w = Decimal(str(weight))
    except (InvalidOperation, TypeError):
        raise ValidationError(
            "权重格式不正确",
            field_errors=[{"field": "weight", "message": "请输入数值", "type": "value_error"}],
        ) from None
    if w <= 0:
        raise ValidationError(
            "权重必须为正数",
            field_errors=[{"field": "weight", "message": "权重必须为大于 0 的数值", "type": "value_error"}],
        )
    previous_weight = project.weight
    project.weight = str(w)
    project.updated_by = account.id
    project.updated_by_name = account.name
    project.row_version = int(project.row_version or 0) + 1
    project.updated_at = utcnow()
    db.commit()
    db.refresh(project)
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="system_member_weight_changed",
        target_type="system",
        target_id=system.id,
        summary=f"项目「{project.name}」权重 {previous_weight} → {project.weight}",
        detail={"system_id": system.id, "project_id": project_id,
                "from": previous_weight, "to": project.weight},
    )
    return project


def change_scheme(
    db: Session,
    *,
    system: System,
    scheme_id: str,
    reason: str | None,
    account: Account,
    ctx: RequestContext | None,
) -> System:
    scheme = get_or_404(db, ScoringScheme, scheme_id, "评分方案")
    previous_scheme_id = system.scheme_id
    if previous_scheme_id == scheme_id:
        return system
    previous = db.get(ScoringScheme, previous_scheme_id)
    system.scheme_id = scheme_id
    system.scheme_version = int(system.scheme_version or 0) + 1
    system.updated_by = account.id
    system.updated_by_name = account.name
    system.row_version = int(system.row_version or 0) + 1
    system.updated_at = utcnow()
    db.commit()
    db.refresh(system)
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="system_scheme_changed",
        target_type="system",
        target_id=system.id,
        summary=f"系统 {system.code} 绑定方案变更为 {scheme.code}（绑定版本 {system.scheme_version}）",
        detail={
            "system_id": system.id,
            "from": previous.code if previous else previous_scheme_id,
            "to": scheme.code,
            "scheme_version": system.scheme_version,
            "reason": reason or "",
        },
    )
    return system


# --------------------------------------------------------------------------- 来源选取


def _parse_dt(value: str | None, *, field: str) -> _dt.datetime | None:
    text = (value or "").strip()
    if not text:
        return None
    try:
        parsed = _dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise ValidationError(
            "时间格式不正确",
            field_errors=[{"field": field, "message": "请使用 YYYY-MM-DD 或 ISO 8601 格式", "type": "value_error"}],
        ) from None
    return to_naive_utc(parsed)


def normalize_filters(
    selection_mode: str,
    *,
    from_value: str | None = None,
    to_value: str | None = None,
    version_prefix: str | None = None,
) -> dict[str, Any]:
    mode = (selection_mode or SELECTION_LATEST).strip()
    if mode not in SELECTION_MODES:
        raise ValidationError(
            "来源纳入口径不合法",
            field_errors=[
                {
                    "field": "selection_mode",
                    "message": f"可选值：{' / '.join(SELECTION_MODES)}",
                    "type": "value_error",
                }
            ],
        )
    filters: dict[str, Any] = {"selection_mode": mode}
    if mode == SELECTION_WINDOW:
        if not from_value or not to_value:
            raise ValidationError(
                "时间窗口模式必须提供 from 与 to",
                field_errors=[
                    {"field": "from", "message": "请填写起始时间", "type": "value_error"},
                    {"field": "to", "message": "请填写结束时间", "type": "value_error"},
                ],
            )
        filters["from"] = from_value
        filters["to"] = to_value
    if mode == SELECTION_VERSION:
        if not (version_prefix or "").strip():
            raise ValidationError(
                "版本区间模式必须提供 version_prefix",
                field_errors=[
                    {"field": "version_prefix", "message": "请填写版本前缀，例如 V2.", "type": "value_error"}
                ],
            )
        filters["version_prefix"] = version_prefix.strip()
    return filters


def select_source_snapshot(
    db: Session, *, project_id: str, filters: dict[str, Any]
) -> ProjectScoreSnapshot | None:
    """按筛选条件取单个项目的来源 L1 快照（默认最新一条有效快照）。"""
    mode = filters.get("selection_mode", SELECTION_LATEST)
    stmt = select(ProjectScoreSnapshot).where(
        ProjectScoreSnapshot.project_id == project_id,
        ProjectScoreSnapshot.is_effective.is_(True),
        ProjectScoreSnapshot.scope == "project",
    )
    if mode == SELECTION_WINDOW:
        start = _parse_dt(filters.get("from"), field="from")
        end = _parse_dt(filters.get("to"), field="to")
        if start:
            stmt = stmt.where(ProjectScoreSnapshot.snapshot_at >= start)
        if end:
            stmt = stmt.where(ProjectScoreSnapshot.snapshot_at <= end)
    elif mode == SELECTION_VERSION:
        prefix = str(filters.get("version_prefix") or "").strip()
        stmt = stmt.where(ProjectScoreSnapshot.version_code.like(f"{prefix}%"))
    stmt = stmt.order_by(ProjectScoreSnapshot.snapshot_at.desc(), ProjectScoreSnapshot.created_at.desc())
    return db.execute(stmt).scalars().first()


# --------------------------------------------------------------------------- L2 计算


def _dedupe(entries: list[tuple[ProjectScoreSnapshot, SnapshotIssue]]) -> list[tuple[ProjectScoreSnapshot, SnapshotIssue]]:
    seen: set[str] = set()
    out: list[tuple[ProjectScoreSnapshot, SnapshotIssue]] = []
    for snapshot, issue_row in entries:
        if issue_row.issue_id in seen:
            continue
        seen.add(issue_row.issue_id)
        out.append((snapshot, issue_row))
    return out


def l2_preview(
    db: Session,
    *,
    system: System,
    selection_mode: str = SELECTION_LATEST,
    from_value: str | None = None,
    to_value: str | None = None,
    version_prefix: str | None = None,
    top_n: int = 5,
) -> dict[str, Any]:
    filters = normalize_filters(
        selection_mode, from_value=from_value, to_value=to_value, version_prefix=version_prefix
    )
    scheme = db.get(ScoringScheme, system.scheme_id)
    if scheme is None:
        raise ConflictError("系统绑定的评分方案不存在，无法计算", code="scheme_missing")
    cell_map = scheme_cell_map(db, scheme.id)

    sources: list[dict[str, Any]] = []
    raw_entries: list[tuple[ProjectScoreSnapshot, SnapshotIssue]] = []
    for project in active_members(db, system.id):
        snapshot = select_source_snapshot(db, project_id=project.id, filters=filters)
        if snapshot is None:
            continue
        issue_rows = list(snapshot.issues)
        for issue_row in issue_rows:
            raw_entries.append((snapshot, issue_row))
        sources.append(
            {
                "project": project,
                "snapshot": snapshot,
                "issue_count": len(issue_rows),
            }
        )

    deduped = _dedupe(raw_entries)

    counts: dict[str, int] = {key: 0 for key in sc.CELL_KEYS}
    core = Decimal("0")
    non_core = Decimal("0")
    issues_payload: list[dict[str, Any]] = []
    for snapshot, issue_row in deduped:
        key = sc.cell_key(issue_row.business_level, issue_row.severity)
        if key not in cell_map:
            raise ConflictError(f"系统绑定方案缺少矩阵单元 {key}", code="scheme_cell_missing")
        deduction = Decimal(str(cell_map[key]))
        counts[key] += 1
        if key.startswith("core_"):
            core += deduction
        else:
            non_core += deduction
        issues_payload.append(
            {
                "issue_id": issue_row.issue_id,
                "issue_code": issue_row.issue_code,
                "business_level": issue_row.business_level,
                "severity": issue_row.severity,
                "cell_key": key,
                "deduction": str(deduction),
                "project_id": snapshot.project_id,
                "project_name": snapshot.project_name,
                "module": issue_row.module,
                "metric_l1": issue_row.metric_l1,
            }
        )

    total = core + non_core
    raw_uei = sc.BASE_SCORE - total
    clamp = read_clamp_zero(db)
    display = sc.apply_clamp_zero(raw_uei, clamp)

    # 逐项目（用系统绑定方案统一重算，口径一致）
    project_scores: list[dict[str, Any]] = []
    for source in sources:
        snapshot = source["snapshot"]
        project = source["project"]
        project_core = Decimal("0")
        project_non_core = Decimal("0")
        project_issue_count = 0
        for issue_row in snapshot.issues:
            key = sc.cell_key(issue_row.business_level, issue_row.severity)
            deduction = Decimal(str(cell_map[key]))
            if key.startswith("core_"):
                project_core += deduction
            else:
                project_non_core += deduction
            project_issue_count += 1
        project_uei = sc.BASE_SCORE - (project_core + project_non_core)
        project_scores.append(
            {
                "project_id": snapshot.project_id,
                "project_name": snapshot.project_name,
                "version_code": snapshot.version_code,
                "weight": str(_dec_weight(project.weight)),
                "issue_count": project_issue_count,
                "uei": project_uei,
                "l1_uei": snapshot.display_uei,
                "l1_scheme_code": snapshot.scheme_code,
                "l1_snapshot_id": snapshot.id,
                "is_out_of_scope": snapshot.scheme_id != system.scheme_id,
            }
        )

    # 权重加权平均（默认展示口径）：Σ(项目UEI × 权重) / Σ权重
    total_weight = sum((_dec_weight(item["weight"]) for item in project_scores), Decimal("0"))
    if total_weight > 0:
        weighted = sum(
            (item["uei"] * _dec_weight(item["weight"]) for item in project_scores), Decimal("0")
        ) / total_weight
    else:
        weighted = Decimal("0")
    bucket = min((item["uei"] for item in project_scores), default=Decimal("0"))

    effective_project_count = len(sources)
    outlier_project_count = sum(1 for item in project_scores if item["is_out_of_scope"])
    sample_sufficient = effective_project_count >= 2 and len(deduped) >= 5

    rankings: list[dict[str, Any]] = []
    sample_gap = ""
    if sample_sufficient:
        ordered = sorted(project_scores, key=lambda item: item["uei"])
        rankings = [
            {
                "project_id": item["project_id"],
                "project_name": item["project_name"],
                "project_uei": sc.format_score(item["uei"]),
                "deviation": sc.format_score(item["uei"] - raw_uei),
                "issue_count": item["issue_count"],
            }
            for item in ordered
        ]
    else:
        reasons = []
        if effective_project_count < 2:
            reasons.append(f"有效项目数 {effective_project_count} < 2")
        if len(deduped) < 5:
            reasons.append(f"去重问题数 {len(deduped)} < 5")
        sample_gap = "样本不足：" + "，".join(reasons) + "；仅显示分值，不给结论性评价、不参与排行。"

    # 指标暴露 Top N（按一级指标，其次模块）
    exposure: dict[str, int] = {}
    for item in issues_payload:
        key = item["metric_l1"] or item["module"] or "未分类"
        exposure[key] = exposure.get(key, 0) + 1
    top_exposure = [
        {"key": key, "label": key, "issue_count": count}
        for key, count in sorted(exposure.items(), key=lambda kv: (-kv[1], kv[0]))[: max(1, top_n)]
    ]

    # 版本趋势：按来源快照的版本号分组，重新去重后计算
    trend_groups: dict[str, list[tuple[ProjectScoreSnapshot, SnapshotIssue]]] = {}
    for snapshot, issue_row in raw_entries:
        trend_groups.setdefault(snapshot.version_code or "未标注版本", []).append((snapshot, issue_row))
    trend: list[dict[str, Any]] = []
    for version_code in sorted(trend_groups):
        group = _dedupe(trend_groups[version_code])
        group_deduction = Decimal("0")
        for _snapshot, issue_row in group:
            key = sc.cell_key(issue_row.business_level, issue_row.severity)
            group_deduction += Decimal(str(cell_map[key]))
        trend.append(
            {
                "version_code": version_code,
                "project_count": len({snap.project_id for snap, _ in trend_groups[version_code]}),
                "deduped_issue_count": len(group),
                "uei": sc.format_score(sc.BASE_SCORE - group_deduction),
            }
        )

    source_payload: list[dict[str, Any]] = []
    for item in project_scores:
        source_payload.append(
            {
                "project_id": item["project_id"],
                "project_name": item["project_name"],
                "version_code": item["version_code"],
                "weight": item["weight"],
                "l1_snapshot_id": item["l1_snapshot_id"],
                "l1_scheme_code": item["l1_scheme_code"],
                "l1_uei": item["l1_uei"],
                "is_out_of_scope": item["is_out_of_scope"],
                "issue_count": item["issue_count"],
                "project_uei": sc.format_score(item["uei"]),
            }
        )

    return {
        "system_id": system.id,
        "system_code": system.code,
        "system_name": system.name,
        "status": system.status,
        "scheme": {
            "id": scheme.id,
            "code": scheme.code,
            "name": scheme.name,
            "business_ratio": scheme.business_ratio,
            "problem_ratio": scheme.problem_ratio,
            "scheme_version": scheme.scheme_version,
        },
        "selection_mode": filters["selection_mode"],
        "selection_mode_label": SELECTION_LABELS.get(filters["selection_mode"], filters["selection_mode"]),
        "filters": filters,
        "sources": source_payload,
        "out_of_scope_projects": [item for item in source_payload if item["is_out_of_scope"]],
        "source_snapshot_count": len(sources),
        "effective_project_count": effective_project_count,
        "outlier_project_count": outlier_project_count,
        "raw_issue_count": len(raw_entries),
        "deduped_issue_count": len(deduped),
        "issues": issues_payload,
        "cell_counts": counts,
        "core_deduction": sc.format_score(core),
        "non_core_deduction": sc.format_score(non_core),
        "total_deduction": sc.format_score(total),
        "authoritative_uei": sc.format_score(raw_uei),
        "display_uei": sc.format_score(display),
        "clamp_zero": clamp,
        "auxiliary": {
            # v1.1：weighted_average_uei 即「权重加权平均」（默认展示口径）
            "weighted_average_uei": sc.format_score(weighted),
            "bucket_uei": sc.format_score(bucket),
            "authoritative": False,
            "caliber_weighted": CALIBER_WEIGHTED,
            "caliber_bucket": CALIBER_BUCKET,
        },
        "sample_sufficient": sample_sufficient,
        "sample_gap": sample_gap,
        "rankings": rankings,
        "top_exposure": top_exposure,
        "trend": trend,
        "caliber_note": CALIBER_AUTHORITATIVE,
    }


# --------------------------------------------------------------------------- L2 快照


def _recent_snapshots(db: Session, system_id: str, *, limit: int = 20) -> list[SystemSnapshot]:
    return (
        db.execute(
            select(SystemSnapshot)
            .where(SystemSnapshot.system_id == system_id)
            .order_by(SystemSnapshot.snapshot_at.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )


def l2_snapshot_summary(snapshot: SystemSnapshot) -> dict[str, Any]:
    weighted = snapshot.weighted_average_uei
    return {
        "id": snapshot.id,
        "system_id": snapshot.system_id,
        "system_code": snapshot.system_code,
        "system_name": snapshot.system_name,
        "scheme_id": snapshot.scheme_id,
        "scheme_code": snapshot.scheme_code,
        "selection_mode": snapshot.selection_mode,
        "filters": json.loads(snapshot.filters_json or "{}"),
        "source_snapshot_count": snapshot.source_snapshot_count,
        "effective_project_count": snapshot.effective_project_count,
        "outlier_project_count": snapshot.outlier_project_count,
        "raw_issue_count": snapshot.raw_issue_count,
        "deduped_issue_count": snapshot.deduped_issue_count,
        "core_deduction": snapshot.core_deduction,
        "non_core_deduction": snapshot.non_core_deduction,
        "total_deduction": snapshot.total_deduction,
        "authoritative_uei": snapshot.authoritative_uei,
        "weighted_average_uei": weighted,
        "bucket_uei": snapshot.bucket_uei,
        "sample_sufficient": snapshot.sample_sufficient,
        "cell_counts": json.loads(snapshot.severity_counts_json or "{}"),
        "created_by_name": snapshot.created_by_name,
        "snapshot_at": iso_z(snapshot.snapshot_at),
    }


def l2_snapshot_payload(snapshot: SystemSnapshot, *, with_details: bool = True) -> dict[str, Any]:
    payload = l2_snapshot_summary(snapshot)
    payload["immutable"] = True
    payload["caliber_note"] = CALIBER_AUTHORITATIVE
    payload["auxiliary"] = {
        "weighted_average_uei": snapshot.weighted_average_uei,
        "bucket_uei": snapshot.bucket_uei,
        "authoritative": False,
        "caliber_weighted": CALIBER_WEIGHTED,
        "caliber_bucket": CALIBER_BUCKET,
    }
    payload["sample_gap"] = "" if snapshot.sample_sufficient else "样本不足：分值仅供参考，不给结论性评价、不参与排行。"
    if with_details:
        payload["sources"] = [
            {
                "project_id": row.project_id,
                "project_name": row.project_name,
                "version_code": row.version_code,
                "weight": row.weight,
                "l1_snapshot_id": row.l1_snapshot_id,
                "l1_scheme_code": row.l1_scheme_code,
                "l1_uei": row.l1_uei,
                "is_out_of_scope": row.is_out_of_scope,
                "issue_count": row.issue_count,
                "project_uei": "",
            }
            for row in snapshot.sources
        ]
        trace = json.loads(snapshot.calc_trace_json or "{}")
        payload["issues"] = trace.get("issues", [])
    else:
        payload["sources"] = []
        payload["issues"] = []
    return payload


def create_l2_snapshot(
    db: Session,
    *,
    system: System,
    selection_mode: str,
    from_value: str | None,
    to_value: str | None,
    version_prefix: str | None,
    note: str,
    account: Account,
    ctx: RequestContext | None,
) -> dict[str, Any]:
    preview = l2_preview(
        db,
        system=system,
        selection_mode=selection_mode,
        from_value=from_value,
        to_value=to_value,
        version_prefix=version_prefix,
    )
    now = utcnow()
    snapshot = SystemSnapshot(
        id=new_id(),
        system_id=system.id,
        system_code=system.code,
        system_name=system.name,
        division_id=system.division_id,
        scheme_id=preview["scheme"]["id"],
        scheme_code=preview["scheme"]["code"],
        selection_mode=preview["selection_mode"],
        filters_json=json.dumps(preview["filters"], ensure_ascii=False),
        source_snapshot_count=preview["source_snapshot_count"],
        effective_project_count=preview["effective_project_count"],
        outlier_project_count=preview["outlier_project_count"],
        raw_issue_count=preview["raw_issue_count"],
        deduped_issue_count=preview["deduped_issue_count"],
        core_deduction=preview["core_deduction"],
        non_core_deduction=preview["non_core_deduction"],
        total_deduction=preview["total_deduction"],
        authoritative_uei=preview["authoritative_uei"],
        weighted_average_uei=preview["auxiliary"]["weighted_average_uei"],
        bucket_uei=preview["auxiliary"]["bucket_uei"],
        sample_sufficient=preview["sample_sufficient"],
        severity_counts_json=json.dumps(preview["cell_counts"], ensure_ascii=False),
        project_scores_json=json.dumps(preview["sources"], ensure_ascii=False),
        calc_trace_json=json.dumps(
            {
                "formula": CALIBER_AUTHORITATIVE,
                "weighted_formula": CALIBER_WEIGHTED,
                "dedupe_key": "issue_id",
                "raw_issue_count": preview["raw_issue_count"],
                "deduped_issue_count": preview["deduped_issue_count"],
                "issues": preview["issues"],
                "auxiliary": preview["auxiliary"],
                "sample_sufficient": preview["sample_sufficient"],
                "sample_gap": preview["sample_gap"],
                "note": note,
            },
            ensure_ascii=False,
        ),
        created_by=account.id,
        created_by_name=account.name,
        snapshot_at=now,
    )
    db.add(snapshot)
    for item in preview["sources"]:
        db.add(
            SystemSnapshotSource(
                id=new_id(),
                snapshot_id=snapshot.id,
                project_id=item["project_id"],
                project_name=item["project_name"],
                version_code=item["version_code"],
                weight=item["weight"],
                l1_snapshot_id=item["l1_snapshot_id"],
                l1_scheme_code=item["l1_scheme_code"],
                l1_uei=item["l1_uei"],
                is_out_of_scope=item["is_out_of_scope"],
                issue_count=item["issue_count"],
                created_at=now,
                updated_at=now,
            )
        )
    db.commit()
    db.refresh(snapshot)

    record_entry(
        db,
        level="L2",
        object_type="system",
        object_id=system.id,
        object_name=system.name,
        source_type="system_snapshot",
        source_snapshot_id=snapshot.id,
        score=Decimal(snapshot.authoritative_uei),
        display_score=Decimal(snapshot.authoritative_uei),
        system_id=system.id,
        division_id=system.division_id,
        scheme_ref=snapshot.scheme_code,
        issue_count=snapshot.deduped_issue_count,
        sample_sufficient=snapshot.sample_sufficient,
        status_note="" if snapshot.sample_sufficient else "样本不足",
        snapshot_at=snapshot.snapshot_at,
        created_by_name=account.name,
        extra={"selection_mode": snapshot.selection_mode, "filters": preview["filters"]},
    )

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="l2_snapshot_created",
        target_type="system_snapshot",
        target_id=snapshot.id,
        summary=f"创建系统快照：{system.name} 权威 UEI {snapshot.authoritative_uei}（去重后 {snapshot.deduped_issue_count} 条问题）",
        detail={
            "system_id": system.id,
            "scheme_code": snapshot.scheme_code,
            "selection_mode": snapshot.selection_mode,
            "sample_sufficient": snapshot.sample_sufficient,
        },
    )
    return l2_snapshot_payload(snapshot, with_details=True)


def list_l2_snapshots(
    db: Session,
    *,
    system_id: str | None = None,
    scheme_id: str | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[SystemSnapshot], int]:
    stmt = select(SystemSnapshot)
    if system_id:
        stmt = stmt.where(SystemSnapshot.system_id == system_id)
    if scheme_id:
        stmt = stmt.where(SystemSnapshot.scheme_id == scheme_id)
    total = int(db.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0)
    rows = (
        db.execute(
            stmt.order_by(SystemSnapshot.snapshot_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        .scalars()
        .all()
    )
    return rows, total


def get_l2_snapshot(db: Session, snapshot_id: str) -> SystemSnapshot:
    return get_or_404(db, SystemSnapshot, snapshot_id, "系统快照")


# --------------------------------------------------------------------------- 跨系统对比


def compare_systems(
    db: Session,
    *,
    system_ids: list[str],
    selection_mode: str = SELECTION_LATEST,
    from_value: str | None = None,
    to_value: str | None = None,
    version_prefix: str | None = None,
    top_n: int = 5,
) -> dict[str, Any]:
    """跨系统对比：**只允许 2–5 个**（由请求模型保证，服务层再次校验）。"""
    unique_ids = list(dict.fromkeys(system_ids))
    if not (2 <= len(unique_ids) <= 5):
        raise ValidationError(
            "跨系统对比只允许选择 2–5 个系统",
            field_errors=[
                {
                    "field": "system_ids",
                    "message": f"当前选择 {len(unique_ids)} 个；请选择 2–5 个",
                    "type": "value_error",
                }
            ],
        )

    columns: list[dict[str, Any]] = []
    ranking: list[tuple[Decimal, str]] = []
    excluded: list[dict[str, str]] = []
    for system_id in unique_ids:
        system = get_or_404(db, System, system_id, "系统")
        preview = l2_preview(
            db,
            system=system,
            selection_mode=selection_mode,
            from_value=from_value,
            to_value=to_value,
            version_prefix=version_prefix,
            top_n=top_n,
        )
        enough = preview["sample_sufficient"]
        column = {
            "system_id": system.id,
            "system_code": system.code,
            "system_name": system.name,
            "scheme_code": preview["scheme"]["code"],
            "authoritative_uei": preview["authoritative_uei"],
            "weighted_average_uei": preview["auxiliary"]["weighted_average_uei"],
            "bucket_uei": preview["auxiliary"]["bucket_uei"],
            "sample_sufficient": enough,
            "effective_project_count": preview["effective_project_count"],
            "deduped_issue_count": preview["deduped_issue_count"],
            "outlier_project_count": preview["outlier_project_count"],
            "cell_counts": preview["cell_counts"],
            "top_exposure": preview["top_exposure"],
            "trend": preview["trend"],
            "ranking_excluded": not enough,
            "exclude_reason": "" if enough else preview["sample_gap"],
        }
        columns.append(column)
        if enough:
            ranking.append((Decimal(preview["authoritative_uei"]), system.id))
        else:
            excluded.append({"system_id": system.id, "system_name": system.name, "reason": preview["sample_gap"]})

    ranking.sort(key=lambda item: item[0], reverse=True)
    return {
        "system_count": len(unique_ids),
        "selection_mode": selection_mode,
        "same_caliber_note": CALIBER_CROSS_NOTE,
        "columns": columns,
        "ranking": [system_id for _score, system_id in ranking],
        "excluded_from_ranking": excluded,
        "comparison_note": "样本不足的系统不进入排名并显式标注；禁止把系统分与单项目 L1 分混排比较。",
    }


__all__ = [
    "CALIBER_AUTHORITATIVE",
    "CALIBER_BUCKET",
    "CALIBER_CROSS_NOTE",
    "CALIBER_WEIGHTED",
    "SYSTEM_STATUS_LABELS",
    "active_members",
    "all_members",
    "archive_system",
    "attach_project",
    "change_scheme",
    "compare_systems",
    "create_l2_snapshot",
    "create_system",
    "get_l2_snapshot",
    "l2_preview",
    "l2_snapshot_payload",
    "l2_snapshot_summary",
    "list_l2_snapshots",
    "list_systems",
    "member_payload",
    "normalize_filters",
    "select_source_snapshot",
    "set_member_weight",
    "system_alerts",
    "system_detail",
    "system_payload",
    "update_system",
]
