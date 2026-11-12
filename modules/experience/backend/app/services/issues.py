"""统一问题实体服务（T07）。

覆盖 DESIGN §6.2.2「问题中心 / 问题详情」、§6.6「问题」状态机与 PRD §7.2 字段口径：

- **一次录入多视图呈现**：来源引用只追加 ``issue.source_refs_json`` 并累加
  ``reference_count``，不做实体复制；
- **代录强制留痕**：事业部回复 / 承诺版本 / 解决方案必须挂 ``ProxyRecord``，
  缺 ``actual_provider`` 一律 422；``proxy_by`` / ``proxy_at`` 由服务端生成；
- **评审前分类与评审后最终分类分别保存**，并提供矩阵命中预览（读数据库方案）。
"""

from __future__ import annotations

import datetime as _dt
import json
from typing import Any

from sqlalchemy import Select, case, or_, select
from sqlalchemy.orm import Session

from app.api.deps import RequestContext
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.core.security import new_id
from app.core.timeutil import iso_z, utcnow
from app.domain import scoring as sc
from app.domain import states as st
from app.models.account import Account
from app.models.flow import Division, Project
from app.models.issue import (
    PROXY_TARGET_ISSUE_COMMITMENT,
    PROXY_TARGET_ISSUE_REPLY,
    PROXY_TARGET_ISSUE_SOLUTION,
    PROXY_TARGET_LABELS,
    Issue,
    IssueAcceptance,
    IssueTransition,
    ProxyRecord,
)
from app.models.provider import (
    JOB_TYPE_ISSUE_SYNC,
    MODE_MOCK,
    PROVIDER_FEISHU,
    ProviderJob,
)
from app.models.review import DECISION_STATUS_OPEN, ReviewDecision
from app.models.scoring import ScoringScheme, ScoringSchemeCell
from app.services.common import (
    audit_business,
    check_row_version,
    get_or_404,
    mark_created,
    paginate,
    require_reason,
    touch,
)

# 来源引用类型（PRD §7.2 硬性规则 1：原型、UI、自查、测试、评审共用同一问题 ID）
REF_LABELS: dict[str, str] = {
    "artifact": "产物",
    "review": "评审",
    "usability": "可用性测试",
    "prototype": "原型报告",
    "ui": "UI 报告",
}
REF_TYPES: tuple[str, ...] = tuple(REF_LABELS)

PAGE_SIZES: tuple[int, ...] = (20, 50, 100)
DEFAULT_PAGE_SIZE = 50

# 列表默认排序：状态优先级（待我处理优先）+ 更新时间倒序（DESIGN §6.2.2 问题中心）
_STATUS_PRIORITY: dict[str, int] = {
    st.ISSUE_PENDING_ACCEPTANCE: 0,
    st.ISSUE_PENDING_CONFIRM: 1,
    st.ISSUE_PENDING_REPLY: 2,
    st.ISSUE_IN_PROGRESS: 3,
    st.ISSUE_REJECTED: 4,
    st.ISSUE_DRAFT: 5,
    st.ISSUE_ACCEPTED: 6,
    st.ISSUE_CLOSED: 7,
}

ACTIONS_REQUIRING_REASON: tuple[str, ...] = ("return", "reject", "reopen")


# --------------------------------------------------------------------------- 编码


def generate_issue_code(db: Session, project: Project) -> str:
    """生成稳定问题编号 ``ISS-{项目code}-{4 位序号}``，全库唯一。"""
    prefix = f"ISS-{project.code}-"
    existing = set(
        db.execute(select(Issue.code).where(Issue.code.like(f"{prefix}%"))).scalars().all()
    )
    seq = 1
    while f"{prefix}{seq:04d}" in existing:
        seq += 1
    return f"{prefix}{seq:04d}"


# --------------------------------------------------------------------------- 校验


def _level_problems(business_level: str | None, severity: str | None) -> list[dict[str, str]]:
    problems: list[dict[str, str]] = []
    if business_level is not None and business_level not in sc.BUSINESS_LEVELS:
        problems.append(
            {
                "field": "business_level",
                "message": "业务等级必须为 core（核心业务）或 non_core（非核心业务）",
                "type": "value_error",
            }
        )
    if severity is not None and severity not in sc.SEVERITY_LEVELS:
        problems.append(
            {
                "field": "severity",
                "message": "问题等级必须为 fatal / major / normal / minor（致命/严重/一般/轻微）",
                "type": "value_error",
            }
        )
    return problems


def _require(problems: list[dict[str, str]], message: str) -> None:
    if problems:
        raise ValidationError(message, field_errors=problems)


# --------------------------------------------------------------------------- 来源引用


def parse_refs(raw: str | None) -> list[dict[str, Any]]:
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return data if isinstance(data, list) else []


def add_ref(
    db: Session,
    *,
    issue: Issue,
    ref_type: str,
    ref_id: str,
    label: str,
    account: Account,
    ctx: RequestContext | None = None,
) -> dict[str, Any]:
    """追加来源引用并累加 ``reference_count``（同 ref_type+ref_id 不重复计数）。"""
    ref_type = (ref_type or "").strip()
    if ref_type not in REF_LABELS:
        raise ValidationError(
            "来源引用类型非法",
            field_errors=[
                {
                    "field": "ref_type",
                    "message": f"ref_type 必须是 {'/'.join(REF_TYPES)} 之一",
                    "type": "value_error",
                }
            ],
        )
    refs = parse_refs(issue.source_refs_json)
    key = (ref_type, ref_id)
    if not any((r.get("ref_type"), r.get("ref_id")) == key for r in refs):
        refs.append(
            {
                "ref_type": ref_type,
                "ref_id": ref_id,
                "label": label or "",
                "label_cn": REF_LABELS.get(ref_type, ref_type),
                "added_at": iso_z(utcnow()),
                "added_by_name": account.name,
            }
        )
        issue.reference_count = int(issue.reference_count or 0) + 1
    issue.source_refs_json = json.dumps(refs, ensure_ascii=False)
    touch(issue, account)
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="issue_ref_added",
        target_type="issue",
        target_id=issue.id,
        summary=f"问题 {issue.code} 追加来源引用 {REF_LABELS.get(ref_type, ref_type)}",
        detail={
            "issue_code": issue.code,
            "ref_type": ref_type,
            "ref_id": ref_id,
            "reference_count": issue.reference_count,
        },
        commit=False,
    )
    db.commit()
    return {"reference_count": issue.reference_count, "source_refs": refs}


# --------------------------------------------------------------------------- 创建


def _enrich_from_project(
    db: Session,
    project: Project,
    *,
    division_id: str | None,
) -> str | None:
    """系统 / 事业部带出（v1.1：项目直挂系统）。"""
    del db
    resolved_division = division_id
    if not resolved_division:
        resolved_division = project.division_id
    if not resolved_division and project.system is not None:
        resolved_division = project.system.division_id  # 由系统自动带出事业部
    return resolved_division


def create_issue(
    db: Session,
    *,
    account: Account,
    payload: Any,
    ctx: RequestContext | None = None,
) -> Issue:
    project = get_or_404(db, Project, payload.project_id, "项目")

    problems = _level_problems(payload.business_level, payload.severity)
    if not (payload.description or "").strip():
        problems.append({"field": "description", "message": "请填写问题描述", "type": "value_error"})
    if not (payload.module or "").strip():
        problems.append({"field": "module", "message": "请填写所属模块", "type": "value_error"})
    _require(problems, "问题创建校验失败")

    division_id = _enrich_from_project(
        db,
        project,
        division_id=payload.division_id,
    )

    refs = [
        {
            "ref_type": r.ref_type,
            "ref_id": r.ref_id,
            "label": r.label,
            "label_cn": REF_LABELS.get(r.ref_type, r.ref_type),
            "added_at": iso_z(utcnow()),
            "added_by_name": account.name,
        }
        for r in (payload.source_refs or [])
        if r.ref_type in REF_LABELS
    ]

    issue = Issue(
        id=new_id(),
        code=generate_issue_code(db, project),
        project_id=project.id,
        system_id=project.system_id,
        division_id=division_id,
        module=payload.module.strip(),
        description=payload.description.strip(),
        business_level=payload.business_level,
        severity=payload.severity,
        metric_l1=payload.metric_l1 or "",
        metric_l2=payload.metric_l2 or "",
        metric_l3=payload.metric_l3 or "",
        check_item_no=payload.check_item_no,
        issue_type=payload.issue_type or "",
        owner_text=payload.owner_text or "",
        status=st.ISSUE_DRAFT,
        pre_business_level=payload.business_level,
        pre_severity=payload.severity,
        note=payload.note or "",
        source_refs_json=json.dumps(refs, ensure_ascii=False),
        reference_count=len(refs),
        is_proxy=False,
        row_version=1,
    )
    mark_created(issue, account)
    db.add(issue)
    db.flush()

    db.add(
        IssueTransition(
            id=new_id(),
            issue_id=issue.id,
            action="create",
            from_status="",
            to_status=st.ISSUE_DRAFT,
            reason="",
            detail_json=json.dumps({"business_level": issue.business_level, "severity": issue.severity}),
            actor_account_id=account.id,
            actor_name=account.name,
        )
    )
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="issue_created",
        target_type="issue",
        target_id=issue.id,
        summary=f"新建问题 {issue.code}",
        detail={
            "issue_code": issue.code,
            "project_id": project.id,
            "business_level": issue.business_level,
            "severity": issue.severity,
            "module": issue.module,
            "reference_count": issue.reference_count,
        },
        commit=False,
    )
    db.commit()
    db.refresh(issue)
    return issue


# --------------------------------------------------------------------------- 查询


def _parse_updated_from(value: str | None) -> _dt.datetime | None:
    if not value:
        return None
    text = value.strip().replace("Z", "")
    try:
        parsed = _dt.datetime.fromisoformat(text)
    except ValueError:
        raise ValidationError(
            "updated_from 时间格式非法",
            field_errors=[
                {"field": "updated_from", "message": "请使用 YYYY-MM-DD 或 ISO 时间", "type": "value_error"}
            ],
        ) from None
    return parsed


def build_issue_query(filters: dict[str, Any]) -> Select[Any]:
    stmt = select(Issue)
    if filters.get("project_id"):
        stmt = stmt.where(Issue.project_id == filters["project_id"])
    if filters.get("status"):
        stmt = stmt.where(Issue.status == filters["status"])
    if filters.get("business_level"):
        stmt = stmt.where(Issue.business_level == filters["business_level"])
    if filters.get("severity"):
        stmt = stmt.where(Issue.severity == filters["severity"])
    if filters.get("division_id"):
        stmt = stmt.where(Issue.division_id == filters["division_id"])
    if filters.get("module"):
        stmt = stmt.where(Issue.module.like(f"%{filters['module']}%"))
    if filters.get("metric_l1"):
        stmt = stmt.where(Issue.metric_l1 == filters["metric_l1"])
    if filters.get("keyword"):
        like = f"%{filters['keyword']}%"
        stmt = stmt.where(or_(Issue.description.like(like), Issue.code.like(like), Issue.module.like(like)))
    updated_from = _parse_updated_from(filters.get("updated_from"))
    if updated_from is not None:
        stmt = stmt.where(Issue.updated_at >= updated_from)
    return stmt


def _priority_order() -> Any:
    return case(_STATUS_PRIORITY, value=Issue.status, else_=99)


def _load_maps(db: Session, rows: list[Issue]) -> dict[str, dict[str, Any]]:
    system_ids = {r.system_id for r in rows if r.system_id}
    division_ids = {r.division_id for r in rows if r.division_id}
    return {
        "systems": {
            s.id: s for s in db.execute(select(System).where(System.id.in_(system_ids))).scalars()
        }
        if system_ids
        else {},
        "divisions": {
            d.id: d
            for d in db.execute(select(Division).where(Division.id.in_(division_ids))).scalars()
        }
        if division_ids
        else {},
    }


def issue_row(issue: Issue, maps: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    maps = maps or {}
    system = maps.get("systems", {}).get(issue.system_id)
    division = maps.get("divisions", {}).get(issue.division_id)
    refs = parse_refs(issue.source_refs_json)
    return {
        "id": issue.id,
        "code": issue.code,
        "description": issue.description,
        "project_id": issue.project_id,
        "project_name": issue.project.name if issue.project is not None else "",
        "system_id": issue.system_id,
        "system_name": system.name if system is not None else "",
        "division_id": issue.division_id,
        "division_name": division.name if division is not None else "",
        "business_level": issue.business_level,
        "business_level_label": sc.BUSINESS_LEVEL_LABELS.get(issue.business_level, issue.business_level),
        "severity": issue.severity,
        "severity_label": sc.SEVERITY_LABELS.get(issue.severity, issue.severity),
        "metric_l1": issue.metric_l1,
        "metric_l2": issue.metric_l2,
        "metric_l3": issue.metric_l3,
        "module": issue.module,
        "issue_type": issue.issue_type,
        "status": issue.status,
        "status_label": st.ISSUE_STATUS_LABELS.get(issue.status, issue.status),
        "owner_text": issue.owner_text,
        "source_labels": sorted({r.get("label_cn") or REF_LABELS.get(r.get("ref_type"), r.get("ref_type")) for r in refs}),
        "source_refs": refs,
        "reference_count": issue.reference_count,
        "is_proxy": issue.is_proxy,
        "updated_at": iso_z(issue.updated_at),
        "updated_by_name": issue.updated_by_name,
        "row_version": issue.row_version,
    }


def list_issues(
    db: Session,
    *,
    filters: dict[str, Any],
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> dict[str, Any]:
    if page_size not in PAGE_SIZES:
        page_size = DEFAULT_PAGE_SIZE
    stmt = build_issue_query(filters).order_by(_priority_order(), Issue.updated_at.desc())
    rows, total = paginate(db, stmt, page=page, page_size=page_size)
    maps = _load_maps(db, list(rows))
    return {
        "page": max(1, page),
        "page_size": page_size,
        "total": total,
        "items": [issue_row(r, maps) for r in rows],
        "filter_options": {
            "statuses": [
                {"value": s, "label": st.ISSUE_STATUS_LABELS[s]} for s in st.ISSUE_STATUSES
            ],
            "business_levels": [
                {"value": b, "label": sc.BUSINESS_LEVEL_LABELS[b]} for b in sc.BUSINESS_LEVELS
            ],
            "severities": [
                {"value": s, "label": sc.SEVERITY_LABELS[s]} for s in sc.SEVERITY_LEVELS
            ],
        },
    }


# --------------------------------------------------------------------------- 矩阵命中预览


def resolve_effective_scheme(db: Session, issue: Issue) -> tuple[ScoringScheme | None, dict[str, Any]]:
    """解析问题当前生效方案：项目所属系统绑定方案 → 默认方案（v1.1）。"""
    meta: dict[str, Any] = {
        "source": "default",
        "has_conflict": False,
        "conflict_lines": [],
        "conflict_message": "",
    }
    project = issue.project
    if project is not None and project.system is not None:
        system = project.system
        scheme = db.get(ScoringScheme, system.scheme_id)
        if scheme is not None:
            meta.update(
                {
                    "source": "system",
                    "system_id": system.id,
                    "system_name": system.name,
                }
            )
            return scheme, meta

    default = (
        db.execute(
            select(ScoringScheme).where(
                ScoringScheme.is_default.is_(True), ScoringScheme.is_active.is_(True)
            )
        )
        .scalars()
        .first()
    )
    return default, meta


def matrix_preview(db: Session, issue: Issue) -> dict[str, Any]:
    scheme, meta = resolve_effective_scheme(db, issue)
    basis = "final" if issue.final_classified_at is not None else "current"
    business_level = (
        issue.final_business_level if basis == "final" and issue.final_business_level else issue.business_level
    )
    severity = issue.final_severity if basis == "final" and issue.final_severity else issue.severity

    key = sc.cell_key(business_level, severity)
    deduction: str | None = None
    if scheme is not None:
        cell = (
            db.execute(
                select(ScoringSchemeCell).where(
                    ScoringSchemeCell.scheme_id == scheme.id, ScoringSchemeCell.cell_key == key
                )
            )
            .scalars()
            .first()
        )
        if cell is not None:
            deduction = cell.deduction

    payload: dict[str, Any] = {
        "scheme_id": scheme.id if scheme else None,
        "scheme_code": scheme.code if scheme else "",
        "scheme_name": scheme.name if scheme else "",
        "scheme_business_ratio": scheme.business_ratio if scheme else "",
        "scheme_problem_ratio": scheme.problem_ratio if scheme else "",
        "is_default": bool(scheme.is_default) if scheme else False,
        "business_level": business_level,
        "severity": severity,
        "cell_key": key,
        "cell_label": sc.CELL_LABELS.get(key, key),
        "deduction": deduction,
        "deduction_display": sc.format_score(deduction) if deduction is not None else "",
        "basis": basis,
        "has_conflict": meta["has_conflict"],
        "conflict_message": meta["conflict_message"],
        "conflict_lines": meta["conflict_lines"],
        "scheme_source": meta["source"],
        "severity_definition": sc.SEVERITY_DEFINITIONS.get(severity, ""),
    }
    return payload


# --------------------------------------------------------------------------- 详情


def _proxy_payload(proxy: ProxyRecord) -> dict[str, Any]:
    return {
        "id": proxy.id,
        "target_type": proxy.target_type,
        "target_type_label": PROXY_TARGET_LABELS.get(proxy.target_type, proxy.target_type),
        "field_key": proxy.field_key,
        "actual_provider": proxy.actual_provider,
        "provider_department": proxy.provider_department,
        "proxy_by": proxy.proxy_by,
        "proxy_by_name": proxy.proxy_by_name,
        "proxy_at": iso_z(proxy.proxy_at),
        "source_note": proxy.source_note,
        # 代录标识：界面据此区分自填与代录
        "is_proxy": True,
    }


def issue_detail(db: Session, issue: Issue) -> dict[str, Any]:
    maps = _load_maps(db, [issue])
    payload = issue_row(issue, maps)

    proxies = sorted(issue.proxies, key=lambda p: p.created_at or utcnow())
    proxy_fields = {p.field_key: True for p in proxies}
    payload.update(
        {
            "pre_business_level": issue.pre_business_level,
            "pre_business_level_label": sc.BUSINESS_LEVEL_LABELS.get(
                issue.pre_business_level, issue.pre_business_level
            ),
            "pre_severity": issue.pre_severity,
            "pre_severity_label": sc.SEVERITY_LABELS.get(issue.pre_severity, issue.pre_severity),
            "final_business_level": issue.final_business_level,
            "final_business_level_label": sc.BUSINESS_LEVEL_LABELS.get(
                issue.final_business_level, issue.final_business_level
            ),
            "final_severity": issue.final_severity,
            "final_severity_label": sc.SEVERITY_LABELS.get(issue.final_severity, issue.final_severity),
            "final_classified_at": iso_z(issue.final_classified_at),
            "final_classified_by": issue.final_classified_by,
            "division_reply": issue.division_reply,
            "solution": issue.solution,
            "committed_version": issue.committed_version,
            "actual_version": issue.actual_version,
            "first_replied_at": iso_z(issue.first_replied_at),
            "closed_at": iso_z(issue.closed_at),
            "note": issue.note,
            "check_item_no": issue.check_item_no,
            "created_at": iso_z(issue.created_at),
            "created_by_name": issue.created_by_name,
            "classification_diff": {
                "pre": {
                    "business_level": issue.pre_business_level,
                    "severity": issue.pre_severity,
                },
                "final": {
                    "business_level": issue.final_business_level,
                    "severity": issue.final_severity,
                },
                "changed": bool(
                    issue.final_classified_at
                    and (
                        issue.final_business_level != issue.pre_business_level
                        or issue.final_severity != issue.pre_severity
                    )
                ),
            },
            # 代录：字段级 is_proxy 标识 + 完整代录记录
            "proxy_fields": {
                "division_reply": bool(proxy_fields.get("division_reply")),
                "solution": bool(proxy_fields.get("solution")),
                "committed_version": bool(proxy_fields.get("committed_version")),
            },
            "proxy_records": [_proxy_payload(p) for p in proxies],
            "timeline": [
                {
                    "id": t.id,
                    "action": t.action,
                    "from_status": t.from_status,
                    "from_status_label": st.ISSUE_STATUS_LABELS.get(t.from_status, t.from_status),
                    "to_status": t.to_status,
                    "to_status_label": st.ISSUE_STATUS_LABELS.get(t.to_status, t.to_status),
                    "reason": t.reason,
                    "detail": json.loads(t.detail_json or "{}"),
                    "actor_name": t.actor_name,
                    "created_at": iso_z(t.created_at),
                }
                for t in issue.transitions
            ],
            "acceptances": [
                {
                    "id": a.id,
                    "result": a.result,
                    "result_label": "通过" if a.result == "accepted" else "驳回",
                    "evidence": a.evidence,
                    "reason": a.reason,
                    "tested_version": a.tested_version,
                    "actor_name": a.actor_name,
                    "created_at": iso_z(a.created_at),
                }
                for a in issue.acceptances
            ],
            "matrix_preview": matrix_preview(db, issue),
            "allowed_actions": list(st.allowed_actions("issue", issue.status)),
        }
    )
    return payload


# --------------------------------------------------------------------------- 更新


def update_issue(
    db: Session,
    *,
    issue: Issue,
    payload: Any,
    account: Account,
    ctx: RequestContext | None = None,
) -> Issue:
    check_row_version(issue, payload.expected_version, "问题")

    problems = _level_problems(payload.business_level, payload.severity)
    _require(problems, "问题更新校验失败")

    changed: dict[str, Any] = {}
    simple_fields = (
        "description",
        "owner_text",
        "metric_l1",
        "metric_l2",
        "metric_l3",
        "issue_type",
        "note",
        "module",
        "check_item_no",
    )
    for field in simple_fields:
        value = getattr(payload, field)
        if value is None:
            continue
        new_value = value.strip() if isinstance(value, str) else value
        if getattr(issue, field) != new_value:
            changed[field] = {"before": getattr(issue, field), "after": new_value}
            setattr(issue, field, new_value)

    for field in ("business_level", "severity"):
        value = getattr(payload, field)
        if value is None:
            continue
        if getattr(issue, field) != value:
            changed[field] = {"before": getattr(issue, field), "after": value}
            setattr(issue, field, value)

    if payload.division_id is not None and payload.division_id != issue.division_id:
        changed["division_id"] = {"before": issue.division_id, "after": payload.division_id}
        issue.division_id = payload.division_id

    final_applied = False
    if payload.final_business_level is not None or payload.final_severity is not None or payload.confirm_final:
        final_applied = _apply_final_classification(
            db,
            issue,
            business_level=payload.final_business_level,
            severity=payload.final_severity,
            account=account,
            changed=changed,
        )

    if not changed:
        return issue

    touch(issue, account)
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="issue_updated",
        target_type="issue",
        target_id=issue.id,
        summary=f"更新问题 {issue.code}",
        detail={"issue_code": issue.code, "changed": changed, "final_applied": final_applied},
        commit=False,
    )
    db.commit()
    db.refresh(issue)
    return issue


def _apply_final_classification(
    db: Session,
    issue: Issue,
    *,
    business_level: str | None,
    severity: str | None,
    account: Account,
    changed: dict[str, Any],
) -> bool:
    problems = _level_problems(business_level, severity)
    _require(problems, "最终分类校验失败")
    if not (business_level or issue.final_business_level):
        raise ValidationError(
            "最终分类必须同时确认业务等级与问题等级",
            field_errors=[
                {"field": "final_business_level", "message": "请确认最终业务等级", "type": "value_error"}
            ],
        )
    if not (severity or issue.final_severity):
        raise ValidationError(
            "最终分类必须同时确认业务等级与问题等级",
            field_errors=[
                {"field": "final_severity", "message": "请确认最终问题等级", "type": "value_error"}
            ],
        )
    if business_level:
        changed["final_business_level"] = {"before": issue.final_business_level, "after": business_level}
        issue.final_business_level = business_level
    if severity:
        changed["final_severity"] = {"before": issue.final_severity, "after": severity}
        issue.final_severity = severity
    issue.final_classified_at = utcnow()
    issue.final_classified_by = account.name
    changed["final_classified_at"] = {"before": None, "after": iso_z(issue.final_classified_at)}
    return True


# --------------------------------------------------------------------------- 状态迁移


def _resolve_transition(current: str, action: str, label: str = "问题") -> st.Transition:
    for transition in st.ISSUE_TRANSITIONS:
        if transition.source == current and transition.action == action:
            return transition
    allowed = st.allowed_targets("issue", current)
    raise ConflictError(
        f"{label}当前状态「{st.ISSUE_STATUS_LABELS.get(current, current)}」不支持动作「{action}」",
        code="illegal_transition",
        extra={
            "machine": "issue",
            "current": current,
            "target": None,
            "action": action,
            "allowed_targets": list(allowed),
            "allowed_actions": list(st.allowed_actions("issue", current)),
            "reason": "未在状态机中声明的迁移一律拒绝（DESIGN §6.6）",
        },
    )


def _provider_for(extra: dict[str, Any], field_key: str) -> str:
    providers = extra.get("providers")
    if isinstance(providers, dict):
        value = providers.get(field_key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    single = extra.get("actual_provider")
    if isinstance(single, str) and single.strip():
        return single.strip()
    return ""


def _require_provider(extra: dict[str, Any], field_keys: list[str]) -> dict[str, str]:
    """代录强制：每个被写入的事业部/部门意见字段都必须提供实际提供人，否则 422。"""
    resolved: dict[str, str] = {}
    missing: list[dict[str, str]] = []
    for field_key in field_keys:
        provider = _provider_for(extra, field_key)
        if not provider:
            missing.append(
                {
                    "field": f"providers.{field_key}",
                    "message": "代录必须提供实际提供人",
                    "type": "value_error",
                }
            )
        else:
            resolved[field_key] = provider
    if missing:
        raise ValidationError("代录必须提供实际提供人", field_errors=missing)
    return resolved


def _record_proxy(
    db: Session,
    *,
    issue: Issue,
    target_type: str,
    field_key: str,
    actual_provider: str,
    account: Account,
    provider_department: str = "",
    source_note: str = "",
    content: str = "",
) -> ProxyRecord:
    """写代录记录：``proxy_by`` / ``proxy_at`` 一律由服务端生成。"""
    proxy = ProxyRecord(
        id=new_id(),
        target_type=target_type,
        target_id=issue.id,
        field_key=field_key,
        issue_id=issue.id,
        actual_provider=actual_provider.strip(),
        provider_department=provider_department,
        proxy_by=account.id,
        proxy_by_name=account.name,
        proxy_at=utcnow(),
        source_note=source_note,
        content_digest=(content or "")[:500],
    )
    db.add(proxy)
    issue.is_proxy = True
    return proxy


def _has_final_classification(issue: Issue) -> bool:
    return issue.final_classified_at is not None


def _has_open_dispute(db: Session, issue_id: str) -> bool:
    stmt = select(ReviewDecision).where(
        ReviewDecision.issue_id == issue_id, ReviewDecision.status == DECISION_STATUS_OPEN
    )
    return db.execute(stmt).scalars().first() is not None


def transition_issue(
    db: Session,
    *,
    issue: Issue,
    action: str,
    reason: str | None,
    expected_version: int | None,
    extra: dict[str, Any],
    account: Account,
    ctx: RequestContext | None = None,
) -> dict[str, Any]:
    check_row_version(issue, expected_version, "问题")
    transition = _resolve_transition(issue.status, action)
    if transition.requires_reason or action in ACTIONS_REQUIRING_REASON:
        require_reason(reason, label="操作原因")

    extra = extra or {}
    from_status = issue.status
    detail: dict[str, Any] = {"action": action}
    proxies_created: list[ProxyRecord] = []

    # ---- 各动作的写入与 guard ----
    if action == "submit":
        _guard_issue_required_fields(issue)

    elif action == "confirm_classification":
        if extra.get("confirm") is not True:
            raise ValidationError(
                "需要人工确认分类",
                field_errors=[
                    {"field": "extra.confirm", "message": "请确认分类（confirm 必须为 true）", "type": "value_error"}
                ],
            )
        if extra.get("business_level"):
            problems = _level_problems(extra["business_level"], None)
            _require(problems, "分类确认校验失败")
            issue.business_level = extra["business_level"]
        if extra.get("severity"):
            problems = _level_problems(None, extra["severity"])
            _require(problems, "分类确认校验失败")
            issue.severity = extra["severity"]
        # 评审前分类（初分）落库
        issue.pre_business_level = issue.business_level
        issue.pre_severity = issue.severity
        detail["pre_business_level"] = issue.pre_business_level
        detail["pre_severity"] = issue.pre_severity
        detail["confirmed_by"] = account.name

    elif action == "record_reply":
        division_reply = (extra.get("division_reply") or issue.division_reply or "").strip()
        written = list(extra.keys() & {"division_reply"})
        providers = _require_provider(extra, ["division_reply"]) if extra.get("division_reply") is not None else {}
        if not division_reply:
            raise ValidationError(
                "事业部回复不能为空",
                field_errors=[{"field": "extra.division_reply", "message": "请填写事业部回复", "type": "value_error"}],
            )
        issue.division_reply = division_reply
        if providers.get("division_reply"):
            proxies_created.append(
                _record_proxy(
                    db,
                    issue=issue,
                    target_type=PROXY_TARGET_ISSUE_REPLY,
                    field_key="division_reply",
                    actual_provider=providers["division_reply"],
                    account=account,
                    provider_department=extra.get("provider_department", ""),
                    source_note=extra.get("source_note", ""),
                    content=division_reply,
                )
            )
        if issue.first_replied_at is None:
            issue.first_replied_at = utcnow()
        detail["division_reply"] = division_reply
        detail["written_fields"] = ["division_reply"] if written else []

    elif action == "record_solution":
        solution = extra.get("solution")
        committed_version = extra.get("committed_version")
        actual_version = extra.get("actual_version")
        if solution is not None:
            solution = str(solution).strip()
        if committed_version is not None:
            committed_version = str(committed_version).strip()
        if actual_version is not None:
            actual_version = str(actual_version).strip()

        prospective_solution = solution if solution is not None else issue.solution
        prospective_committed = committed_version if committed_version is not None else issue.committed_version
        prospective_actual = actual_version if actual_version is not None else issue.actual_version
        if not prospective_solution:
            raise ValidationError(
                "解决方案不能为空",
                field_errors=[{"field": "extra.solution", "message": "请填写解决方案", "type": "value_error"}],
            )
        if not (prospective_committed or prospective_actual):
            raise ValidationError(
                "必须提供承诺修改版本或实际版本",
                field_errors=[
                    {"field": "extra.committed_version", "message": "请填写承诺修改版本或实际版本", "type": "value_error"}
                ],
            )

        proxy_fields: list[str] = []
        if solution:
            proxy_fields.append("solution")
        if committed_version:
            proxy_fields.append("committed_version")
        providers = _require_provider(extra, proxy_fields) if proxy_fields else {}

        if solution is not None:
            issue.solution = solution
        if committed_version is not None:
            issue.committed_version = committed_version
        if actual_version is not None:
            issue.actual_version = actual_version

        for field_key in proxy_fields:
            target_type = (
                PROXY_TARGET_ISSUE_SOLUTION if field_key == "solution" else PROXY_TARGET_ISSUE_COMMITMENT
            )
            content = issue.solution if field_key == "solution" else issue.committed_version
            proxies_created.append(
                _record_proxy(
                    db,
                    issue=issue,
                    target_type=target_type,
                    field_key=field_key,
                    actual_provider=providers[field_key],
                    account=account,
                    provider_department=extra.get("provider_department", ""),
                    source_note=extra.get("source_note", ""),
                    content=content,
                )
            )
        detail["solution"] = issue.solution
        detail["committed_version"] = issue.committed_version
        detail["actual_version"] = issue.actual_version

    elif action in ("accept", "reject"):
        evidence = str(extra.get("evidence") or "").strip()
        if not evidence:
            raise ValidationError(
                "验收证据不能为空",
                field_errors=[{"field": "extra.evidence", "message": "请填写验收证据", "type": "value_error"}],
            )
        tested_version = str(extra.get("tested_version") or issue.actual_version or issue.committed_version or "")
        issue.acceptances.append(
            IssueAcceptance(
                id=new_id(),
                issue_id=issue.id,
                result="accepted" if action == "accept" else "rejected",
                evidence=evidence,
                reason=(reason or "").strip(),
                tested_version=tested_version,
                actor_account_id=account.id,
                actor_name=account.name,
            )
        )
        detail["evidence"] = evidence
        detail["result"] = "accepted" if action == "accept" else "rejected"

    elif action == "record_rework":
        rework_note = str(extra.get("rework_note") or "").strip()
        if not rework_note:
            raise ValidationError(
                "整改记录不能为空",
                field_errors=[{"field": "extra.rework_note", "message": "请填写整改记录", "type": "value_error"}],
            )
        detail["rework_note"] = rework_note

    elif action == "close":
        if extra.get("confirm_final") and (extra.get("final_business_level") or extra.get("final_severity")):
            _apply_final_classification(
                db,
                issue,
                business_level=extra.get("final_business_level"),
                severity=extra.get("final_severity"),
                account=account,
                changed=detail,
            )
        if not _has_final_classification(issue):
            raise ConflictError(
                "最终分类尚未人工确认，不能关闭问题",
                code="precondition_failed",
                extra={
                    "machine": "issue",
                    "current": issue.status,
                    "target": transition.target,
                    "failed_guards": ["final_classification"],
                    "reason": "需先确认最终业务等级与问题等级",
                },
            )
        if _has_open_dispute(db, issue.id):
            raise ConflictError(
                "该问题存在未决评审争议，不能关闭",
                code="precondition_failed",
                extra={
                    "machine": "issue",
                    "current": issue.status,
                    "target": transition.target,
                    "failed_guards": ["no_open_dispute"],
                    "reason": "评审争议未决（review_decision.status = open）",
                },
            )
        issue.closed_at = utcnow()
        detail["closed_at"] = iso_z(issue.closed_at)

    elif action == "reopen":
        issue.closed_at = None

    # ---- 写迁移与状态 ----
    issue.status = transition.target
    touch(issue, account)
    db.add(
        IssueTransition(
            id=new_id(),
            issue_id=issue.id,
            action=action,
            from_status=from_status,
            to_status=transition.target,
            reason=(reason or "").strip(),
            detail_json=json.dumps(detail, ensure_ascii=False, default=str),
            actor_account_id=account.id,
            actor_name=account.name,
            request_id=ctx.request_id if ctx else "",
        )
    )

    for proxy in proxies_created:
        audit_business(
            db,
            account=account,
            ctx=ctx,
            action="issue_proxy_recorded",
            target_type="proxy_record",
            target_id=proxy.id,
            summary=f"问题 {issue.code} 代录 {PROXY_TARGET_LABELS.get(proxy.target_type, proxy.target_type)}",
            detail={
                "issue_id": issue.id,
                "issue_code": issue.code,
                "target_type": proxy.target_type,
                "field_key": proxy.field_key,
                "actual_provider": proxy.actual_provider,
                "proxy_by": proxy.proxy_by,
                "proxy_by_name": proxy.proxy_by_name,
                "proxy_at": iso_z(proxy.proxy_at),
                "is_proxy": True,
            },
            commit=False,
        )

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="issue_transitioned",
        target_type="issue",
        target_id=issue.id,
        summary=f"问题 {issue.code} {transition.label}",
        detail={
            "issue_code": issue.code,
            "action": action,
            "from_status": from_status,
            "to_status": transition.target,
            "reason": (reason or "").strip(),
            "proxy_count": len(proxies_created),
        },
        commit=False,
    )
    db.commit()
    db.refresh(issue)
    payload = issue_detail(db, issue)
    payload["transition"] = {
        "action": action,
        "label": transition.label,
        "from_status": from_status,
        "to_status": transition.target,
    }
    return payload


# --------------------------------------------------------------------------- 批量


def _resolve_batch_scope(
    db: Session, payload: Any
) -> tuple[list[Issue], dict[str, Any]]:
    """解析批量范围，返回 (问题列表, scope 回显)。"""
    except_ids = [i for i in (payload.except_ids or []) if i]

    if payload.issue_ids:
        ids = list(dict.fromkeys(payload.issue_ids))
        stmt = select(Issue).where(Issue.id.in_(ids))
        rows = list(db.execute(stmt).scalars().all())
        excluded = len(set(ids) & set(except_ids))
        total_n = len(ids)
    elif payload.all_filtered is not None:
        filters = payload.all_filtered.model_dump()
        rows = list(db.execute(build_issue_query(filters)).scalars().all())
        total_n = len(rows)
        excluded = len({r.id for r in rows} & set(except_ids))
    else:
        raise ValidationError(
            "批量操作必须指定 issue_ids 或 all_filtered",
            field_errors=[
                {"field": "issue_ids", "message": "请提供 issue_ids 或 all_filtered.filters", "type": "value_error"}
            ],
        )

    if except_ids:
        rows = [r for r in rows if r.id not in set(except_ids)]
    current_page_n = len(rows)

    scope = {
        "current_page_n": current_page_n,
        "total_n": total_n,
        "excluded_n": excluded,
    }
    return rows, scope


def batch_issues(
    db: Session,
    *,
    payload: Any,
    account: Account,
    ctx: RequestContext | None = None,
) -> dict[str, Any]:
    action = (payload.action or "").strip()
    if action not in ("set_level", "sync", "accept"):
        raise ValidationError(
            "批量动作不支持",
            field_errors=[
                {"field": "action", "message": "action 必须是 set_level / sync / accept", "type": "value_error"}
            ],
        )

    rows, scope = _resolve_batch_scope(db, payload)
    selected_ids = [r.id for r in rows]

    if payload.dry_run:
        return {"affected": 0, "scope": scope, "issue_ids": selected_ids, "dry_run": True, "action": action}

    affected_ids: list[str] = []
    skipped: list[str] = []
    extra_result: dict[str, Any] = {}

    if action == "set_level":
        data = payload.payload or {}
        business_level = data.get("business_level")
        severity = data.get("severity")
        problems = _level_problems(
            business_level if business_level is not None else None,
            severity if severity is not None else None,
        )
        if business_level is None and severity is None:
            problems.append(
                {"field": "payload", "message": "set_level 至少提供 business_level 或 severity", "type": "value_error"}
            )
        _require(problems, "批量改等级校验失败")

        for issue in rows:
            old = {"business_level": issue.business_level, "severity": issue.severity}
            if business_level is not None:
                issue.business_level = business_level
            if severity is not None:
                issue.severity = severity
            touch(issue, account)
            db.add(
                IssueTransition(
                    id=new_id(),
                    issue_id=issue.id,
                    action="batch_set_level",
                    from_status=issue.status,
                    to_status=issue.status,
                    reason="批量修改等级",
                    detail_json=json.dumps(
                        {
                            "before": old,
                            "after": {"business_level": issue.business_level, "severity": issue.severity},
                        },
                        ensure_ascii=False,
                    ),
                    actor_account_id=account.id,
                    actor_name=account.name,
                    request_id=ctx.request_id if ctx else "",
                )
            )
            affected_ids.append(issue.id)

    elif action == "sync":
        job_ids: list[str] = []
        for issue in rows:
            key = f"issue_sync:{issue.id}"
            job = (
                db.execute(select(ProviderJob).where(ProviderJob.idempotency_key == key)).scalars().first()
            )
            if job is None:
                job = ProviderJob(
                    id=new_id(),
                    provider_kind=PROVIDER_FEISHU,
                    job_type=JOB_TYPE_ISSUE_SYNC,
                    mode=MODE_MOCK,
                    idempotency_key=key,
                    status=st.JOB_QUEUED,
                    target_type="issue",
                    target_id=issue.id,
                    project_id=issue.project_id,
                    payload_json=json.dumps(
                        {"issue_code": issue.code, "description": issue.description}, ensure_ascii=False
                    ),
                    created_by=account.id,
                    created_by_name=account.name,
                )
                db.add(job)
            job_ids.append(job.id)
            affected_ids.append(issue.id)
        extra_result["job_ids"] = job_ids
        extra_result["idempotency_keys"] = [f"issue_sync:{i}" for i in affected_ids]

    else:  # accept
        evidence = str((payload.payload or {}).get("evidence") or "").strip()
        if not evidence:
            raise ValidationError(
                "批量验收必须提供证据",
                field_errors=[{"field": "payload.evidence", "message": "请填写验收证据", "type": "value_error"}],
            )
        for issue in rows:
            if issue.status != st.ISSUE_PENDING_ACCEPTANCE:
                skipped.append(issue.id)
                continue
            issue.acceptances.append(
                IssueAcceptance(
                    id=new_id(),
                    issue_id=issue.id,
                    result="accepted",
                    evidence=evidence,
                    reason="批量验收通过",
                    tested_version=issue.actual_version or issue.committed_version or "",
                    actor_account_id=account.id,
                    actor_name=account.name,
                )
            )
            from_status = issue.status
            issue.status = st.ISSUE_ACCEPTED
            touch(issue, account)
            db.add(
                IssueTransition(
                    id=new_id(),
                    issue_id=issue.id,
                    action="accept",
                    from_status=from_status,
                    to_status=st.ISSUE_ACCEPTED,
                    reason="批量验收通过",
                    detail_json=json.dumps({"evidence": evidence}, ensure_ascii=False),
                    actor_account_id=account.id,
                    actor_name=account.name,
                    request_id=ctx.request_id if ctx else "",
                )
            )
            affected_ids.append(issue.id)
        extra_result["skipped_count"] = len(skipped)

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action=f"issue_batch_{action}",
        target_type="issue_batch",
        target_id="",
        summary=f"批量 {action} 影响 {len(affected_ids)} 条问题",
        detail={
            "action": action,
            "affected": len(affected_ids),
            "scope": {
                "current_page_n": scope["current_page_n"],
                "total_n": scope["total_n"],
                "excluded_n": scope["excluded_n"],
            },
            "payload": payload.payload or {},
        },
        commit=False,
    )
    db.commit()

    result = {
        "affected": len(affected_ids),
        "scope": {
            "current_page_n": scope["current_page_n"],
            "total_n": scope["total_n"],
            "excluded_n": scope["excluded_n"],
        },
        "issue_ids": affected_ids,
        "action": action,
        "skipped_ids": skipped,
    }
    result.update(extra_result)
    return result


# --------------------------------------------------------------------------- guard 辅助


def _guard_issue_required_fields(issue: Issue) -> None:
    problems: list[dict[str, str]] = []
    if not (issue.description or "").strip():
        problems.append({"field": "description", "message": "问题描述不能为空", "type": "value_error"})
    if not issue.system_id:
        problems.append({"field": "system_id", "message": "所属系统不能为空（项目需挂系统）", "type": "value_error"})
    if issue.business_level not in sc.BUSINESS_LEVELS:
        problems.append({"field": "business_level", "message": "业务等级不完整", "type": "value_error"})
    if issue.severity not in sc.SEVERITY_LEVELS:
        problems.append({"field": "severity", "message": "问题等级不完整", "type": "value_error"})
    if problems:
        raise ConflictError(
            "提交前需补全问题必填字段",
            code="precondition_failed",
            field_errors=problems,
            extra={
                "machine": "issue",
                "current": issue.status,
                "target": st.ISSUE_PENDING_CONFIRM,
                "failed_guards": ["issue_required_fields"],
                "reason": "描述、产品版本、业务等级、问题等级必须完整",
            },
        )
