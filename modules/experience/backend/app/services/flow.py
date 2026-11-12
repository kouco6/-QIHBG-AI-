"""项目域服务：事业部 / 产品 / 产品版本 / 项目 / 13 节点状态机（T04）。

职责边界：

- **实体生命周期**：事业部、产品、版本的创建、查询、更新与受控停用（归档不物理删除）。
- **项目实例化**：创建项目时按 :data:`app.domain.nodes.NODE_SPECS` 串行实例化 13 个
  节点；仅迭代产品适用的节点（N10）在新产品项目上直接置为 ``not_applicable``
  并记录理由、结束时间与事件。
- **节点状态机**：唯一权威。合法迁移来自 :data:`app.domain.states.NODE_TRANSITIONS`，
  越权 / 未声明迁移一律 409（附 ``current`` / ``target`` / ``allowed_targets``），
  缺理由 422；前置条件（guard）在本模块按 ``Transition.guards`` 逐项求值。
- **审计**：所有写操作经 :func:`app.services.common.audit_business` 留痕。

设计说明（合理假设，已在交付说明中列出）：

1. ``WorkflowNodeEvent`` 模型没有 ``detail`` 列（模型属 T04 契约且禁止修改），
   因此「重新打开时下游可能过期」的清单写入 event 的 ``reason`` 尾部
   （形如 ``原因｜下游可能过期：N07 原型体验(已完成)``），同时通过响应字段
   ``downstream_stale`` 返回给界面，并写入业务审计 ``detail``。
2. 创建项目时若只给 ``version_code`` 而产品下不存在该版本，则**自动登记**该
   产品版本（与 DESIGN 中「版本已登记」的口径一致），``is_current`` 默认 False。
"""

from __future__ import annotations

import datetime as _dt
import json

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import RequestContext
from app.core.errors import ConflictError, ValidationError
from app.core.security import new_id
from app.core.timeutil import iso_z, utcnow
from app.domain import states as st
from app.domain.nodes import (
    NODE_BY_CODE,
    NODE_SPECS,
    PROJECT_TYPE_ITERATION,
    PROJECT_TYPE_LABELS,
    PROJECT_TYPES,
    REVIEW_GATED_NODES,
    STAGE_BY_CODE,
    STAGES,
    node_applicable,
    resolved_upstream,
)
from app.domain.templates import TEMPLATE_BY_KIND
from app.models.account import Account, AuditLog
from app.models.artifact import Artifact
from app.models.flow import (
    DIVISION_ACTIVE,
    DIVISION_ARCHIVED,
    PROJECT_ACTIVE,
    PROJECT_ARCHIVED,
    PROJECT_CLOSED,
    Division,
    Project,
    WorkflowNode,
    WorkflowNodeEvent,
)
from app.models.issue import Issue
from app.models.systems import SYSTEM_ACTIVE, System
from app.services.common import (
    audit_business,
    check_row_version,
    check_transition,
    find_by,
    get_or_404,
    mark_created,
    paginate,
    touch,
)

# 状态中文标签（模型层只定义状态值，标签在服务层集中维护）
DIVISION_STATUS_LABELS: dict[str, str] = {
    DIVISION_ACTIVE: "启用",
    DIVISION_ARCHIVED: "停用",
}
PROJECT_STATUS_LABELS: dict[str, str] = {
    PROJECT_ACTIVE: "进行中",
    PROJECT_ARCHIVED: "已归档",
    PROJECT_CLOSED: "已关闭",
}

# 归档原因默认值（未提供原因时的审计摘要补充）
_AUDIT_TIMELINE_LIMIT = 30


# ====================================================================== 序列化助手


def _division_status_label(status: str) -> str:
    return DIVISION_STATUS_LABELS.get(status, status)


def _node_status_label(status: str) -> str:
    return st.NODE_STATUS_LABELS.get(status, status)


def _allowed_actions(status: str) -> list[dict[str, object]]:
    actions: list[dict[str, object]] = []
    for item in st.allowed_actions("node", status):
        target = str(item["target"])
        actions.append({**item, "target_label": _node_status_label(target)})
    return actions


def _artifact_status_label(status: str) -> str:
    if status == "missing":
        return "未创建"
    return st.ARTIFACT_STATUS_LABELS.get(status, status)


# ====================================================================== 事业部


def division_out(db: Session, division: Division) -> dict[str, object]:
    count = int(
        db.execute(
            select(func.count()).select_from(System).where(System.division_id == division.id)
        ).scalar()
        or 0
    )
    return {
        "id": division.id,
        "code": division.code,
        "name": division.name,
        "owner_text": division.owner_text,
        "status": division.status,
        "status_label": _division_status_label(division.status),
        "note": division.note,
        "system_count": count,
        "created_at": iso_z(division.created_at),
        "updated_at": iso_z(division.updated_at),
        "updated_by_name": division.updated_by_name,
    }


def list_divisions(
    db: Session,
    *,
    status: str | None = None,
    keyword: str | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[dict[str, object]], int]:
    stmt = select(Division)
    if status:
        stmt = stmt.where(Division.status == status)
    if keyword:
        like = f"%{keyword.strip()}%"
        stmt = stmt.where(or_(Division.name.like(like), Division.code.like(like)))
    stmt = stmt.order_by(Division.created_at.desc(), Division.code)
    rows, total = paginate(db, stmt, page=page, page_size=page_size)
    return [division_out(db, row) for row in rows], total


def create_division(db: Session, *, code: str, name: str, owner_text: str, note: str, account: Account, ctx: RequestContext) -> Division:
    if find_by(db, Division, code=code.strip()) is not None:
        raise ConflictError(f"事业部编码已存在：{code}", code="duplicate_code", extra={"field": "code", "value": code})
    division = Division(
        id=new_id(),
        code=code.strip(),
        name=name.strip(),
        owner_text=owner_text.strip(),
        note=note.strip(),
        status=DIVISION_ACTIVE,
    )
    mark_created(division, account)
    db.add(division)
    db.flush()
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="division_created",
        target_type="division",
        target_id=division.id,
        summary=f"创建事业部 {division.name}",
        detail={"code": division.code, "name": division.name},
    )
    return division


def update_division(db: Session, division: Division, *, payload: object, account: Account, ctx: RequestContext) -> Division:
    changes: dict[str, object] = {}
    for field in ("name", "owner_text", "note", "status"):
        value = getattr(payload, field, None)
        if value is not None:
            new_value = value.strip() if isinstance(value, str) else value
            if getattr(division, field) != new_value:
                changes[field] = new_value
                setattr(division, field, new_value)
    touch(division, account)
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="division_updated",
        target_type="division",
        target_id=division.id,
        summary=f"更新事业部 {division.name}",
        detail=changes,
    )
    return division


def archive_division(db: Session, division: Division, *, reason: str | None, account: Account, ctx: RequestContext) -> Division:
    division.status = DIVISION_ARCHIVED
    touch(division, account)
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="division_archived",
        target_type="division",
        target_id=division.id,
        summary=f"停用事业部 {division.name}",
        detail={"reason": (reason or "").strip()},
    )
    return division


# ====================================================================== 产品


# ====================================================================== 节点实例化


def _new_project_code(db: Session) -> str:
    prefix = f"PRJ-{utcnow():%Y%m%d}"
    seq = int(
        db.execute(
            select(func.count()).select_from(Project).where(Project.code.like(f"{prefix}%"))
        ).scalar()
        or 0
    )
    while True:
        seq += 1
        code = f"{prefix}-{seq:03d}"
        if find_by(db, Project, code=code) is None:
            return code


def _instantiate_nodes(db: Session, project: Project, account: Account, ctx: RequestContext) -> list[WorkflowNode]:
    """按 NODE_SPECS 串行实例化 13 个节点，并写入自动不适用节点的事件。"""
    nodes: list[WorkflowNode] = []
    cursor = utcnow()
    for spec in NODE_SPECS:
        planned_start = cursor
        cursor = cursor + _dt.timedelta(days=spec.duration_days)
        node = WorkflowNode(
            id=new_id(),
            project_id=project.id,
            code=spec.code,
            node_order=spec.order,
            stage_code=spec.stage_code,
            name=spec.name,
            scope=spec.scope,
            duration_days=spec.duration_days,
            outputs_text=spec.outputs,
            allow_not_applicable=spec.allow_not_applicable,
            iteration_only=spec.iteration_only,
            status=st.NODE_NOT_STARTED,
            planned_start_at=planned_start,
            planned_end_at=cursor,
        )
        mark_created(node, account)
        if not node_applicable(spec.code, project.project_type):
            reason = f"{PROJECT_TYPE_LABELS.get(project.project_type, project.project_type)}不适用{spec.name}"
            node.status = st.NODE_NOT_APPLICABLE
            node.not_applicable_reason = reason
            node.actual_end_at = utcnow()
        db.add(node)
        nodes.append(node)
    db.flush()

    for node in nodes:
        if node.status != st.NODE_NOT_APPLICABLE:
            continue
        db.add(
            WorkflowNodeEvent(
                id=new_id(),
                node_id=node.id,
                project_id=project.id,
                action="mark_na",
                from_status="",
                to_status=st.NODE_NOT_APPLICABLE,
                reason=node.not_applicable_reason,
                actor_account_id=account.id,
                actor_name=account.name,
                request_id=ctx.request_id,
            )
        )
    db.flush()
    return nodes


# ====================================================================== 项目


def nodes_by_code(project: Project) -> dict[str, WorkflowNode]:
    return {node.code: node for node in project.nodes}


def current_node(project: Project) -> WorkflowNode | None:
    ordered = sorted(project.nodes, key=lambda n: n.node_order)
    if not ordered:
        return None
    for node in ordered:
        if node.status == st.NODE_IN_PROGRESS:
            return node
    for node in ordered:
        if node.status == st.NODE_NOT_STARTED:
            return node
    return ordered[-1]


def create_project(db: Session, payload: object, account: Account, ctx: RequestContext) -> Project:
    system = get_or_404(db, System, getattr(payload, "system_id", None), "系统")
    if system.status != SYSTEM_ACTIVE:
        raise ValidationError(
            "系统已归档，不能新建项目",
            field_errors=[{"field": "system_id", "message": "该系统已归档", "type": "value_error"}],
        )
    project_type = str(getattr(payload, "project_type"))
    if project_type not in PROJECT_TYPES:
        raise ValidationError(
            "项目类型非法",
            field_errors=[{"field": "project_type", "message": "必须为 new_product 或 iteration", "type": "value_error"}],
        )
    version_code = (getattr(payload, "version_code", None) or "").strip()
    division_id = getattr(payload, "division_id", None) or system.division_id
    if division_id:
        get_or_404(db, Division, division_id, "事业部")
    weight = str(getattr(payload, "weight", None) or "1").strip() or "1"
    try:
        from decimal import Decimal
        w = Decimal(weight)
        if w <= 0:
            raise ValueError
    except Exception:
        raise ValidationError(
            "权重必须为正数",
            field_errors=[{"field": "weight", "message": "权重必须为大于 0 的数值", "type": "value_error"}],
        )

    project = Project(
        id=new_id(),
        code=_new_project_code(db),
        name=str(getattr(payload, "name")).strip(),
        system_id=system.id,
        version_code=version_code,
        weight=weight,
        division_id=division_id,
        project_type=project_type,
        owner_text=(getattr(payload, "owner_text", "") or "").strip(),
        members_text=(getattr(payload, "members_text", "") or "").strip(),
        description=(getattr(payload, "description", "") or "").strip(),
        status=PROJECT_ACTIVE,
        started_at=utcnow(),
    )
    mark_created(project, account)
    db.add(project)
    db.flush()
    _instantiate_nodes(db, project, account, ctx)

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="project_created",
        target_type="project",
        target_id=project.id,
        summary=f"创建项目 {project.name}",
        detail={
            "code": project.code,
            "name": project.name,
            "project_type": project.project_type,
            "system_id": system.id,
            "version_code": project.version_code,
            "weight": project.weight,
            "division_id": project.division_id,
        },
    )
    return project


def _project_list_item(project: Project) -> dict[str, object]:
    node = current_node(project)
    return {
        "id": project.id,
        "code": project.code,
        "name": project.name,
        "system_id": project.system_id,
        "system_name": project.system.name if project.system else "",
        "version_code": project.version_code,
        "project_type": project.project_type,
        "project_type_label": PROJECT_TYPE_LABELS.get(project.project_type, project.project_type),
        "owner_text": project.owner_text,
        "division_name": project.division.name if project.division else "",
        "current_node_code": node.code if node else "",
        "current_node_name": node.name if node else "",
        "status": project.status,
        "status_label": PROJECT_STATUS_LABELS.get(project.status, project.status),
        "updated_by_name": project.updated_by_name,
        "updated_at": iso_z(project.updated_at),
    }


def list_projects(
    db: Session,
    *,
    keyword: str | None = None,
    project_type: str | None = None,
    status: str | None = None,
    system_id: str | None = None,
    division_id: str | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[dict[str, object]], int]:
    stmt = select(Project)
    if keyword:
        like = f"%{keyword.strip()}%"
        stmt = stmt.where(or_(Project.name.like(like), Project.code.like(like)))
    if project_type:
        stmt = stmt.where(Project.project_type == project_type)
    if status:
        stmt = stmt.where(Project.status == status)
    if system_id:
        stmt = stmt.where(Project.system_id == system_id)
    if division_id:
        stmt = stmt.where(Project.division_id == division_id)
    stmt = stmt.order_by(Project.updated_at.desc(), Project.code)
    rows, total = paginate(db, stmt, page=page, page_size=page_size)
    return [_project_list_item(row) for row in rows], total


def _system_of(db: Session, project: Project) -> dict[str, object]:
    system = project.system
    if system is None:
        return {}
    return {
        "id": system.id,
        "code": system.code,
        "name": system.name,
        "owner_text": system.owner_text,
        "scheme_id": system.scheme_id,
        "weight": project.weight,
    }


def _audit_timeline(db: Session, project: Project) -> list[dict[str, object]]:
    node_ids = [node.id for node in project.nodes]
    conditions = [
        (AuditLog.target_type == "project") & (AuditLog.target_id == project.id),
    ]
    if node_ids:
        conditions.append((AuditLog.target_type == "workflow_node") & (AuditLog.target_id.in_(node_ids)))
    rows = (
        db.execute(select(AuditLog).where(or_(*conditions)).order_by(AuditLog.created_at.desc()).limit(_AUDIT_TIMELINE_LIMIT))
        .scalars()
        .all()
    )
    return [
        {
            "action": row.action,
            "target_type": row.target_type,
            "target_id": row.target_id,
            "summary": row.summary,
            "actor_name": row.actor_name,
            "created_at": iso_z(row.created_at),
        }
        for row in rows
    ]


def project_detail(db: Session, project: Project) -> dict[str, object]:
    ordered = sorted(project.nodes, key=lambda n: n.node_order)
    return {
        "id": project.id,
        "code": project.code,
        "name": project.name,
        "system_id": project.system_id,
        "system_name": project.system.name if project.system else "",
        "version_code": project.version_code,
        "weight": project.weight,
        "division_id": project.division_id,
        "division_name": project.division.name if project.division else "",
        "project_type": project.project_type,
        "project_type_label": PROJECT_TYPE_LABELS.get(project.project_type, project.project_type),
        "owner_text": project.owner_text,
        "members_text": project.members_text,
        "description": project.description,
        "status": project.status,
        "status_label": PROJECT_STATUS_LABELS.get(project.status, project.status),
        "core_business_involved": project.core_business_involved,
        "core_business_reason": project.core_business_reason,
        "core_business_confirmed_at": iso_z(project.core_business_confirmed_at),
        "row_version": project.row_version,
        "created_at": iso_z(project.created_at),
        "updated_at": iso_z(project.updated_at),
        "created_by_name": project.created_by_name,
        "updated_by_name": project.updated_by_name,
        "nodes": [
            {
                "id": node.id,
                "code": node.code,
                "node_order": node.node_order,
                "stage_code": node.stage_code,
                "name": node.name,
                "status": node.status,
                "status_label": _node_status_label(node.status),
                "applicable": node_applicable(node.code, project.project_type),
            }
            for node in ordered
        ],
        "system": _system_of(db, project),
        "audit_timeline": _audit_timeline(db, project),
    }


def update_project(db: Session, project: Project, payload: object, account: Account, ctx: RequestContext) -> Project:
    check_row_version(project, getattr(payload, "expected_version", None), "项目")
    changes: dict[str, object] = {}

    version_code = getattr(payload, "version_code", None)
    if version_code is not None:
        version_code = str(version_code).strip()
        if version_code != project.version_code:
            changes["version_code"] = version_code
            project.version_code = version_code

    system_id = getattr(payload, "system_id", None)
    if system_id is not None and system_id != project.system_id:
        system = get_or_404(db, System, system_id, "系统")
        changes["system_id"] = system_id
        project.system_id = system_id

    for field in ("name", "owner_text", "members_text", "description", "status", "weight"):
        value = getattr(payload, field, None)
        if value is not None:
            new_value = value.strip() if isinstance(value, str) else value
            if getattr(project, field) != new_value:
                changes[field] = new_value
                setattr(project, field, new_value)
                if field == "status" and new_value == PROJECT_ARCHIVED:
                    project.closed_at = project.closed_at or utcnow()

    touch(project, account)
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="project_updated",
        target_type="project",
        target_id=project.id,
        summary=f"更新项目 {project.name}",
        detail=changes,
    )
    return project


def archive_project(db: Session, project: Project, *, reason: str | None, account: Account, ctx: RequestContext) -> Project:
    project.status = PROJECT_ARCHIVED
    project.closed_at = project.closed_at or utcnow()
    touch(project, account)
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="project_archived",
        target_type="project",
        target_id=project.id,
        summary=f"归档项目 {project.name}",
        detail={"reason": (reason or "").strip()},
    )
    return project


# ====================================================================== 核心业务判定


def submit_core_business(db: Session, project: Project, *, involved: bool, reason: str, account: Account, ctx: RequestContext) -> Project:
    if project.project_type != PROJECT_TYPE_ITERATION:
        raise ConflictError(
            "仅迭代产品需要提交核心业务判定",
            code="not_iteration",
            extra={"project_type": project.project_type},
        )
    project.core_business_involved = involved
    project.core_business_reason = reason.strip()
    project.core_business_confirmed_at = None  # 重新提交后需 N04 重新确认
    touch(project, account)
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="core_business_submitted",
        target_type="project",
        target_id=project.id,
        summary=f"提交核心业务判定：{'涉及' if involved else '不涉及'}",
        detail={"involved": involved, "reason": project.core_business_reason},
    )
    return project


def confirm_core_business(db: Session, project: Project, *, note: str, account: Account, ctx: RequestContext) -> Project:
    if project.project_type != PROJECT_TYPE_ITERATION:
        raise ConflictError(
            "仅迭代产品存在核心业务判定",
            code="not_iteration",
            extra={"project_type": project.project_type},
        )
    if project.core_business_involved is None:
        raise ConflictError(
            "尚未在 N03 提交核心业务判定",
            code="precondition_failed",
            extra={"reason": "请先在 N03 业务场景分析提交是否涉及核心业务及理由"},
        )
    nodes = nodes_by_code(project)
    n04 = nodes.get("N04")
    if n04 is None or n04.status != st.NODE_IN_PROGRESS:
        raise ConflictError(
            "仅 N04（内部业务场景评审）进行中时可确认核心业务判定",
            code="precondition_failed",
            extra={
                "required_node": "N04",
                "current_n04_status": n04.status if n04 else "",
                "reason": "核心业务判定由 N03 提交、N04 确认（DESIGN §6.1.3）",
            },
        )
    project.core_business_confirmed_at = utcnow()
    touch(project, account)
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="core_business_confirmed",
        target_type="project",
        target_id=project.id,
        summary=f"N04 确认核心业务判定：{'涉及' if project.core_business_involved else '不涉及'}",
        detail={"involved": project.core_business_involved, "note": note.strip()},
    )
    return project


# ====================================================================== 节点 guard 求值


def _start_blockers(project: Project, node: WorkflowNode, nodes: dict[str, WorkflowNode]) -> list[str]:
    """「未开始 → 进行中」的前置条件未满足项（上游 + N06 评审门禁）。"""
    failures: list[str] = []
    for dep in resolved_upstream(node.code, project.project_type):
        upstream = nodes.get(dep)
        if upstream is None or upstream.status not in (st.NODE_COMPLETED, st.NODE_NOT_APPLICABLE):
            current = _node_status_label(upstream.status) if upstream else "缺失"
            failures.append(f"上游节点 {dep} 未完成（当前：{current}）")
    if node.code in REVIEW_GATED_NODES:
        n04 = nodes.get("N04")
        if n04 is None or n04.status != st.NODE_COMPLETED:
            failures.append("需求评审未通过：N04 内部业务场景评审未完成")
        if node_applicable("N05", project.project_type):
            n05 = nodes.get("N05")
            if n05 is None or n05.status != st.NODE_COMPLETED:
                failures.append("外部评审未通过：N05 外部业务场景评审未完成")
    return failures


def _artifacts_for(db: Session, project: Project, node: WorkflowNode) -> list[Artifact]:
    return (
        db.execute(
            select(Artifact).where(
                Artifact.project_id == project.id,
                Artifact.node_id == node.id,
            )
        )
        .scalars()
        .all()
    )


def _missing_artifact_kinds(db: Session, project: Project, node: WorkflowNode) -> list[str]:
    by_kind: dict[str, list[Artifact]] = {}
    for artifact in _artifacts_for(db, project, node):
        by_kind.setdefault(artifact.kind, []).append(artifact)
    missing: list[str] = []
    for kind in NODE_BY_CODE[node.code].artifact_kinds:
        items = by_kind.get(kind, [])
        confirmed = any(a.status == st.ARTIFACT_CONFIRMED for a in items)
        marked_na = any(
            a.status == st.ARTIFACT_NOT_APPLICABLE and (a.not_applicable_reason or "").strip()
            for a in items
        )
        if not (confirmed or marked_na):
            missing.append(kind)
    return missing


def _kind_label(kind: str) -> str:
    template = TEMPLATE_BY_KIND.get(kind)
    return f"{template.name}（{kind}）" if template else kind


def _artifact_summary(db: Session, project: Project, node: WorkflowNode) -> list[dict[str, object]]:
    by_kind: dict[str, list[Artifact]] = {}
    for artifact in _artifacts_for(db, project, node):
        by_kind.setdefault(artifact.kind, []).append(artifact)
    summary: list[dict[str, object]] = []
    for kind in NODE_BY_CODE[node.code].artifact_kinds:
        template = TEMPLATE_BY_KIND.get(kind)
        items = by_kind.get(kind, [])
        if not items:
            summary.append(
                {
                    "artifact_id": None,
                    "kind": kind,
                    "template_name": template.name if template else kind,
                    "status": "missing",
                    "status_label": _artifact_status_label("missing"),
                }
            )
        else:
            primary = items[0]
            summary.append(
                {
                    "artifact_id": primary.id,
                    "kind": kind,
                    "template_name": template.name if template else kind,
                    "status": primary.status,
                    "status_label": _artifact_status_label(primary.status),
                }
            )
    return summary


def _blocked_reason(db: Session, project: Project, node: WorkflowNode, nodes: dict[str, WorkflowNode]) -> str:
    if node.status in (st.NODE_COMPLETED, st.NODE_NOT_APPLICABLE):
        return ""
    if node.status == st.NODE_NOT_STARTED:
        if not node_applicable(node.code, project.project_type):
            return "本节点不适用于当前项目类型"
        return "；".join(_start_blockers(project, node, nodes))
    if node.status == st.NODE_IN_PROGRESS:
        missing = _missing_artifact_kinds(db, project, node)
        if missing:
            return "必需产物尚未确认：" + "、".join(_kind_label(kind) for kind in missing)
    return ""


def _downstream_stale(project: Project, node: WorkflowNode) -> list[dict[str, str]]:
    stale = [
        n
        for n in sorted(project.nodes, key=lambda x: x.node_order)
        if n.node_order > node.node_order and n.status in (st.NODE_IN_PROGRESS, st.NODE_COMPLETED)
    ]
    return [
        {"code": n.code, "name": n.name, "status": n.status, "status_label": _node_status_label(n.status)}
        for n in stale
    ]


# ====================================================================== 节点序列化


def node_payload(db: Session, project: Project, node: WorkflowNode) -> dict[str, object]:
    spec = NODE_BY_CODE[node.code]
    stage = STAGE_BY_CODE.get(node.stage_code)
    nodes = nodes_by_code(project)
    artifact_summary = _artifact_summary(db, project, node)
    return {
        "id": node.id,
        "project_id": node.project_id,
        "code": node.code,
        "node_order": node.node_order,
        "stage_code": node.stage_code,
        "stage_name": stage.name if stage else "",
        "name": node.name,
        "scope": node.scope,
        "owner": spec.owner,
        "collaborators": spec.collaborators,
        "duration_days": node.duration_days,
        "outputs": node.outputs_text,
        "status": node.status,
        "status_label": _node_status_label(node.status),
        "allow_not_applicable": node.allow_not_applicable,
        "iteration_only": node.iteration_only,
        "applicable": node_applicable(node.code, project.project_type),
        "planned_start_at": iso_z(node.planned_start_at),
        "planned_end_at": iso_z(node.planned_end_at),
        "actual_start_at": iso_z(node.actual_start_at),
        "actual_end_at": iso_z(node.actual_end_at),
        "not_applicable_reason": node.not_applicable_reason,
        "note": node.note,
        "blocked_reason": _blocked_reason(db, project, node, nodes),
        "artifact_summary": artifact_summary,
        "artifact_count": sum(1 for item in artifact_summary if item.get("artifact_id") is not None),
        "allowed_actions": _allowed_actions(node.status),
    }


def list_nodes(db: Session, project: Project) -> list[dict[str, object]]:
    return [
        node_payload(db, project, node)
        for node in sorted(project.nodes, key=lambda n: n.node_order)
    ]


def node_specs_payload() -> dict[str, object]:
    return {
        "stages": [{"code": s.code, "name": s.name, "order": s.order} for s in STAGES],
        "nodes": [
            {
                "code": spec.code,
                "order": spec.order,
                "stage_code": spec.stage_code,
                "stage_name": STAGE_BY_CODE[spec.stage_code].name,
                "name": spec.name,
                "scope": spec.scope,
                "owner": spec.owner,
                "collaborators": spec.collaborators,
                "duration_days": spec.duration_days,
                "outputs": spec.outputs,
                "artifact_kinds": list(spec.artifact_kinds),
                "upstream_deps": list(spec.upstream_deps),
                "allow_not_applicable": spec.allow_not_applicable,
                "iteration_only": spec.iteration_only,
                "review_gated": spec.code in REVIEW_GATED_NODES,
            }
            for spec in NODE_SPECS
        ],
        "project_types": [
            {"value": value, "label": PROJECT_TYPE_LABELS[value]} for value in PROJECT_TYPES
        ],
    }


def _issue_refs_node(issue: Issue, node: WorkflowNode, artifact_ids: set[str]) -> bool:
    try:
        refs = json.loads(issue.source_refs_json or "[]")
    except (TypeError, ValueError):
        return False
    if not isinstance(refs, list):
        return False
    for ref in refs:
        if isinstance(ref, dict):
            if ref.get("node_id") == node.id or ref.get("node_code") == node.code:
                return True
            if ref.get("artifact_id") in artifact_ids:
                return True
        elif isinstance(ref, str) and (ref == node.id or ref == node.code):
            return True
    return False


def _issue_stats(db: Session, project: Project, node: WorkflowNode) -> dict[str, object]:
    artifact_ids = {a.id for a in _artifacts_for(db, project, node)}
    issues = (
        db.execute(select(Issue).where(Issue.project_id == project.id)).scalars().all()
    )
    matched = [issue for issue in issues if _issue_refs_node(issue, node, artifact_ids)]
    by_status: dict[str, int] = {}
    for issue in matched:
        by_status[issue.status] = by_status.get(issue.status, 0) + 1
    return {"total": len(matched), "by_status": by_status}


def _steps_for(node: WorkflowNode) -> list[str]:
    kinds = "、".join(_kind_label(kind) for kind in NODE_BY_CODE[node.code].artifact_kinds)
    return [
        f"确认上游节点已完成，开始「{node.name}」",
        f"填写并确认必需产物：{kinds}",
        "满足完成条件后完成本节点，进入下一节点",
    ]


def _completion_conditions(project: Project, node: WorkflowNode) -> list[str]:
    conditions = [
        "上游必需节点全部为「已完成」或「不适用」",
    ]
    for kind in NODE_BY_CODE[node.code].artifact_kinds:
        conditions.append(f"产物「{_kind_label(kind)}」已确认，或标记不适用并填写理由")
    if node.code in REVIEW_GATED_NODES:
        conditions.append("N04 内部业务场景评审已通过" + ("，且 N05 外部业务场景评审已通过" if node_applicable("N05", project.project_type) else ""))
    conditions.append("满足完成判定后由体验人员点击「完成节点」")
    return conditions


def node_detail(db: Session, project: Project, node: WorkflowNode, *, downstream_stale: list[dict[str, str]] | None = None) -> dict[str, object]:
    spec = NODE_BY_CODE[node.code]
    nodes = nodes_by_code(project)
    data = node_payload(db, project, node)
    inputs = []
    for dep in resolved_upstream(node.code, project.project_type):
        upstream = nodes.get(dep)
        if upstream is None:
            continue
        inputs.append(
            {
                "code": upstream.code,
                "name": upstream.name,
                "status": upstream.status,
                "status_label": _node_status_label(upstream.status),
                "applicable": node_applicable(upstream.code, project.project_type),
            }
        )
    artifacts = [
        {
            "id": artifact.id,
            "kind": artifact.kind,
            "template_name": TEMPLATE_BY_KIND[artifact.kind].name if artifact.kind in TEMPLATE_BY_KIND else artifact.kind,
            "title": artifact.title,
            "status": artifact.status,
            "status_label": _artifact_status_label(artifact.status),
        }
        for artifact in _artifacts_for(db, project, node)
    ]
    data.update(
        {
            "scene_explanation": {
                "scope": spec.scope,
                "owner": spec.owner,
                "collaborators": spec.collaborators,
                "duration_days": spec.duration_days,
                "outputs": spec.outputs,
            },
            "inputs": inputs,
            "steps": _steps_for(node),
            "artifacts": artifacts,
            "issue_stats": _issue_stats(db, project, node),
            "completion_conditions": _completion_conditions(project, node),
            "history": [
                {
                    "action": event.action,
                    "action_label": _node_status_label(event.to_status),
                    "from_status": event.from_status,
                    "to_status": event.to_status,
                    "reason": event.reason,
                    "actor_name": event.actor_name,
                    "created_at": iso_z(event.created_at),
                }
                for event in node.events
            ],
            "downstream_stale": downstream_stale or [],
        }
    )
    return data


# ====================================================================== 阶段看板


def board(db: Session, project: Project) -> dict[str, object]:
    stages = []
    for stage in STAGES:
        cards = []
        for node in sorted(project.nodes, key=lambda n: n.node_order):
            if node.stage_code != stage.code:
                continue
            payload = node_payload(db, project, node)
            blocked = str(payload["blocked_reason"])
            cards.append(
                {
                    "id": node.id,
                    "code": node.code,
                    "node_order": node.node_order,
                    "stage_code": node.stage_code,
                    "stage_name": stage.name,
                    "name": node.name,
                    "status": node.status,
                    "status_label": _node_status_label(node.status),
                    "duration_days": node.duration_days,
                    "outputs": node.outputs_text,
                    "allow_not_applicable": node.allow_not_applicable,
                    "applicable": node_applicable(node.code, project.project_type),
                    "blocking": bool(blocked),
                    "blocked_reason": blocked,
                    "artifact_summary": payload["artifact_summary"],
                    "artifact_count": payload["artifact_count"],
                    "allowed_actions": payload["allowed_actions"],
                }
            )
        stages.append({"code": stage.code, "name": stage.name, "order": stage.order, "nodes": cards})
    return {
        "project": {
            "id": project.id,
            "code": project.code,
            "name": project.name,
            "project_type": project.project_type,
            "project_type_label": PROJECT_TYPE_LABELS.get(project.project_type, project.project_type),
            "system_name": project.system.name if project.system else "",
            "version_code": project.version_code,
            "division_name": project.division.name if project.division else "",
            "status": project.status,
        },
        "stages": stages,
    }


# ====================================================================== 节点状态迁移


def _raise_guard_conflict(
    *,
    current: str,
    target: str,
    failures: list[str],
    missing_kinds: list[str] | None = None,
    allowed_targets: list[str] | None = None,
) -> None:
    extra: dict[str, object] = {
        "machine": "node",
        "current": current,
        "target": target,
        "reason": "；".join(failures),
        "failed_guards": failures,
    }
    if missing_kinds:
        extra["missing_artifact_kinds"] = missing_kinds
    if allowed_targets is not None:
        extra["allowed_targets"] = allowed_targets
    raise ConflictError("节点当前不满足迁移前置条件", code="precondition_failed", extra=extra)


def transition_node(db: Session, project: Project, node: WorkflowNode, payload: object, account: Account, ctx: RequestContext) -> dict[str, object]:
    check_row_version(node, getattr(payload, "expected_version", None), "节点")
    current = node.status
    action = getattr(payload, "action", None)
    explicit_target = getattr(payload, "target", None)

    transition: st.Transition | None = None
    if action:
        transition = next(
            (t for t in st.NODE_TRANSITIONS if t.source == current and t.action == action),
            None,
        )
        if transition is not None:
            target = transition.target
        else:
            # 未声明的动作：目标取显式 target，否则取动作名，便于响应明确回显 current/target
            target = explicit_target or action
    else:
        target = explicit_target
        transition = st.find_transition("node", current, target)

    label = f"节点 {node.code} {node.name}"
    if target is None:
        raise ConflictError(
            f"{label}必须提供目标状态",
            code="illegal_transition",
            extra={"machine": "node", "current": current, "target": None, "allowed_targets": list(st.allowed_targets("node", current))},
        )

    # 合法性 + 理由校验（非法迁移 409，缺理由 422）
    check_transition("node", current=current, target=target, reason=getattr(payload, "reason", None), label=label)

    nodes = nodes_by_code(project)
    reason = (getattr(payload, "reason", None) or "").strip()
    stale: list[dict[str, str]] = []

    if transition is not None and transition.guards:
        failures: list[str] = []
        missing_kinds: list[str] = []
        if "upstream_done" in transition.guards or "review_gate" in transition.guards:
            failures.extend(_start_blockers(project, node, nodes))
        if "allow_na" in transition.guards and not node.allow_not_applicable:
            failures.append(f"节点 {node.code} {node.name} 不允许标记为不适用")
        if "required_artifacts_confirmed" in transition.guards:
            missing_kinds = _missing_artifact_kinds(db, project, node)
            if missing_kinds:
                failures.append("必需产物未确认：" + "、".join(_kind_label(kind) for kind in missing_kinds))
        if "no_confirmed_artifact" in transition.guards:
            has_confirmed = any(a.status == st.ARTIFACT_CONFIRMED for a in _artifacts_for(db, project, node))
            if has_confirmed:
                failures.append("本节点已存在已确认产物，不能标记为不适用")
        if "downstream_check" in transition.guards:
            stale = _downstream_stale(project, node)
        if failures:
            _raise_guard_conflict(
                current=current,
                target=target,
                failures=failures,
                missing_kinds=missing_kinds or None,
                allowed_targets=list(st.allowed_targets("node", current)),
            )

    from_status = current
    now = utcnow()
    node.status = target
    if target == st.NODE_IN_PROGRESS:
        if from_status == st.NODE_NOT_STARTED:
            node.actual_start_at = node.actual_start_at or now
        elif from_status == st.NODE_COMPLETED:
            node.actual_end_at = None
    elif target == st.NODE_COMPLETED:
        node.actual_end_at = now
    elif target == st.NODE_NOT_APPLICABLE:
        node.not_applicable_reason = reason
        node.actual_end_at = now
    elif target == st.NODE_NOT_STARTED:
        node.not_applicable_reason = ""
    touch(node, account)

    event_reason = reason
    if stale:
        detail_text = "下游可能过期：" + "、".join(
            f"{item['code']} {item['name']}({item['status_label']})" for item in stale
        )
        event_reason = f"{reason}｜{detail_text}" if reason else detail_text

    event = WorkflowNodeEvent(
        id=new_id(),
        node_id=node.id,
        project_id=project.id,
        action=action or f"to_{target}",
        from_status=from_status,
        to_status=target,
        reason=event_reason,
        actor_account_id=account.id,
        actor_name=account.name,
        request_id=ctx.request_id,
        created_at=now,
    )
    db.add(event)
    node.events.append(event)
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action=f"node_{action or target}",
        target_type="workflow_node",
        target_id=node.id,
        summary=f"{node.code} {node.name}：{_node_status_label(from_status)} → {_node_status_label(target)}",
        detail={
            "project_id": project.id,
            "code": node.code,
            "from_status": from_status,
            "to_status": target,
            "reason": reason,
            "downstream_stale": stale,
        },
    )
    return node_detail(db, project, node, downstream_stale=stale)


# ====================================================================== 导出


__all__ = [
    "archive_division",
    "archive_project",
    "board",
    "confirm_core_business",
    "create_division",
    "create_project",
    "current_node",
    "division_out",
    "list_divisions",
    "list_nodes",
    "list_projects",
    "node_detail",
    "node_payload",
    "node_specs_payload",
    "nodes_by_code",
    "project_detail",
    "submit_core_business",
    "transition_node",
    "update_division",
    "update_project",
]
