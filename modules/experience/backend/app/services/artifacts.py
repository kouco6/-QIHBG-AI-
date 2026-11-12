"""结构化产物服务（T05 / PRD §7.3 / DESIGN §6.2.2、§6.3、§6.6）。

核心不变量：

1. **追加写版本**：已提交 / 已确认版本 ``is_frozen=True``，**永不原位修改**；
   冻结后再编辑必须复制为新版本（``version_no + 1``、``source_version_no`` 指向被复制版本）。
2. **状态机唯一权威**：所有迁移经 :func:`app.services.common.check_transition`
   校验，非法迁移 409 并携带 ``current`` / ``target`` / ``reason`` / ``allowed_targets``。
3. **首次必填 ≤ 8**：提交时按 ``domain.templates.required_fields`` 自检；超限视为
   模板配置错误返回 409（PRD §7.3 / REQUIREMENTS §9）。
4. **代录完整性**：确认时若 payload 含 ``signatures`` 行，每行「实际提供人」必须非空，
   否则 422 并提示走代录（问题 / 代录由 T07 承载，本模块只做结构校验）。
5. **问题引用**：产物只保存 ``issue.id`` 引用，不复制问题实体。
"""

from __future__ import annotations

import datetime as _dt
import json
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.core.security import new_id
from app.core.timeutil import iso_z, utcnow
from app.domain import states as st
from app.domain import templates as tpl
from app.domain.nodes import NODE_BY_CODE
from app.models.account import Account
from app.models.artifact import Artifact, ArtifactTemplate, ArtifactVersion
from app.models.flow import Project, WorkflowNode
from app.models.issue import Issue
from app.services.common import (
    check_transition,
    get_or_404,
    paginate,
    require_reason,
    touch,
)

MACHINE = "artifact"
LABEL = "产物"

# 不允许被覆盖的产物状态（用于重复创建判定）
NON_ARCHIVED_STATUSES: tuple[str, ...] = (
    st.ARTIFACT_DRAFT,
    st.ARTIFACT_SUBMITTED,
    st.ARTIFACT_RETURNED,
    st.ARTIFACT_CONFIRMED,
)


# ============================================================================= 模板


def _parse_fields(schema_json: str | None) -> list[dict[str, Any]]:
    try:
        data = json.loads(schema_json or "[]")
    except (TypeError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict) and item.get("key")]


def list_templates(db: Session, *, node_code: str | None = None) -> list[ArtifactTemplate]:
    stmt = select(ArtifactTemplate).order_by(ArtifactTemplate.node_code, ArtifactTemplate.kind)
    if node_code:
        stmt = stmt.where(ArtifactTemplate.node_code == node_code)
    return list(db.execute(stmt).scalars())


def get_template(db: Session, kind: str) -> ArtifactTemplate:
    row = db.get(ArtifactTemplate, kind)
    if row is None:
        raise NotFoundError(f"产物模板不存在：{kind}")
    return row


def template_fields(db: Session, kind: str) -> list[dict[str, Any]]:
    """字段定义：以模板表（数据）为准，缺失时回落到领域定义（单一数据源）。"""
    row = db.get(ArtifactTemplate, kind)
    if row is not None:
        fields = _parse_fields(row.schema_json)
        if fields:
            return fields
    spec = tpl.TEMPLATE_BY_KIND.get(kind)
    if spec is None:
        return []
    return [
        {
            "key": f.key,
            "label": f.label,
            "type": f.type,
            "required": f.required,
            "group": f.group,
            "help": f.help,
            "options": list(f.options),
            "columns": list(f.columns),
            "max_length": f.max_length,
        }
        for f in spec.fields
    ]


def template_allow_na(db: Session, kind: str) -> bool:
    row = db.get(ArtifactTemplate, kind)
    if row is not None:
        return bool(row.allow_not_applicable)
    spec = tpl.TEMPLATE_BY_KIND.get(kind)
    return bool(spec.allow_not_applicable) if spec else False


def template_available(db: Session, kind: str) -> bool:
    return db.get(ArtifactTemplate, kind) is not None or kind in tpl.TEMPLATE_BY_KIND


def serialize_template_row(row: ArtifactTemplate) -> dict[str, Any]:
    fields = _parse_fields(row.schema_json)
    return {
        "kind": row.kind,
        "name": row.name,
        "node_code": row.node_code,
        "allow_not_applicable": bool(row.allow_not_applicable),
        "description": row.description or "",
        "template_version": int(row.template_version or 1),
        "is_active": bool(row.is_active),
        "required_count": sum(1 for f in fields if f.get("required")),
        "fields": fields,
    }


def serialize_template_fallback(kind: str) -> dict[str, Any]:
    """模板表缺失时的兜底视图，保证详情接口始终可用。"""
    spec = tpl.TEMPLATE_BY_KIND.get(kind)
    if spec is None:
        return {
            "kind": kind,
            "name": kind,
            "node_code": "",
            "allow_not_applicable": False,
            "description": "",
            "template_version": 1,
            "is_active": True,
            "required_count": 0,
            "fields": [],
        }
    return {
        "kind": spec.kind,
        "name": spec.name,
        "node_code": spec.node_code,
        "allow_not_applicable": spec.allow_not_applicable,
        "description": spec.description,
        "template_version": 1,
        "is_active": True,
        "required_count": sum(1 for f in spec.fields if f.required),
        "fields": [
            {
                "key": f.key,
                "label": f.label,
                "type": f.type,
                "required": f.required,
                "group": f.group,
                "help": f.help,
                "options": list(f.options),
                "columns": list(f.columns),
                "max_length": f.max_length,
            }
            for f in spec.fields
        ],
    }


# ============================================================================= payload


def payload_of(version: ArtifactVersion | None) -> dict[str, Any]:
    if version is None:
        return {}
    try:
        data = json.loads(version.payload_json or "{}")
    except (TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def issue_ids_of(version: ArtifactVersion | None) -> list[str]:
    if version is None:
        return []
    try:
        data = json.loads(version.issue_ids_json or "[]")
    except (TypeError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    return [str(x) for x in data]


def _is_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    if isinstance(value, (list, tuple, dict, set)):
        return len(value) == 0
    return False


def _rows(value: Any, columns: list[str] | None = None) -> list[dict[str, Any]]:
    """把表格 / 勾选式字段归一为「行 = 列名 → 值」的字典列表。

    兼容三种写法：``[{列名: 值}]``、``[[v1, v2]]``（按 columns 对齐）、``{rows: [...]}``。
    """
    data = value
    if isinstance(data, dict):
        data = data.get("rows", [])
    if not isinstance(data, list):
        return []
    cols = list(columns or [])
    out: list[dict[str, Any]] = []
    for index, row in enumerate(data):
        if isinstance(row, dict):
            out.append({str(k): v for k, v in row.items()})
        elif isinstance(row, (list, tuple)):
            out.append(
                {cols[i] if i < len(cols) else f"col{i + 1}": v for i, v in enumerate(row)}
            )
        else:
            out.append({cols[0] if cols else "col1": row})
    return out


def validate_required_fields(
    fields: list[dict[str, Any]], payload: dict[str, Any]
) -> list[dict[str, Any]]:
    """按模板 required 校验 payload；返回 ``field_errors``。"""
    problems: list[dict[str, Any]] = []
    for field in fields:
        if not field.get("required"):
            continue
        key = str(field.get("key") or "")
        label = str(field.get("label") or key)
        ftype = str(field.get("type") or tpl.F_TEXT)
        value = payload.get(key)
        if ftype in (tpl.F_TABLE, tpl.F_CHECKLIST):
            rows = _rows(value, field.get("columns"))
            if not rows:
                problems.append(
                    {
                        "field": key,
                        "message": f"「{label}」至少需要录入 1 行",
                        "type": "value_error",
                    }
                )
                continue
            if not any(any(not _is_empty(v) for v in row.values()) for row in rows):
                problems.append(
                    {
                        "field": key,
                        "message": f"「{label}」的行内容不能为空",
                        "type": "value_error",
                    }
                )
        elif _is_empty(value):
            problems.append(
                {"field": key, "message": f"请填写「{label}」", "type": "value_error"}
            )
    return problems


def signature_problems(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """签名表「实际提供人」完整性校验（代录强制留痕，REQUIREMENTS §2.2）。"""
    rows = _rows(payload.get("signatures"))
    problems: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        provider = ""
        for key, value in row.items():
            if "实际提供人" in str(key):
                provider = value
                break
        if _is_empty(provider):
            problems.append(
                {
                    "field": "signatures",
                    "row": index,
                    "message": f"签名表第 {index + 1} 行缺少「实际提供人」，请通过代录填写",
                    "type": "proxy_required",
                }
            )
    return problems


# ============================================================================= 版本


def _version_by_no(db: Session, artifact_id: str, version_no: int) -> ArtifactVersion | None:
    stmt = select(ArtifactVersion).where(
        ArtifactVersion.artifact_id == artifact_id,
        ArtifactVersion.version_no == version_no,
    )
    return db.execute(stmt).scalars().first()


def _max_version_no(db: Session, artifact_id: str) -> int:
    stmt = select(func.max(ArtifactVersion.version_no)).where(
        ArtifactVersion.artifact_id == artifact_id
    )
    return int(db.execute(stmt).scalar() or 0)


def current_version(db: Session, artifact: Artifact) -> ArtifactVersion | None:
    return _version_by_no(db, artifact.id, artifact.current_version_no)


def _new_version(
    db: Session,
    artifact: Artifact,
    *,
    account: Account,
    payload: dict[str, Any] | None,
    status: str = st.ARTIFACT_DRAFT,
    is_frozen: bool = False,
    change_note: str = "",
    source_version_no: int | None = None,
) -> ArtifactVersion:
    """追加一个新版本，并把产物当前版本号指向它。"""
    now = utcnow()
    version = ArtifactVersion(
        id=new_id(),
        artifact_id=artifact.id,
        version_no=_max_version_no(db, artifact.id) + 1,
        status=status,
        payload_json=json.dumps(payload or {}, ensure_ascii=False),
        is_frozen=is_frozen,
        change_note=change_note,
        source_version_no=source_version_no,
        issue_ids_json="[]",
        created_by=account.id,
        created_by_name=account.name,
        request_id="",
        created_at=now,
        updated_at=now,
    )
    db.add(version)
    artifact.current_version_no = version.version_no
    return version


# ============================================================================= 产物


def get_artifact(db: Session, artifact_id: str | None) -> Artifact:
    return get_or_404(db, Artifact, artifact_id, LABEL)


def list_artifacts(
    db: Session,
    *,
    project_id: str | None = None,
    node_id: str | None = None,
    kind: str | None = None,
    status: str | None = None,
    page: int = 1,
    page_size: int = 50,
) -> tuple[list[Artifact], int]:
    stmt = select(Artifact)
    if project_id:
        stmt = stmt.where(Artifact.project_id == project_id)
    if node_id:
        stmt = stmt.where(Artifact.node_id == node_id)
    if kind:
        stmt = stmt.where(Artifact.kind == kind)
    if status:
        stmt = stmt.where(Artifact.status == status)
    stmt = stmt.order_by(Artifact.updated_at.desc(), Artifact.created_at.desc())
    rows, total = paginate(db, stmt, page=page, page_size=page_size)
    return list(rows), total


def existing_artifact(db: Session, *, node_id: str, kind: str) -> Artifact | None:
    stmt = (
        select(Artifact)
        .where(
            Artifact.node_id == node_id,
            Artifact.kind == kind,
            Artifact.status.in_(NON_ARCHIVED_STATUSES),
        )
        .limit(1)
    )
    return db.execute(stmt).scalars().first()


def resolve_node(
    db: Session, *, project: Project, node_id: str | None, node_code: str | None
) -> WorkflowNode:
    """解析并校验产物归属节点（必须属于该项目）。"""
    if node_id:
        node = get_or_404(db, WorkflowNode, node_id, "节点")
    elif node_code:
        node = db.execute(
            select(WorkflowNode).where(
                WorkflowNode.project_id == project.id, WorkflowNode.code == node_code
            )
        ).scalars().first()
        if node is None:
            raise NotFoundError(f"项目下不存在节点：{node_code}")
    else:
        raise ValidationError(
            "必须提供 node_id 或 node_code",
            field_errors=[{"field": "node_id", "message": "请选择节点", "type": "value_error"}],
        )
    if node.project_id != project.id:
        raise ValidationError(
            "节点不属于该项目",
            field_errors=[
                {"field": "node_id", "message": "所选节点与项目不匹配", "type": "value_error"}
            ],
        )
    return node


def check_kind_for_node(kind: str, node: WorkflowNode) -> None:
    """产物类型必须存在，且属于该节点的 artifact_kinds。"""
    if kind not in tpl.TEMPLATE_BY_KIND:
        raise ValidationError(
            "产物类型不存在",
            field_errors=[
                {"field": "kind", "message": f"未知产物类型：{kind}", "type": "value_error"}
            ],
        )
    spec = NODE_BY_CODE.get(node.code)
    allowed = tuple(spec.artifact_kinds) if spec else ()
    if kind not in allowed:
        raise ValidationError(
            "产物类型与节点不匹配",
            field_errors=[
                {
                    "field": "kind",
                    "message": f"节点 {node.code} 不支持产物类型 {kind}",
                    "type": "value_error",
                }
            ],
        )


def create_artifact(
    db: Session,
    *,
    account: Account,
    project: Project,
    node: WorkflowNode,
    kind: str,
    title: str,
    collaborators_text: str = "",
    payload: dict[str, Any] | None = None,
) -> Artifact:
    duplicated = existing_artifact(db, node_id=node.id, kind=kind)
    if duplicated is not None:
        raise ConflictError(
            "该节点下同类型产物已存在，请复用既有产物继续编辑，避免重复登记。",
            code="artifact_exists",
            extra={
                "artifact_id": duplicated.id,
                "current_status": duplicated.status,
                "allowed_targets": [],
                "reason": "同一节点 + 产物类型只允许一份未归档产物",
            },
        )

    now = utcnow()
    artifact = Artifact(
        id=new_id(),
        project_id=project.id,
        node_id=node.id,
        node_code=node.code,
        kind=kind,
        title=(title or "").strip()[:200],
        status=st.ARTIFACT_DRAFT,
        current_version_no=1,
        collaborators_text=collaborators_text or "",
        not_applicable_reason="",
        last_saved_at=None,
        submitted_at=None,
        confirmed_at=None,
        created_by=account.id,
        created_by_name=account.name,
        updated_by=account.id,
        updated_by_name=account.name,
        row_version=1,
        created_at=now,
        updated_at=now,
    )
    db.add(artifact)
    db.flush()
    db.add(
        ArtifactVersion(
            id=new_id(),
            artifact_id=artifact.id,
            version_no=1,
            status=st.ARTIFACT_DRAFT,
            payload_json=json.dumps(payload or {}, ensure_ascii=False),
            is_frozen=False,
            change_note="",
            source_version_no=None,
            issue_ids_json="[]",
            created_by=account.id,
            created_by_name=account.name,
            request_id="",
            created_at=now,
            updated_at=now,
        )
    )
    db.commit()
    db.refresh(artifact)
    return artifact


def update_artifact(
    db: Session,
    *,
    artifact: Artifact,
    account: Account,
    title: str | None = None,
    collaborators_text: str | None = None,
) -> Artifact:
    if title is not None:
        artifact.title = title.strip()[:200]
    if collaborators_text is not None:
        artifact.collaborators_text = collaborators_text
    touch(artifact, account)
    artifact.updated_at = utcnow()
    db.commit()
    db.refresh(artifact)
    return artifact


def save_draft(
    db: Session,
    *,
    artifact: Artifact,
    account: Account,
    payload: dict[str, Any],
    autosave: bool = True,
) -> tuple[ArtifactVersion, _dt.datetime]:
    """草稿自动保存（DESIGN §6.2.2：30 秒或失焦）。

    - 当前版本未冻结：**原位更新** payload（同一 version_no）；
    - 当前版本已冻结（已提交 / 已确认）：**复制为新版本**后再写入，
      旧版本保持不可变（ACCEPTANCE：确认版不可原位覆盖）。
    """
    if not isinstance(payload, dict):
        raise ValidationError(
            "payload 必须是 JSON 对象",
            field_errors=[{"field": "payload", "message": "payload 必须是对象", "type": "value_error"}],
        )

    version = current_version(db, artifact)
    if version is None:
        raise NotFoundError("产物当前版本不存在")

    saved_at = utcnow()
    merged = {**payload_of(version), **payload}
    if version.is_frozen:
        version = _new_version(
            db,
            artifact,
            account=account,
            payload=merged,
            status=st.ARTIFACT_DRAFT,
            is_frozen=False,
            change_note=f"自版本 {version.version_no} 自动保存复制",
            source_version_no=version.version_no,
        )
    else:
        version.payload_json = json.dumps(merged, ensure_ascii=False)
        version.updated_at = saved_at

    artifact.last_saved_at = saved_at
    artifact.updated_at = saved_at
    db.commit()
    db.refresh(version)
    return version, saved_at


def submit(
    db: Session,
    *,
    artifact: Artifact,
    account: Account,
    payload: dict[str, Any] | None = None,
    change_note: str = "",
) -> ArtifactVersion:
    """草稿 → 已提交：必填与结构校验通过后冻结当前版本。"""
    check_transition(
        MACHINE, current=artifact.status, target=st.ARTIFACT_SUBMITTED, reason=None, label=LABEL
    )
    version = current_version(db, artifact)
    if version is None:
        raise NotFoundError("产物当前版本不存在")
    if version.is_frozen:
        raise ConflictError(
            "当前版本已冻结，请先创建新的编辑版本再提交",
            code="version_frozen",
            extra={
                "current": artifact.status,
                "target": st.ARTIFACT_SUBMITTED,
                "reason": "冻结版本不可原位修改",
                "allowed_targets": [],
            },
        )

    data = {**payload_of(version), **(payload or {})}
    problems = validate_required_fields(template_fields(db, artifact.kind), data)
    if problems:
        raise ValidationError("提交失败：必填字段未完成", field_errors=problems)

    # 自检：首次必填不得超过 8 项（REQUIREMENTS §9 / DESIGN §6.7）
    required = tpl.required_fields(artifact.kind) if artifact.kind in tpl.TEMPLATE_BY_KIND else ()
    if len(required) > tpl.FIRST_SUBMIT_REQUIRED_MAX:
        raise ConflictError(
            "模板配置错误：首次提交必填字段超过 8 项",
            code="template_required_overflow",
            extra={
                "kind": artifact.kind,
                "required_count": len(required),
                "max_required": tpl.FIRST_SUBMIT_REQUIRED_MAX,
                "current": artifact.status,
                "target": st.ARTIFACT_SUBMITTED,
                "reason": "首次必填字段数量超过上限",
                "allowed_targets": list(st.allowed_targets(MACHINE, artifact.status)),
            },
        )

    now = utcnow()
    version.payload_json = json.dumps(data, ensure_ascii=False)
    version.is_frozen = True
    version.status = st.ARTIFACT_SUBMITTED
    if change_note:
        version.change_note = change_note.strip()
    version.updated_at = now

    artifact.status = st.ARTIFACT_SUBMITTED
    artifact.submitted_at = now
    artifact.updated_at = now
    db.commit()
    db.refresh(version)
    return version


def confirm(db: Session, *, artifact: Artifact, account: Account) -> ArtifactVersion:
    """已提交 → 已确认：校验签名表实际提供人后冻结当前版本。"""
    check_transition(
        MACHINE, current=artifact.status, target=st.ARTIFACT_CONFIRMED, reason=None, label=LABEL
    )
    version = current_version(db, artifact)
    if version is None:
        raise NotFoundError("产物当前版本不存在")

    problems = signature_problems(payload_of(version))
    if problems:
        raise ValidationError(
            "确认失败：签名表缺少实际提供人，请通过代录填写", field_errors=problems
        )

    now = utcnow()
    version.status = st.ARTIFACT_CONFIRMED
    version.updated_at = now
    artifact.status = st.ARTIFACT_CONFIRMED
    artifact.confirmed_at = now
    artifact.updated_at = now
    db.commit()
    db.refresh(version)
    return version


def return_artifact(
    db: Session, *, artifact: Artifact, account: Account, reason: str
) -> tuple[Artifact, str]:
    """已提交 → 已退回；退回原因必填。"""
    check_transition(
        MACHINE,
        current=artifact.status,
        target=st.ARTIFACT_RETURNED,
        reason=reason,
        label=LABEL,
    )
    text = reason.strip()
    now = utcnow()
    artifact.status = st.ARTIFACT_RETURNED
    artifact.updated_at = now
    db.commit()
    db.refresh(artifact)
    return artifact, text


def resume(
    db: Session,
    *,
    artifact: Artifact,
    account: Account,
    reason: str = "",
    change_note: str = "",
) -> ArtifactVersion:
    """已退回 / 已确认 / 不适用 → 草稿。

    - 已退回：解冻当前版本继续编辑（需填写恢复原因）；
    - 已确认：**必须**填写变更原因，并以确认版复制为新的草稿版本，旧版本保持不变；
    - 不适用：填写恢复原因后回到草稿。
    """
    status = artifact.status
    version = current_version(db, artifact)
    if version is None:
        raise NotFoundError("产物当前版本不存在")

    if status == st.ARTIFACT_CONFIRMED:
        note = require_reason(change_note, field="change_note", label="变更原因")
        check_transition(
            MACHINE, current=status, target=st.ARTIFACT_DRAFT, reason=note, label=LABEL
        )
        version = _new_version(
            db,
            artifact,
            account=account,
            payload=payload_of(version),
            status=st.ARTIFACT_DRAFT,
            is_frozen=False,
            change_note=note,
            source_version_no=version.version_no,
        )
    elif status == st.ARTIFACT_RETURNED:
        check_transition(
            MACHINE, current=status, target=st.ARTIFACT_DRAFT, reason=None, label=LABEL
        )
        require_reason(reason, field="reason", label="恢复原因")
        version.is_frozen = False
        version.status = st.ARTIFACT_DRAFT
    elif status == st.ARTIFACT_NOT_APPLICABLE:
        check_transition(
            MACHINE, current=status, target=st.ARTIFACT_DRAFT, reason=reason, label=LABEL
        )
        version.is_frozen = False
        version.status = st.ARTIFACT_DRAFT
        artifact.not_applicable_reason = ""
    else:
        # 其余状态无此迁移 → 由 check_transition 抛出 409
        check_transition(
            MACHINE, current=status, target=st.ARTIFACT_DRAFT, reason=reason, label=LABEL
        )

    now = utcnow()
    version.updated_at = now
    artifact.status = st.ARTIFACT_DRAFT
    artifact.updated_at = now
    db.commit()
    db.refresh(version)
    return version


def mark_not_applicable(
    db: Session, *, artifact: Artifact, account: Account, reason: str
) -> Artifact:
    """草稿 → 不适用；理由必填，且模板必须允许不适用。"""
    check_transition(
        MACHINE,
        current=artifact.status,
        target=st.ARTIFACT_NOT_APPLICABLE,
        reason=reason,
        label=LABEL,
    )
    if not template_allow_na(db, artifact.kind):
        raise ConflictError(
            f"产物模板「{artifact.kind}」不允许标记为不适用",
            code="template_na_forbidden",
            extra={
                "kind": artifact.kind,
                "current": artifact.status,
                "target": st.ARTIFACT_NOT_APPLICABLE,
                "reason": "模板 allow_not_applicable=false",
                "allowed_targets": list(st.allowed_targets(MACHINE, artifact.status)),
            },
        )
    now = utcnow()
    artifact.status = st.ARTIFACT_NOT_APPLICABLE
    artifact.not_applicable_reason = reason.strip()
    artifact.updated_at = now
    db.commit()
    db.refresh(artifact)
    return artifact


# ============================================================================= 版本与差异


def list_versions(db: Session, artifact: Artifact) -> list[ArtifactVersion]:
    stmt = (
        select(ArtifactVersion)
        .where(ArtifactVersion.artifact_id == artifact.id)
        .order_by(ArtifactVersion.version_no.desc())
    )
    return list(db.execute(stmt).scalars())


def get_version(db: Session, artifact: Artifact, version_no: int) -> ArtifactVersion:
    version = _version_by_no(db, artifact.id, version_no)
    if version is None:
        raise NotFoundError(f"产物版本不存在：v{version_no}")
    return version


def _classify(from_value: Any, to_value: Any) -> str:
    from_empty = _is_empty(from_value)
    to_empty = _is_empty(to_value)
    if from_empty and to_empty:
        return "unchanged"
    if from_empty:
        return "added"
    if to_empty:
        return "removed"
    return "unchanged" if from_value == to_value else "modified"


def _infer_type(value: Any) -> str:
    if isinstance(value, list):
        return tpl.F_TABLE
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return tpl.F_NUMBER
    return tpl.F_TEXT


def _row_changes(
    from_value: Any, to_value: Any, columns: list[str]
) -> list[dict[str, Any]]:
    """行级差异：以首列值为行标识，输出新增 / 删除 / 修改。"""
    rows_from = _rows(from_value, columns)
    rows_to = _rows(to_value, columns)
    key_col = columns[0] if columns else None

    def key_of(row: dict[str, Any], index: int) -> str:
        if key_col and not _is_empty(row.get(key_col)):
            return str(row.get(key_col))
        for key, value in row.items():
            if not _is_empty(value):
                return f"{key}={value}"
        return f"#{index}"

    from_map: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(rows_from):
        from_map.setdefault(key_of(row, index), row)
    to_map: dict[str, dict[str, Any]] = {}
    for index, row in enumerate(rows_to):
        to_map.setdefault(key_of(row, index), row)

    changes: list[dict[str, Any]] = []
    for key, row in from_map.items():
        if key not in to_map:
            changes.append({"row_key": key, "change": "removed", "from_row": row, "to_row": None})
    for key, row in to_map.items():
        if key not in from_map:
            changes.append({"row_key": key, "change": "added", "from_row": None, "to_row": row})
        elif from_map[key] != row:
            changes.append(
                {"row_key": key, "change": "modified", "from_row": from_map[key], "to_row": row}
            )
    return changes


def diff_versions(
    db: Session, artifact: Artifact, from_no: int, to_no: int
) -> list[dict[str, Any]]:
    """字段级差异；``table`` / ``checklist`` 额外给出 ``row_changes``。"""
    from_version = get_version(db, artifact, from_no)
    to_version = get_version(db, artifact, to_no)
    from_payload = payload_of(from_version)
    to_payload = payload_of(to_version)

    fields = template_fields(db, artifact.kind)
    seen: set[str] = set()
    result: list[dict[str, Any]] = []

    for field in fields:
        key = str(field.get("key") or "")
        seen.add(key)
        ftype = str(field.get("type") or tpl.F_TEXT)
        columns = list(field.get("columns") or [])
        from_value = from_payload.get(key)
        to_value = to_payload.get(key)
        item: dict[str, Any] = {
            "field": key,
            "label": str(field.get("label") or key),
            "type": ftype,
            "from_value": from_value,
            "to_value": to_value,
            "change": _classify(from_value, to_value),
        }
        if ftype in (tpl.F_TABLE, tpl.F_CHECKLIST):
            item["row_changes"] = _row_changes(from_value, to_value, columns)
        result.append(item)

    # payload 中存在但模板未声明的键（例如历史遗留字段）也要可见
    for key in sorted((set(from_payload) | set(to_payload)) - seen):
        from_value = from_payload.get(key)
        to_value = to_payload.get(key)
        item = {
            "field": key,
            "label": key,
            "type": _infer_type(to_value if to_value is not None else from_value),
            "from_value": from_value,
            "to_value": to_value,
            "change": _classify(from_value, to_value),
        }
        if isinstance(to_value if to_value is not None else from_value, list):
            item["row_changes"] = _row_changes(from_value, to_value, [])
        result.append(item)

    return result


# ============================================================================= 问题引用


def set_issue_refs(
    db: Session, *, artifact: Artifact, account: Account, issue_ids: list[str]
) -> ArtifactVersion:
    """写入当前版本的问题引用；引用问题必须存在（统一问题实体由 T07 承载）。"""
    ids: list[str] = []
    for raw in issue_ids or []:
        text = str(raw).strip()
        if text and text not in ids:
            ids.append(text)

    missing = [issue_id for issue_id in ids if db.get(Issue, issue_id) is None]
    if missing:
        raise ValidationError(
            "存在无效的问题引用",
            field_errors=[
                {"field": "issue_ids", "message": f"问题不存在：{issue_id}", "type": "value_error"}
                for issue_id in missing
            ],
        )

    version = current_version(db, artifact)
    if version is None:
        raise NotFoundError("产物当前版本不存在")
    if version.is_frozen:
        version = _new_version(
            db,
            artifact,
            account=account,
            payload=payload_of(version),
            status=st.ARTIFACT_DRAFT,
            is_frozen=False,
            change_note="更新关联问题引用",
            source_version_no=version.version_no,
        )
    version.issue_ids_json = json.dumps(ids, ensure_ascii=False)
    version.updated_at = utcnow()
    db.commit()
    db.refresh(version)
    return version


# ============================================================================= 序列化


def serialize_version(version: ArtifactVersion) -> dict[str, Any]:
    return {
        "id": version.id,
        "version_no": version.version_no,
        "status": version.status,
        "is_frozen": bool(version.is_frozen),
        "change_note": version.change_note or "",
        "source_version_no": version.source_version_no,
        "created_by": version.created_by,
        "created_by_name": version.created_by_name,
        "created_at": iso_z(version.created_at),
        "payload": payload_of(version),
        "issue_ids": issue_ids_of(version),
    }


def serialize_artifact(artifact: Artifact) -> dict[str, Any]:
    return {
        "id": artifact.id,
        "project_id": artifact.project_id,
        "node_id": artifact.node_id,
        "node_code": artifact.node_code,
        "kind": artifact.kind,
        "title": artifact.title,
        "status": artifact.status,
        "status_label": st.ARTIFACT_STATUS_LABELS.get(artifact.status, artifact.status),
        "current_version_no": artifact.current_version_no,
        "collaborators_text": artifact.collaborators_text,
        "not_applicable_reason": artifact.not_applicable_reason,
        "last_saved_at": iso_z(artifact.last_saved_at),
        "submitted_at": iso_z(artifact.submitted_at),
        "confirmed_at": iso_z(artifact.confirmed_at),
        "created_by_name": artifact.created_by_name,
        "updated_by_name": artifact.updated_by_name,
        "created_at": iso_z(artifact.created_at),
        "updated_at": iso_z(artifact.updated_at),
        "row_version": int(artifact.row_version or 1),
    }


def serialize_artifact_detail(db: Session, artifact: Artifact) -> dict[str, Any]:
    row = db.get(ArtifactTemplate, artifact.kind)
    template = serialize_template_row(row) if row is not None else serialize_template_fallback(artifact.kind)
    version = current_version(db, artifact)
    return {
        **serialize_artifact(artifact),
        "template": template,
        "current_version": serialize_version(version) if version is not None else None,
        "allowed_actions": list(st.allowed_actions(MACHINE, artifact.status)),
    }
