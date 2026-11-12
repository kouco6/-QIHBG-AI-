"""发布体验评审（N13）三段式服务（T07）。

DESIGN §6.2.2「评审列表 / 评审工作区」、§6.6「评审」状态机、PRD §5.5 三段式：

- **评审前**：汇总走查问题 + 初步分值 + 需回复项；进入评审中必须提供并锁定范围；
- **评审中**：争议、讨论、决策、解决方案、承诺版本、责任人（外部意见代录）；
- **评审后**：最终回复、分类差异、部门签署（代录）、L1 复算；归档需无未决争议、
  签署实际提供人齐全、最终分类确认且 L1 快照成功。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import RequestContext
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.core.security import new_id
from app.core.timeutil import iso_z, utcnow
from app.domain import scoring as sc
from app.domain import states as st
from app.domain.templates import REVIEW_SIGN_DEPARTMENTS
from app.models.account import Account
from app.models.flow import Project
from app.models.issue import PROXY_TARGET_REVIEW_SIGNATURE, Issue, ProxyRecord
from app.models.review import (
    DECISION_STATUS_DECIDED,
    DECISION_STATUS_DEFERRED,
    DECISION_STATUS_LABELS,
    DECISION_STATUS_OPEN,
    DECISION_STATUSES,
    Review,
    ReviewDecision,
    ReviewSignature,
)
from app.models.scoring import ProjectScoreSnapshot
from app.schemas.reviews import REVIEW_KIND_LABELS
from app.services.common import (
    audit_business,
    get_or_404,
    mark_created,
    paginate,
    require_reason,
    touch,
)

PAGE_SIZES: tuple[int, ...] = (20, 50, 100)
DEFAULT_PAGE_SIZE = 50


# --------------------------------------------------------------------------- 编码


def generate_review_code(db: Session, project: Project) -> str:
    prefix = f"REV-{project.code}-"
    existing = set(
        db.execute(select(Review.code).where(Review.code.like(f"{prefix}%"))).scalars().all()
    )
    seq = 1
    while f"{prefix}{seq:03d}" in existing:
        seq += 1
    return f"{prefix}{seq:03d}"


# --------------------------------------------------------------------------- 签署成员


def _signature_payload(signature: ReviewSignature) -> dict[str, Any]:
    return {
        "id": signature.id,
        "department": signature.department,
        "principal": signature.principal,
        "members": signature.members,
        "opinion": signature.opinion,
        "is_approved": signature.is_approved,
        # 代录标识：未填实际提供人的签署行视为「未完成」
        "is_proxy": bool(signature.is_proxy),
        "actual_provider": signature.actual_provider,
        "proxy_by": signature.proxy_by,
        "proxy_by_name": signature.proxy_by_name,
        "proxy_at": iso_z(signature.proxy_at),
        "provided": bool((signature.actual_provider or "").strip()),
    }


def signature_completeness(review: Review) -> dict[str, Any]:
    items = [_signature_payload(s) for s in review.signatures]
    filled = sum(1 for item in items if item["provided"])
    total = len(REVIEW_SIGN_DEPARTMENTS)
    return {
        "total": total,
        "filled": filled,
        "complete": total > 0 and filled >= total,
        "percent": round(filled / total * 100) if total else 0,
        "items": items,
    }


# --------------------------------------------------------------------------- 创建


def create_review(
    db: Session,
    *,
    account: Account,
    payload: Any,
    ctx: RequestContext | None = None,
) -> Review:
    project = get_or_404(db, Project, payload.project_id, "项目")
    if payload.review_kind not in REVIEW_KIND_LABELS:
        raise ValidationError(
            "评审类型非法",
            field_errors=[
                {
                    "field": "review_kind",
                    "message": "review_kind 必须是 release / internal_scenario / external_scenario",
                    "type": "value_error",
                }
            ],
        )
    title = (payload.title or "").strip()
    if not title:
        raise ValidationError(
            "评审标题不能为空",
            field_errors=[{"field": "title", "message": "请填写评审标题", "type": "value_error"}],
        )

    review = Review(
        id=new_id(),
        code=generate_review_code(db, project),
        project_id=project.id,
        node_code=(payload.node_code or "N13"),
        review_kind=payload.review_kind,
        title=title,
        stage=st.REVIEW_BEFORE,
        preliminary_uei="",
        final_uei="",
        conclusion="",
        row_version=1,
    )
    mark_created(review, account)
    db.add(review)
    db.flush()

    # 预置 6 条部门签署行：is_proxy=True、actual_provider 为空（未填不计入签署完整）
    for department in REVIEW_SIGN_DEPARTMENTS:
        db.add(
            ReviewSignature(
                id=new_id(),
                review_id=review.id,
                department=department,
                is_proxy=True,
                actual_provider="",
                proxy_by="",
                proxy_by_name="",
                proxy_at=None,
            )
        )

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="review_created",
        target_type="review",
        target_id=review.id,
        summary=f"新建评审 {review.code}",
        detail={
            "review_code": review.code,
            "project_id": project.id,
            "review_kind": review.review_kind,
            "stage": review.stage,
            "signature_departments": list(REVIEW_SIGN_DEPARTMENTS),
        },
        commit=False,
    )
    db.commit()
    db.refresh(review)
    return review


# --------------------------------------------------------------------------- 列表


def review_row(review: Review, project_name: str = "", version_code: str = "") -> dict[str, Any]:
    open_count = sum(1 for d in review.decisions if d.status == DECISION_STATUS_OPEN)
    return {
        "id": review.id,
        "code": review.code,
        "title": review.title,
        "project_id": review.project_id,
        "project_name": project_name,
        "version_code": version_code,
        "node_code": review.node_code,
        "review_kind": review.review_kind,
        "review_kind_label": REVIEW_KIND_LABELS.get(review.review_kind, review.review_kind),
        "stage": review.stage,
        "stage_label": st.REVIEW_STATUS_LABELS.get(review.stage, review.stage),
        "conclusion": review.conclusion,
        "decision_count": len(review.decisions),
        "open_dispute_count": open_count,
        "preliminary_uei": review.preliminary_uei,
        "final_uei": review.final_uei,
        "archived_at": iso_z(review.archived_at),
        "reviewed_at": iso_z(review.archived_at or review.updated_at),
        "updated_at": iso_z(review.updated_at),
        "updated_by_name": review.updated_by_name,
        "row_version": review.row_version,
        "allowed_actions": list(st.allowed_actions("review", review.stage)),
    }


def list_reviews(
    db: Session,
    *,
    project_id: str | None = None,
    stage: str | None = None,
    review_kind: str | None = None,
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> dict[str, Any]:
    if page_size not in PAGE_SIZES:
        page_size = DEFAULT_PAGE_SIZE
    stmt = select(Review)
    if project_id:
        stmt = stmt.where(Review.project_id == project_id)
    if stage:
        stmt = stmt.where(Review.stage == stage)
    if review_kind:
        stmt = stmt.where(Review.review_kind == review_kind)
    stmt = stmt.order_by(Review.updated_at.desc())
    rows, total = paginate(db, stmt, page=page, page_size=page_size)
    project_ids = {r.project_id for r in rows if r.project_id}
    projects = (
        {p.id: p for p in db.execute(select(Project).where(Project.id.in_(project_ids))).scalars()}
        if project_ids
        else {}
    )

    return {
        "page": max(1, page),
        "page_size": page_size,
        "total": total,
        "items": [
            review_row(
                r,
                projects[r.project_id].name if r.project_id in projects else "",
                projects[r.project_id].version_code if r.project_id in projects else "",
            )
            for r in rows
        ],
    }


# --------------------------------------------------------------------------- 详情（三段式）


def _project_issues(db: Session, project_id: str) -> list[Issue]:
    stmt = select(Issue).where(Issue.project_id == project_id).order_by(Issue.code)
    return list(db.execute(stmt).scalars().all())


def _issue_brief(issue: Issue) -> dict[str, Any]:
    return {
        "id": issue.id,
        "code": issue.code,
        "description": issue.description,
        "business_level": issue.business_level,
        "business_level_label": sc.BUSINESS_LEVEL_LABELS.get(issue.business_level, issue.business_level),
        "severity": issue.severity,
        "severity_label": sc.SEVERITY_LABELS.get(issue.severity, issue.severity),
        "status": issue.status,
        "status_label": st.ISSUE_STATUS_LABELS.get(issue.status, issue.status),
        "final_business_level": issue.final_business_level,
        "final_severity": issue.final_severity,
        "final_classified_at": iso_z(issue.final_classified_at),
        "division_id": issue.division_id,
    }


def review_detail(db: Session, review: Review) -> dict[str, Any]:
    project = db.get(Project, review.project_id)
    issues = _project_issues(db, review.project_id)

    by_business: dict[str, int] = {level: 0 for level in sc.BUSINESS_LEVELS}
    by_severity: dict[str, int] = {level: 0 for level in sc.SEVERITY_LEVELS}
    for issue in issues:
        if issue.business_level in by_business:
            by_business[issue.business_level] += 1
        if issue.severity in by_severity:
            by_severity[issue.severity] += 1

    need_reply = [i for i in issues if i.status in (st.ISSUE_PENDING_REPLY, st.ISSUE_IN_PROGRESS)]

    decisions = [
        {
            "id": d.id,
            "issue_id": d.issue_id,
            "issue_code": d.issue_code,
            "status": d.status,
            "status_label": DECISION_STATUS_LABELS.get(d.status, d.status),
            "dispute": d.dispute,
            "discussion": d.discussion,
            "decision": d.decision,
            "solution": d.solution,
            "committed_version": d.committed_version,
            "owner_text": d.owner_text,
            "business_level_after": d.business_level_after,
            "severity_after": d.severity_after,
            "created_by_name": d.created_by_name,
            "created_at": iso_z(d.created_at),
            "updated_at": iso_z(d.updated_at),
        }
        for d in review.decisions
    ]

    classification_diff = [
        {
            "issue_id": i.id,
            "issue_code": i.code,
            "pre_business_level": i.pre_business_level,
            "pre_severity": i.pre_severity,
            "final_business_level": i.final_business_level,
            "final_severity": i.final_severity,
            "changed": bool(
                i.final_classified_at
                and (i.final_business_level != i.pre_business_level or i.final_severity != i.pre_severity)
            ),
            "final_classified_at": iso_z(i.final_classified_at),
        }
        for i in issues
    ]

    snapshot = None
    if review.final_snapshot_id:
        snap = db.get(ProjectScoreSnapshot, review.final_snapshot_id)
        if snap is not None:
            snapshot = {
                "id": snap.id,
                "scheme_code": snap.scheme_code,
                "display_uei": sc.format_score(snap.display_uei),
                "raw_uei": sc.format_score(snap.raw_uei),
                "issue_count": snap.issue_count,
                "snapshot_at": iso_z(snap.snapshot_at),
            }

    signatures = signature_completeness(review)
    version_code = project.version_code if project is not None else ""

    return {
        "id": review.id,
        "code": review.code,
        "project_id": review.project_id,
        "project_name": project.name if project else "",
        "version_code": version_code,
        "node_code": review.node_code,
        "review_kind": review.review_kind,
        "review_kind_label": REVIEW_KIND_LABELS.get(review.review_kind, review.review_kind),
        "title": review.title,
        "stage": review.stage,
        "stage_label": st.REVIEW_STATUS_LABELS.get(review.stage, review.stage),
        "scope_locked_at": iso_z(review.scope_locked_at),
        "preliminary_uei": review.preliminary_uei,
        "preliminary_snapshot_id": review.preliminary_snapshot_id,
        "final_uei": review.final_uei,
        "final_snapshot_id": review.final_snapshot_id,
        "conclusion": review.conclusion,
        "archived_at": iso_z(review.archived_at),
        "archive_confirm_text": review.archive_confirm_text,
        "updated_at": iso_z(review.updated_at),
        "updated_by_name": review.updated_by_name,
        "row_version": review.row_version,
        # 三阶段 Tab 数据
        "tabs": {
            "before": {
                "issue_summary": {
                    "total": len(issues),
                    "by_business_level": by_business,
                    "by_severity": by_severity,
                    "by_business_level_label": {
                        sc.BUSINESS_LEVEL_LABELS[k]: v for k, v in by_business.items()
                    },
                    "by_severity_label": {sc.SEVERITY_LABELS[k]: v for k, v in by_severity.items()},
                },
                "preliminary_uei": review.preliminary_uei,
                "preliminary_snapshot_id": review.preliminary_snapshot_id,
                "need_reply": [_issue_brief(i) for i in need_reply],
                "scope_locked_at": iso_z(review.scope_locked_at),
                "issues": [_issue_brief(i) for i in issues],
            },
            "during": {
                "decisions": decisions,
                "committed_versions": [
                    {
                        "decision_id": d.id,
                        "issue_code": d.issue_code,
                        "committed_version": d.committed_version,
                        "owner_text": d.owner_text,
                    }
                    for d in review.decisions
                    if d.committed_version
                ],
                "open_dispute_count": sum(1 for d in review.decisions if d.status == DECISION_STATUS_OPEN),
            },
            "after": {
                "final_replies": [
                    {
                        "issue_id": i.id,
                        "issue_code": i.code,
                        "division_reply": i.division_reply,
                        "solution": i.solution,
                        "committed_version": i.committed_version,
                    }
                    for i in issues
                    if i.division_reply or i.solution
                ],
                "classification_diff": classification_diff,
                "signatures": signatures,
                "recomputed": snapshot,
                "final_uei": review.final_uei,
            },
        },
        "signatures": signatures,
        "decisions": decisions,
        "allowed_actions": list(st.allowed_actions("review", review.stage)),
    }


# --------------------------------------------------------------------------- 状态迁移


def _resolve_transition(current: str, action: str) -> st.Transition:
    for transition in st.REVIEW_TRANSITIONS:
        if transition.source == current and transition.action == action:
            return transition
    allowed = st.allowed_targets("review", current)
    raise ConflictError(
        f"评审当前阶段「{st.REVIEW_STATUS_LABELS.get(current, current)}」不支持动作「{action}」",
        code="illegal_transition",
        extra={
            "machine": "review",
            "current": current,
            "target": None,
            "action": action,
            "allowed_targets": list(allowed),
            "allowed_actions": list(st.allowed_actions("review", current)),
            "reason": "未在状态机中声明的迁移一律拒绝（DESIGN §6.6）",
        },
    )


def _guard_summary_ready(db: Session, review: Review, scope: dict[str, Any] | None) -> dict[str, Any]:
    if not scope or (not scope.get("issue_ids") and not scope.get("filters")):
        raise ValidationError(
            "进入评审中前必须锁定问题范围",
            field_errors=[
                {"field": "scope", "message": "请提供 scope.issue_ids 或 scope.filters", "type": "value_error"}
            ],
        )
    from app.services.issues import build_issue_query

    if scope.get("issue_ids"):
        ids = [i for i in scope["issue_ids"] if i]
        rows = list(db.execute(select(Issue).where(Issue.id.in_(ids))).scalars().all())
    else:
        filters = dict(scope.get("filters") or {})
        filters.setdefault("project_id", review.project_id)
        rows = list(db.execute(build_issue_query(filters)).scalars().all())

    review.scope_locked_at = utcnow()
    summary = {
        "issue_count": len(rows),
        "issue_ids": [r.id for r in rows],
        "locked_at": iso_z(review.scope_locked_at),
    }
    return summary


def _guard_disputes_decided(review: Review) -> None:
    pending = [d for d in review.decisions if d.status == DECISION_STATUS_OPEN]
    if pending:
        raise ConflictError(
            "仍有未决争议，不能进入评审后",
            code="precondition_failed",
            extra={
                "machine": "review",
                "current": review.stage,
                "target": st.REVIEW_AFTER,
                "failed_guards": ["disputes_decided"],
                "reason": f"{len(pending)} 条争议尚未决策或明确待办",
                "open_decision_ids": [d.id for d in pending],
            },
        )


def _guard_no_open_dispute(review: Review) -> None:
    pending = [d for d in review.decisions if d.status == DECISION_STATUS_OPEN]
    if pending:
        raise ConflictError(
            "存在未决争议，不能归档",
            code="precondition_failed",
            extra={
                "machine": "review",
                "current": review.stage,
                "target": st.REVIEW_ARCHIVED,
                "failed_guards": ["no_open_dispute"],
                "reason": f"{len(pending)} 条争议未决",
                "open_decision_ids": [d.id for d in pending],
            },
        )


def _guard_proxy_complete(review: Review) -> None:
    missing = [s.department for s in review.signatures if not (s.actual_provider or "").strip()]
    if missing:
        raise ConflictError(
            "部门签署缺少实际提供人，不能归档",
            code="precondition_failed",
            extra={
                "machine": "review",
                "current": review.stage,
                "target": st.REVIEW_ARCHIVED,
                "failed_guards": ["proxy_complete"],
                "reason": "以下部门签署未填实际提供人：" + "、".join(missing),
                "missing_departments": missing,
            },
        )


def _guard_final_classification(db: Session, review: Review) -> None:
    linked = {d.issue_id for d in review.decisions if d.issue_id}
    if linked:
        targets = list(db.execute(select(Issue).where(Issue.id.in_(linked))).scalars().all())
    else:
        targets = _project_issues(db, review.project_id)
    unfinalized = [i for i in targets if i.final_classified_at is None]
    if unfinalized:
        raise ConflictError(
            "存在未确认最终分类的问题，不能归档",
            code="precondition_failed",
            extra={
                "machine": "review",
                "current": review.stage,
                "target": st.REVIEW_ARCHIVED,
                "failed_guards": ["final_classification"],
                "reason": "以下问题尚未人工确认最终分类：" + "、".join(i.code for i in unfinalized),
                "unfinalized_issue_ids": [i.id for i in unfinalized],
            },
        )


def _guard_l1_snapshot_ready(
    db: Session, review: Review, snapshot_id: str | None
) -> ProjectScoreSnapshot:
    if not snapshot_id:
        raise ConflictError(
            "归档必须关联已确认的 L1 快照",
            code="precondition_failed",
            extra={
                "machine": "review",
                "current": review.stage,
                "target": st.REVIEW_ARCHIVED,
                "failed_guards": ["l1_snapshot_ready"],
                "reason": "body 需携带 snapshot_id",
            },
        )
    snapshot = db.get(ProjectScoreSnapshot, snapshot_id)
    if snapshot is None:
        raise NotFoundError(f"L1 快照不存在：{snapshot_id}")
    return snapshot


def transition_review(
    db: Session,
    *,
    review: Review,
    payload: Any,
    account: Account,
    ctx: RequestContext | None = None,
) -> dict[str, Any]:
    action = (payload.action or "").strip()
    transition = _resolve_transition(review.stage, action)
    if transition.requires_reason:
        require_reason(payload.reason, label="操作原因")

    from_status = review.stage
    detail: dict[str, Any] = {"action": action}

    if action == "start":
        summary = _guard_summary_ready(db, review, payload.scope)
        detail.update(summary)
        detail["scope_locked_at"] = summary["locked_at"]
    elif action == "finish":
        _guard_disputes_decided(review)
    elif action == "archive":
        if (payload.confirm_text or "") != review.title:
            raise ValidationError(
                "归档确认文本与评审标题不匹配",
                field_errors=[
                    {
                        "field": "confirm_text",
                        "message": "请逐字输入评审标题以确认归档",
                        "type": "value_error",
                    }
                ],
            )
        _guard_no_open_dispute(review)
        _guard_proxy_complete(review)
        _guard_final_classification(db, review)
        snapshot = _guard_l1_snapshot_ready(db, review, payload.snapshot_id)
        review.final_snapshot_id = snapshot.id
        review.final_uei = snapshot.display_uei
        review.archived_at = utcnow()
        review.archive_confirm_text = payload.confirm_text or ""
        detail["snapshot_id"] = snapshot.id
        detail["final_uei"] = sc.format_score(snapshot.display_uei)

    review.stage = transition.target
    touch(review, account)
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="review_transitioned",
        target_type="review",
        target_id=review.id,
        summary=f"评审 {review.code} {transition.label}",
        detail={
            "review_code": review.code,
            "action": action,
            "from_stage": from_status,
            "to_stage": transition.target,
            "reason": (payload.reason or "").strip(),
            **{k: v for k, v in detail.items() if k != "action"},
        },
        commit=False,
    )
    db.commit()
    db.refresh(review)
    result = review_detail(db, review)
    result["transition"] = {
        "action": action,
        "label": transition.label,
        "from_stage": from_status,
        "to_stage": transition.target,
    }
    return result


# --------------------------------------------------------------------------- 争议决策


def create_decision(
    db: Session,
    *,
    review: Review,
    payload: Any,
    account: Account,
    ctx: RequestContext | None = None,
) -> ReviewDecision:
    dispute = (payload.dispute or "").strip()
    if not dispute:
        raise ValidationError(
            "争议内容不能为空",
            field_errors=[{"field": "dispute", "message": "请填写争议内容", "type": "value_error"}],
        )
    status = payload.status or DECISION_STATUS_OPEN
    if status not in DECISION_STATUSES:
        raise ValidationError(
            "争议状态非法",
            field_errors=[
                {"field": "status", "message": "status 必须是 open / decided / deferred", "type": "value_error"}
            ],
        )
    if status in (DECISION_STATUS_DECIDED, DECISION_STATUS_DEFERRED) and not (payload.decision or "").strip():
        raise ValidationError(
            "决策或明确待办必须填写内容",
            field_errors=[{"field": "decision", "message": "请填写决策内容", "type": "value_error"}],
        )

    issue_id = payload.issue_id
    issue_code = ""
    if issue_id:
        issue = get_or_404(db, Issue, issue_id, "问题")
        issue_code = issue.code

    decision = ReviewDecision(
        id=new_id(),
        review_id=review.id,
        issue_id=issue_id,
        issue_code=issue_code,
        status=status,
        dispute=dispute,
        discussion=payload.discussion or "",
        decision=payload.decision or "",
        solution=payload.solution or "",
        committed_version=payload.committed_version or "",
        owner_text=payload.owner_text or "",
        business_level_after=payload.business_level_after or "",
        severity_after=payload.severity_after or "",
        created_by_name=account.name,
    )
    db.add(decision)
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="review_decision_created",
        target_type="review_decision",
        target_id=decision.id,
        summary=f"评审 {review.code} 新增争议项",
        detail={
            "review_id": review.id,
            "issue_id": issue_id,
            "issue_code": issue_code,
            "status": status,
        },
        commit=False,
    )
    db.commit()
    db.refresh(decision)
    return decision


def update_decision(
    db: Session,
    *,
    review: Review,
    decision: ReviewDecision,
    payload: Any,
    account: Account,
    ctx: RequestContext | None = None,
) -> ReviewDecision:
    if decision.review_id != review.id:
        raise NotFoundError("争议项不属于该评审")

    changed: dict[str, Any] = {}

    if payload.status is not None:
        status = payload.status
        if status not in DECISION_STATUSES:
            raise ValidationError(
                "争议状态非法",
                field_errors=[
                    {"field": "status", "message": "status 必须是 open / decided / deferred", "type": "value_error"}
                ],
            )
        decision_fields = (
            payload.decision if payload.decision is not None else decision.decision
        )
        # open → decided/deferred 必须有决策内容
        if status in (DECISION_STATUS_DECIDED, DECISION_STATUS_DEFERRED) and not (decision_fields or "").strip():
            raise ValidationError(
                "决策或明确待办必须填写内容",
                field_errors=[{"field": "decision", "message": "请填写决策内容", "type": "value_error"}],
            )
        if status != decision.status:
            changed["status"] = {"before": decision.status, "after": status}
            decision.status = status

    for field in (
        "discussion",
        "decision",
        "solution",
        "committed_version",
        "owner_text",
        "business_level_after",
        "severity_after",
    ):
        value = getattr(payload, field)
        if value is None:
            continue
        if getattr(decision, field) != value:
            changed[field] = {"before": getattr(decision, field), "after": value}
            setattr(decision, field, value)

    if changed:
        decision.updated_at = utcnow()
        audit_business(
            db,
            account=account,
            ctx=ctx,
            action="review_decision_updated",
            target_type="review_decision",
            target_id=decision.id,
            summary=f"评审 {review.code} 更新争议项",
            detail={"review_id": review.id, "decision_id": decision.id, "changed": changed},
            commit=False,
        )
        db.commit()
        db.refresh(decision)
    return decision


# --------------------------------------------------------------------------- 部门签署（代录）


def upsert_signature(
    db: Session,
    *,
    review: Review,
    payload: Any,
    account: Account,
    ctx: RequestContext | None = None,
) -> dict[str, Any]:
    department = (payload.department or "").strip()
    if department not in REVIEW_SIGN_DEPARTMENTS:
        raise ValidationError(
            "签署部门非法",
            field_errors=[
                {
                    "field": "department",
                    "message": f"部门必须是 {'、'.join(REVIEW_SIGN_DEPARTMENTS)} 之一",
                    "type": "value_error",
                }
            ],
        )
    actual_provider = (payload.actual_provider or "").strip()
    if not actual_provider:
        raise ValidationError(
            "代录必须提供实际提供人",
            field_errors=[
                {
                    "field": "actual_provider",
                    "message": "代录必须提供实际提供人",
                    "type": "value_error",
                }
            ],
        )

    signature = (
        db.execute(
            select(ReviewSignature).where(
                ReviewSignature.review_id == review.id, ReviewSignature.department == department
            )
        )
        .scalars()
        .first()
    )
    created = signature is None
    if signature is None:
        signature = ReviewSignature(id=new_id(), review_id=review.id, department=department)
        db.add(signature)

    signature.principal = payload.principal or ""
    signature.members = payload.members or ""
    signature.opinion = payload.opinion or ""
    signature.is_approved = bool(payload.is_approved)
    signature.is_proxy = True
    signature.actual_provider = actual_provider
    # proxy_by / proxy_at 一律由服务端生成
    signature.proxy_by = account.id
    signature.proxy_by_name = account.name
    signature.proxy_at = utcnow()
    db.flush()

    proxy = ProxyRecord(
        id=new_id(),
        target_type=PROXY_TARGET_REVIEW_SIGNATURE,
        target_id=signature.id,
        field_key="signature",
        issue_id=None,
        actual_provider=actual_provider,
        provider_department=department,
        proxy_by=account.id,
        proxy_by_name=account.name,
        proxy_at=utcnow(),
        source_note=payload.opinion or "",
        content_digest=(payload.opinion or "")[:500],
    )
    db.add(proxy)

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="review_signature_recorded",
        target_type="proxy_record",
        target_id=proxy.id,
        summary=f"评审 {review.code} 代录 {department} 签署",
        detail={
            "review_id": review.id,
            "signature_id": signature.id,
            "department": department,
            "actual_provider": actual_provider,
            "proxy_by": proxy.proxy_by,
            "proxy_by_name": proxy.proxy_by_name,
            "proxy_at": iso_z(proxy.proxy_at),
            "created": created,
            "is_proxy": True,
        },
        commit=False,
    )
    db.commit()
    db.refresh(review)
    completeness = signature_completeness(review)
    return {
        "signature": _signature_payload(signature),
        "completeness": {
            "total": completeness["total"],
            "filled": completeness["filled"],
            "complete": completeness["complete"],
            "percent": completeness["percent"],
        },
    }
