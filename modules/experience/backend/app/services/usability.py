"""可用性研究服务（T09 / DESIGN §6.2.2、REQUIREMENTS §3.10、PRD §10 / §5.4 N12）。

覆盖：研究 / 参与者 / 任务 / 运行矩阵 / SUS 十题算法 / 满意度 / 统计 / 报告生成。

硬性不变量：

1. **SUS 标准算法**：奇数题（1,3,5,7,9）各减 1；偶数题（2,4,6,8,10）取
   ``5 - 得分``；十项求和后 **× 2.5** → 0–100，保留 1 位小数（``Decimal``）。
2. **缺题不计算**：任一项为 ``None`` → ``sus_score=None`` 且 ``missing_questions``
   列出缺题号；**禁止臆造分数**（绝不返回 0）。
3. **满意度 1–10**：越界 422，文案为肯定式（「满意度要在 1–10 分之间」）。
4. **无效参与者不进入均值**，但**保留原始值与排除理由**（不删行），
   统计结果显式列出 ``invalid_participants``。
5. **耗时不得为负**；写 ``error_steps`` 时按非空行数自动计算 ``error_count``。
6. 所有写操作写 ``audit_business`` 审计；不存在 404；校验 422；重复别名 409。
"""

from __future__ import annotations

import json
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import RequestContext
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.core.security import new_id
from app.core.timeutil import iso_z, utcnow
from app.domain import states as st
from app.models.account import Account
from app.models.artifact import Artifact, ArtifactVersion
from app.models.flow import Project, WorkflowNode
from app.models.usability import (
    PARTICIPANT_EXPERT,
    PARTICIPANT_GROUP_LABELS,
    PARTICIPANT_GROUPS,
    PARTICIPANT_NOVICE,
    RUN_COMPLETED,
    RUN_FAILED,
    RUN_STATUS_LABELS,
    RUN_STATUSES,
    SATISFACTION_MAX,
    SATISFACTION_MIN,
    STUDY_COMPLETED,
    STUDY_DRAFT,
    STUDY_KINDS,
    STUDY_KIND_LABELS,
    STUDY_NA,
    STUDY_RUNNING,
    SUS_INDUSTRY_REFERENCE,
    StudyParticipant,
    StudyTask,
    SusAnswer,
    TaskRun,
    UsabilityStudy,
)
from app.services.common import (
    audit_business,
    check_row_version,
    get_or_404,
    paginate,
    require_reason,
    touch,
)

DEFAULT_PAGE_SIZE = 50
PAGE_SIZES: tuple[int, ...] = (20, 50, 100)
DEFAULT_TOP_N = 5
MAX_TOP_N = 20

SCRIPT_ARTIFACT_KIND = "script_design"
REPORT_ARTIFACT_KIND = "usability_report"
N12_NODE_CODE = "N12"

STUDY_STATUS_LABELS: dict[str, str] = {
    STUDY_DRAFT: "草稿",
    STUDY_RUNNING: "进行中",
    STUDY_COMPLETED: "已完成",
    STUDY_NA: "不适用",
}

# 满意度 / SUS 提示文案（肯定式，PRD §11 交互规范）
SATISFACTION_MESSAGE = f"满意度要在 {SATISFACTION_MIN}–{SATISFACTION_MAX} 分之间"
SUS_RANGE_MESSAGE = "SUS 每题得分要在 1–5 分之间"
DURATION_MESSAGE = "任务耗时要在 0 秒及以上"

_QUESTION_KEYS: tuple[str, ...] = tuple(f"q{i}" for i in range(1, 11))


# ============================================================================ 校验


def _field_error(field: str, message: str, type_: str = "value_error") -> dict[str, str]:
    return {"field": field, "message": message, "type": type_}


def _raise(field: str, message: str, *, label: str = "请求参数校验失败") -> None:
    raise ValidationError(message, field_errors=[_field_error(field, message)])


def _validate_study_kind(study_kind: str) -> None:
    if study_kind not in STUDY_KINDS:
        _raise("study_kind", f"研究类型要在 {'、'.join(STUDY_KINDS)} 之间")


def _validate_satisfaction(value: int | None, *, field: str = "satisfaction") -> None:
    """满意度仅接受 1–10 的整数；越界 422，文案肯定式。"""
    if value is None:
        return
    if not isinstance(value, int) or isinstance(value, bool):
        _raise(field, SATISFACTION_MESSAGE)
    if value < SATISFACTION_MIN or value > SATISFACTION_MAX:
        _raise(field, SATISFACTION_MESSAGE)


def _validate_sus_question(key: str, value: int | None) -> None:
    if value is None:
        return
    if not isinstance(value, int) or isinstance(value, bool):
        _raise(key, SUS_RANGE_MESSAGE)
    if value < 1 or value > 5:
        _raise(key, SUS_RANGE_MESSAGE)


def _validate_duration(value: int | None) -> None:
    if value is None:
        return
    if isinstance(value, bool) or not isinstance(value, int):
        _raise("duration_seconds", DURATION_MESSAGE)
    if value < 0:
        _raise("duration_seconds", DURATION_MESSAGE)


def _validate_run_status(status: str) -> None:
    if status not in RUN_STATUSES:
        _raise("status", f"任务状态要在 {'、'.join(RUN_STATUSES)} 之间")


def _validate_group_type(group_type: str) -> None:
    if group_type not in PARTICIPANT_GROUPS:
        _raise("group_type", "参与者分组要在 novice（新手）/ expert（熟手）之间")


def _count_error_steps(error_steps: str | None) -> int:
    """错误步骤按「非空行数」计数（PRD §10.2）。"""
    if not error_steps:
        return 0
    return sum(1 for line in str(error_steps).splitlines() if line.strip())


# ============================================================================ SUS 算法


def _q(value: Any) -> int | None:
    if value is None:
        return None
    return int(value)


def compute_sus(answers: dict[str, Any]) -> dict[str, Any]:
    """标准十题 SUS 计算（纯函数）。

    - 奇题（1,3,5,7,9）：``贡献 = 得分 - 1``；
    - 偶题（2,4,6,8,10）：``贡献 = 5 - 得分``；
    - 十项求和 × 2.5 → 0–100，保留 1 位小数；
    - 任一题缺失 → ``sus_score=None``，``missing_questions`` 列出缺题号。
    """
    details: list[dict[str, Any]] = []
    missing: list[int] = []
    total = 0
    for index in range(1, 11):
        key = f"q{index}"
        raw = _q(answers.get(key))
        odd = index % 2 == 1
        if raw is None:
            missing.append(index)
            details.append(
                {
                    "question": index,
                    "raw": None,
                    "converted": None,
                    "direction": "正向（得分 - 1）" if odd else "反向（5 - 得分）",
                }
            )
            continue
        converted = (raw - 1) if odd else (5 - raw)
        total += converted
        details.append(
            {
                "question": index,
                "raw": raw,
                "converted": converted,
                "direction": "正向（得分 - 1）" if odd else "反向（5 - 得分）",
            }
        )

    reference = Decimal(SUS_INDUSTRY_REFERENCE)
    if missing:
        return {
            "sus_score": None,
            "industry_reference": SUS_INDUSTRY_REFERENCE,
            "difference": None,
            "comparison": "incomplete",
            "comparison_label": "缺题未计算",
            "missing_questions": missing,
            "is_complete": False,
            "total_converted": None,
            "details": details,
        }

    score = (Decimal(total) * Decimal("2.5")).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
    difference = (score - reference).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
    if score > reference:
        comparison, comparison_label = "above", "高于行业均值"
    elif score < reference:
        comparison, comparison_label = "below", "低于行业均值"
    else:
        comparison, comparison_label = "equal", "与行业均值持平"

    return {
        "sus_score": str(score),
        "industry_reference": SUS_INDUSTRY_REFERENCE,
        "difference": str(difference),
        "comparison": comparison,
        "comparison_label": comparison_label,
        "missing_questions": [],
        "is_complete": True,
        "total_converted": total,
        "details": details,
    }


# ============================================================================ 编号


def generate_study_code(db: Session, project: Project) -> str:
    """生成稳定研究编号 ``US-{项目code}-{4 位序号}``，全库唯一。"""
    prefix = f"US-{project.code}-"
    existing = set(
        db.execute(select(UsabilityStudy.code).where(UsabilityStudy.code.like(f"{prefix}%"))).scalars().all()
    )
    seq = 1
    while f"{prefix}{seq:04d}" in existing:
        seq += 1
    return f"{prefix}{seq:04d}"


# ============================================================================ 序列化


def _project_map(db: Session, ids: list[str]) -> dict[str, Project]:
    if not ids:
        return {}
    rows = db.execute(select(Project).where(Project.id.in_(ids))).scalars().all()
    return {row.id: row for row in rows}


def _study_participants(db: Session, study_id: str) -> list[StudyParticipant]:
    stmt = (
        select(StudyParticipant)
        .where(StudyParticipant.study_id == study_id)
        .order_by(StudyParticipant.order_no, StudyParticipant.alias)
    )
    return list(db.execute(stmt).scalars())


def _study_tasks(db: Session, study_id: str) -> list[StudyTask]:
    stmt = (
        select(StudyTask)
        .where(StudyTask.study_id == study_id)
        .order_by(StudyTask.task_no, StudyTask.created_at)
    )
    return list(db.execute(stmt).scalars())


def _study_runs(db: Session, study_id: str) -> list[TaskRun]:
    stmt = select(TaskRun).where(TaskRun.study_id == study_id)
    return list(db.execute(stmt).scalars())


def _study_sus_rows(db: Session, study_id: str) -> list[SusAnswer]:
    stmt = select(SusAnswer).where(SusAnswer.study_id == study_id)
    return list(db.execute(stmt).scalars())


def _progress_of(
    participants: list[StudyParticipant], tasks: list[StudyTask], runs: list[TaskRun]
) -> dict[str, Any]:
    valid = [p for p in participants if p.is_valid]
    completed = [r for r in runs if r.status == RUN_COMPLETED]
    expected = len(tasks) * len(valid)
    rate = round(len(completed) / expected * 100, 1) if expected else 0.0
    return {
        "task_count": len(tasks),
        "participant_count": len(participants),
        "valid_participant_count": len(valid),
        "invalid_participant_count": len(participants) - len(valid),
        "run_count": len(runs),
        "completed_run_count": len(completed),
        "expected_run_count": expected,
        "completion_rate": rate,
    }


def study_row(db: Session, study: UsabilityStudy, projects: dict[str, Project] | None = None) -> dict[str, Any]:
    project = (projects or {}).get(study.project_id) or db.get(Project, study.project_id)
    participants = _study_participants(db, study.id)
    tasks = _study_tasks(db, study.id)
    valid = [p for p in participants if p.is_valid]
    return {
        "id": study.id,
        "code": study.code,
        "name": study.name,
        "project_id": study.project_id,
        "project_name": project.name if project else "",
        "project_code": project.code if project else "",
        "version_code": study.version_code,
        "study_kind": study.study_kind,
        "study_kind_label": STUDY_KIND_LABELS.get(study.study_kind, study.study_kind),
        "participant_count": len(participants),
        "valid_participant_count": len(valid),
        "task_count": len(tasks),
        "status": study.status,
        "status_label": STUDY_STATUS_LABELS.get(study.status, study.status),
        "script_artifact_id": study.script_artifact_id,
        "report_artifact_id": study.report_artifact_id,
        "created_by_name": study.created_by_name,
        "updated_by_name": study.updated_by_name,
        "updated_at": iso_z(study.updated_at),
        "created_at": iso_z(study.created_at),
        "row_version": int(study.row_version or 1),
    }


def study_detail(db: Session, study: UsabilityStudy) -> dict[str, Any]:
    participants = _study_participants(db, study.id)
    tasks = _study_tasks(db, study.id)
    runs = _study_runs(db, study.id)
    valid = [p for p in participants if p.is_valid]
    return {
        **study_row(db, study),
        "note": study.note,
        "not_applicable": {
            "is_not_applicable": study.status == STUDY_NA,
            "reason": study.not_applicable_reason,
        },
        "is_not_applicable": study.status == STUDY_NA,
        "not_applicable_reason": study.not_applicable_reason,
        "counts": {
            "participants_total": len(participants),
            "participants_valid": len(valid),
            "participants_invalid": len(participants) - len(valid),
            "tasks": len(tasks),
            "runs": len(runs),
        },
        "progress": _progress_of(participants, tasks, runs),
        "report": {
            "has_report": bool(study.report_artifact_id),
            "report_artifact_id": study.report_artifact_id,
            "status": "generated" if study.report_artifact_id else "pending",
            "status_label": "已生成" if study.report_artifact_id else "未生成",
        },
    }


# ============================================================================ 研究 CRUD


def list_studies(
    db: Session,
    *,
    filters: dict[str, Any],
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> dict[str, Any]:
    if page_size not in PAGE_SIZES:
        page_size = DEFAULT_PAGE_SIZE
    stmt = select(UsabilityStudy)
    if filters.get("project_id"):
        stmt = stmt.where(UsabilityStudy.project_id == filters["project_id"])
    if filters.get("study_kind"):
        stmt = stmt.where(UsabilityStudy.study_kind == filters["study_kind"])
    if filters.get("status"):
        stmt = stmt.where(UsabilityStudy.status == filters["status"])
    stmt = stmt.order_by(UsabilityStudy.updated_at.desc(), UsabilityStudy.created_at.desc())
    rows, total = paginate(db, stmt, page=max(1, page), page_size=page_size)
    rows = list(rows)
    projects = _project_map(db, [r.project_id for r in rows])
    return {
        "page": max(1, page),
        "page_size": page_size,
        "total": total,
        "items": [study_row(db, row, projects) for row in rows],
        "filter_options": {
            "study_kinds": [
                {"value": k, "label": STUDY_KIND_LABELS[k]} for k in STUDY_KINDS
            ],
            "statuses": [
                {"value": k, "label": STUDY_STATUS_LABELS[k]} for k in STUDY_STATUS_LABELS
            ],
            "participant_groups": [
                {"value": k, "label": PARTICIPANT_GROUP_LABELS[k]} for k in PARTICIPANT_GROUPS
            ],
            "run_statuses": [
                {"value": k, "label": RUN_STATUS_LABELS[k]} for k in RUN_STATUSES
            ],
        },
    }


def create_study(
    db: Session,
    *,
    account: Account,
    payload: Any,
    ctx: RequestContext | None = None,
) -> UsabilityStudy:
    _validate_study_kind(payload.study_kind)
    project = get_or_404(db, Project, payload.project_id, "项目")
    if not (payload.name or "").strip():
        _raise("name", "请填写研究名称")

    version_code = (payload.version_code or "").strip()

    now = utcnow()
    study = UsabilityStudy(
        id=new_id(),
        code=generate_study_code(db, project),
        project_id=project.id,
        version_code=version_code,
        name=payload.name.strip()[:200],
        study_kind=payload.study_kind,
        script_artifact_id=payload.script_artifact_id or None,
        status=STUDY_DRAFT,
        not_applicable_reason="",
        report_artifact_id=None,
        note=payload.note or "",
        created_by=account.id,
        created_by_name=account.name,
        updated_by=account.id,
        updated_by_name=account.name,
        row_version=1,
        created_at=now,
        updated_at=now,
    )
    db.add(study)
    db.commit()
    db.refresh(study)

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="usability_study_created",
        target_type="usability_study",
        target_id=study.id,
        summary=f"新建可用性研究 {study.code}",
        detail={
            "code": study.code,
            "project_id": study.project_id,
            "study_kind": study.study_kind,
            "version_code": study.version_code,
        },
    )
    return study


def update_study(
    db: Session,
    *,
    study: UsabilityStudy,
    payload: Any,
    account: Account,
    ctx: RequestContext | None = None,
) -> UsabilityStudy:
    check_row_version(study, getattr(payload, "expected_version", None), "可用性研究")
    changed: dict[str, Any] = {}
    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            _raise("name", "请填写研究名称")
        study.name = name[:200]
        changed["name"] = study.name
    if payload.version_code is not None:
        study.version_code = payload.version_code.strip()
        changed["version_code"] = study.version_code
    if payload.script_artifact_id is not None:
        study.script_artifact_id = payload.script_artifact_id or None
        changed["script_artifact_id"] = study.script_artifact_id
    if payload.note is not None:
        study.note = payload.note
        changed["note"] = study.note

    touch(study, account)
    study.updated_at = utcnow()
    db.commit()
    db.refresh(study)

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="usability_study_updated",
        target_type="usability_study",
        target_id=study.id,
        summary=f"更新可用性研究 {study.code}",
        detail={"code": study.code, "changed": changed},
    )
    return study


def mark_study_na(
    db: Session,
    *,
    study: UsabilityStudy,
    reason: str | None,
    account: Account,
    ctx: RequestContext | None = None,
) -> UsabilityStudy:
    text = require_reason(reason, field="reason", label="不适用原因")
    study.status = STUDY_NA
    study.not_applicable_reason = text
    touch(study, account)
    study.updated_at = utcnow()
    db.commit()
    db.refresh(study)

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="usability_study_marked_na",
        target_type="usability_study",
        target_id=study.id,
        summary=f"可用性研究 {study.code} 标记为不适用",
        detail={"code": study.code, "reason": text},
    )
    return study


# ============================================================================ 参与者


def participant_row(db: Session, participant: StudyParticipant) -> dict[str, Any]:
    runs = db.execute(select(TaskRun).where(TaskRun.participant_id == participant.id)).scalars().all()
    sus = db.execute(
        select(SusAnswer).where(SusAnswer.participant_id == participant.id)
    ).scalars().first()
    return {
        "id": participant.id,
        "study_id": participant.study_id,
        "order_no": participant.order_no,
        "alias": participant.alias,
        "group_type": participant.group_type,
        "group_label": PARTICIPANT_GROUP_LABELS.get(participant.group_type, participant.group_type),
        "is_valid": bool(participant.is_valid),
        "exclusion_reason": participant.exclusion_reason,
        "satisfaction": participant.satisfaction,
        "note": participant.note,
        "run_count": len(runs),
        "sus_score": sus.sus_score if sus else None,
        "updated_at": iso_z(participant.updated_at),
    }


def list_participants(db: Session, study: UsabilityStudy) -> dict[str, Any]:
    participants = _study_participants(db, study.id)
    return {
        "study_id": study.id,
        "total": len(participants),
        "items": [participant_row(db, p) for p in participants],
    }


def add_participants(
    db: Session,
    *,
    study: UsabilityStudy,
    payload: Any,
    account: Account,
    ctx: RequestContext | None = None,
) -> list[StudyParticipant]:
    incoming = list(payload.participants or [])
    if not incoming:
        _raise("participants", "请至少添加 1 名参与者")

    existing = {p.alias for p in _study_participants(db, study.id)}
    seen: set[str] = set()
    for item in incoming:
        _validate_group_type(item.group_type)
        alias = (item.alias or "").strip()
        if not alias:
            _raise("alias", "请填写参与者代号")
        if alias in existing or alias in seen:
            raise ConflictError(
                f"参与者代号「{alias}」在本研究中已存在",
                code="participant_alias_duplicated",
                extra={"alias": alias, "reason": "研究内参与者代号必须唯一"},
            )
        seen.add(alias)

    max_order = db.execute(
        select(func.max(StudyParticipant.order_no)).where(StudyParticipant.study_id == study.id)
    ).scalar()
    order = int(max_order or 0)
    now = utcnow()
    created: list[StudyParticipant] = []
    for item in incoming:
        order += 1
        participant = StudyParticipant(
            id=new_id(),
            study_id=study.id,
            order_no=order,
            alias=item.alias.strip(),
            group_type=item.group_type,
            is_valid=True,
            exclusion_reason="",
            satisfaction=None,
            note="",
            created_at=now,
            updated_at=now,
        )
        db.add(participant)
        created.append(participant)

    if study.status == STUDY_DRAFT:
        study.status = STUDY_RUNNING
        study.updated_at = now

    db.commit()
    for participant in created:
        db.refresh(participant)

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="study_participants_added",
        target_type="usability_study",
        target_id=study.id,
        summary=f"研究 {study.code} 新增 {len(created)} 名参与者",
        detail={"code": study.code, "aliases": [p.alias for p in created]},
    )
    return created


def update_participant(
    db: Session,
    *,
    study: UsabilityStudy,
    participant_id: str,
    payload: Any,
    account: Account,
    ctx: RequestContext | None = None,
) -> StudyParticipant:
    participant = get_or_404(db, StudyParticipant, participant_id, "参与者")
    if participant.study_id != study.id:
        raise NotFoundError("参与者不属于该研究")

    changed: dict[str, Any] = {}

    if payload.satisfaction is not None:
        _validate_satisfaction(payload.satisfaction)
        participant.satisfaction = payload.satisfaction
        changed["satisfaction"] = participant.satisfaction

    if payload.is_valid is not None:
        if payload.is_valid is False:
            reason = (payload.exclusion_reason or participant.exclusion_reason or "").strip()
            if not reason:
                raise ValidationError(
                    "标记无效参与者必须填写排除理由",
                    field_errors=[_field_error("exclusion_reason", "请填写排除理由")],
                )
            participant.is_valid = False
            participant.exclusion_reason = reason
        else:
            participant.is_valid = True
            # 恢复有效时如显式给出理由则保留，否则清空
            if payload.exclusion_reason is not None:
                participant.exclusion_reason = payload.exclusion_reason.strip()
        changed["is_valid"] = bool(participant.is_valid)
        changed["exclusion_reason"] = participant.exclusion_reason
    elif payload.exclusion_reason is not None:
        participant.exclusion_reason = payload.exclusion_reason.strip()
        changed["exclusion_reason"] = participant.exclusion_reason

    if payload.note is not None:
        participant.note = payload.note
        changed["note"] = participant.note

    participant.updated_at = utcnow()
    db.commit()
    db.refresh(participant)

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="study_participant_updated",
        target_type="study_participant",
        target_id=participant.id,
        summary=f"更新参与者 {participant.alias}（研究 {study.code}）",
        detail={"study_code": study.code, "alias": participant.alias, "changed": changed},
    )
    return participant


# ============================================================================ 任务


def task_row(task: StudyTask, run_count: int = 0) -> dict[str, Any]:
    return {
        "id": task.id,
        "study_id": task.study_id,
        "task_no": task.task_no,
        "flow": task.flow,
        "module": task.module,
        "content": task.content,
        "expected": task.expected,
        "run_count": run_count,
        "updated_at": iso_z(task.updated_at),
    }


def list_tasks(db: Session, study: UsabilityStudy) -> dict[str, Any]:
    tasks = _study_tasks(db, study.id)
    counts = {
        row[0]: int(row[1])
        for row in db.execute(
            select(TaskRun.task_id, func.count())
            .where(TaskRun.study_id == study.id)
            .group_by(TaskRun.task_id)
        ).all()
    }
    return {
        "study_id": study.id,
        "total": len(tasks),
        "items": [task_row(t, counts.get(t.id, 0)) for t in tasks],
    }


def create_task(
    db: Session,
    *,
    study: UsabilityStudy,
    payload: Any,
    account: Account,
    ctx: RequestContext | None = None,
) -> StudyTask:
    if not (payload.content or "").strip():
        _raise("content", "请填写任务内容")
    task_no = payload.task_no
    if task_no is None:
        max_no = db.execute(
            select(func.max(StudyTask.task_no)).where(StudyTask.study_id == study.id)
        ).scalar()
        task_no = int(max_no or 0) + 1
    now = utcnow()
    task = StudyTask(
        id=new_id(),
        study_id=study.id,
        task_no=int(task_no),
        flow=(payload.flow or "").strip(),
        module=(payload.module or "").strip(),
        content=payload.content,
        expected=payload.expected or "",
        created_at=now,
        updated_at=now,
    )
    db.add(task)
    db.commit()
    db.refresh(task)

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="study_task_created",
        target_type="study_task",
        target_id=task.id,
        summary=f"研究 {study.code} 新增任务 #{task.task_no}",
        detail={"study_code": study.code, "task_no": task.task_no, "module": task.module},
    )
    return task


def update_task(
    db: Session,
    *,
    study: UsabilityStudy,
    task_id: str,
    payload: Any,
    account: Account,
    ctx: RequestContext | None = None,
) -> StudyTask:
    task = get_or_404(db, StudyTask, task_id, "任务")
    if task.study_id != study.id:
        raise NotFoundError("任务不属于该研究")

    changed: dict[str, Any] = {}
    if payload.flow is not None:
        task.flow = payload.flow.strip()
        changed["flow"] = task.flow
    if payload.module is not None:
        task.module = payload.module.strip()
        changed["module"] = task.module
    if payload.content is not None:
        if not payload.content.strip():
            _raise("content", "请填写任务内容")
        task.content = payload.content
        changed["content"] = task.content
    if payload.expected is not None:
        task.expected = payload.expected
        changed["expected"] = task.expected
    if payload.task_no is not None:
        task.task_no = int(payload.task_no)
        changed["task_no"] = task.task_no

    task.updated_at = utcnow()
    db.commit()
    db.refresh(task)

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="study_task_updated",
        target_type="study_task",
        target_id=task.id,
        summary=f"更新任务 #{task.task_no}（研究 {study.code}）",
        detail={"study_code": study.code, "task_no": task.task_no, "changed": changed},
    )
    return task


def delete_task(
    db: Session,
    *,
    study: UsabilityStudy,
    task_id: str,
    account: Account,
    ctx: RequestContext | None = None,
) -> dict[str, Any]:
    task = get_or_404(db, StudyTask, task_id, "任务")
    if task.study_id != study.id:
        raise NotFoundError("任务不属于该研究")
    run_count = int(
        db.execute(select(func.count()).select_from(TaskRun).where(TaskRun.task_id == task.id)).scalar() or 0
    )
    if run_count:
        raise ConflictError(
            "该任务已被运行记录引用，请先处理运行记录后再删除",
            code="task_referenced",
            extra={
                "task_id": task.id,
                "task_no": task.task_no,
                "run_count": run_count,
                "reason": "存在引用时禁止删除",
            },
        )
    task_no = task.task_no
    db.delete(task)
    db.commit()

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="study_task_deleted",
        target_type="study_task",
        target_id=task_id,
        summary=f"删除任务 #{task_no}（研究 {study.code}）",
        detail={"study_code": study.code, "task_no": task_no},
    )
    return {"deleted": True, "task_id": task_id}


# --- 从脚本设计产物导入 ---------------------------------------------------------

_SCRIPT_COLUMN_ALIASES: dict[str, tuple[str, ...]] = {
    "task_no": ("序号", "task_no", "no"),
    "flow": ("流程", "主流程", "flow"),
    "module": ("功能模块", "模块", "module"),
    "content": ("任务内容", "内容", "content"),
    "expected": ("预期完成结果", "预期", "expected"),
}


def _rows_of(value: Any, columns: list[str]) -> list[dict[str, Any]]:
    data = value
    if isinstance(data, dict):
        data = data.get("rows", [])
    if not isinstance(data, list):
        return []
    out: list[dict[str, Any]] = []
    for index, row in enumerate(data):
        if isinstance(row, dict):
            out.append({str(k): v for k, v in row.items()})
        elif isinstance(row, (list, tuple)):
            out.append({(columns[i] if i < len(columns) else f"col{i + 1}"): v for i, v in enumerate(row)})
        else:
            out.append({(columns[0] if columns else "col1"): row})
    return out


def _pick(row: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        if key in row and row[key] is not None and str(row[key]).strip() != "":
            return row[key]
    return None


def _coerce_task_no(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def import_tasks_from_script(
    db: Session,
    *,
    study: UsabilityStudy,
    artifact_id: str,
    account: Account,
    ctx: RequestContext | None = None,
) -> list[StudyTask]:
    """解析 ``script_design`` 产物 payload 的 ``rows`` 生成任务。"""
    artifact = get_or_404(db, Artifact, artifact_id, "脚本产物")
    if artifact.kind != SCRIPT_ARTIFACT_KIND:
        _raise("artifact_id", f"仅支持导入「{SCRIPT_ARTIFACT_KIND}」脚本设计产物")

    version = db.execute(
        select(ArtifactVersion)
        .where(ArtifactVersion.artifact_id == artifact.id)
        .order_by(ArtifactVersion.version_no.desc())
    ).scalars().first()
    payload: dict[str, Any] = {}
    if version is not None:
        try:
            parsed = json.loads(version.payload_json or "{}")
            payload = parsed if isinstance(parsed, dict) else {}
        except (TypeError, ValueError):
            payload = {}

    columns = ["序号", "流程", "功能模块", "任务内容", "预期完成结果"]
    rows = _rows_of(payload.get("rows"), columns)
    if not rows:
        raise ValidationError(
            "脚本产物没有可导入的任务行",
            field_errors=[_field_error("artifact_id", "脚本设计产物的「任务清单」为空")],
        )

    max_no = db.execute(
        select(func.max(StudyTask.task_no)).where(StudyTask.study_id == study.id)
    ).scalar()
    next_no = int(max_no or 0)
    now = utcnow()
    created: list[StudyTask] = []
    for index, row in enumerate(rows, start=1):
        content = _pick(row, _SCRIPT_COLUMN_ALIASES["content"])
        if content is None or not str(content).strip():
            continue
        next_no += 1
        seq = _coerce_task_no(_pick(row, _SCRIPT_COLUMN_ALIASES["task_no"]))
        task = StudyTask(
            id=new_id(),
            study_id=study.id,
            task_no=seq if seq is not None else next_no,
            flow=str(_pick(row, _SCRIPT_COLUMN_ALIASES["flow"]) or "").strip(),
            module=str(_pick(row, _SCRIPT_COLUMN_ALIASES["module"]) or "").strip(),
            content=str(content).strip(),
            expected=str(_pick(row, _SCRIPT_COLUMN_ALIASES["expected"]) or ""),
            created_at=now,
            updated_at=now,
        )
        db.add(task)
        created.append(task)

    if not created:
        raise ValidationError(
            "脚本产物没有可导入的任务行",
            field_errors=[_field_error("artifact_id", "脚本任务清单缺少「任务内容」")],
        )

    if study.script_artifact_id != artifact.id:
        study.script_artifact_id = artifact.id
    study.updated_at = now
    db.commit()
    for task in created:
        db.refresh(task)

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="study_tasks_imported",
        target_type="usability_study",
        target_id=study.id,
        summary=f"研究 {study.code} 从脚本产物导入 {len(created)} 条任务",
        detail={"code": study.code, "artifact_id": artifact.id, "imported": len(created)},
    )
    return created


# ============================================================================ 运行记录


def _run_row(run: TaskRun) -> dict[str, Any]:
    return {
        "id": run.id,
        "study_id": run.study_id,
        "task_id": run.task_id,
        "participant_id": run.participant_id,
        "status": run.status,
        "status_label": RUN_STATUS_LABELS.get(run.status, run.status),
        "duration_seconds": run.duration_seconds,
        "error_steps": run.error_steps,
        "error_count": int(run.error_count or 0),
        "note": run.note,
        "updated_at": iso_z(run.updated_at),
    }


def run_matrix(db: Session, study: UsabilityStudy) -> dict[str, Any]:
    tasks = _study_tasks(db, study.id)
    participants = _study_participants(db, study.id)
    runs = _study_runs(db, study.id)
    run_map = {(r.task_id, r.participant_id): r for r in runs}

    grid: list[dict[str, Any]] = []
    for participant in participants:
        cells: dict[str, Any] = {}
        for task in tasks:
            run = run_map.get((task.id, participant.id))
            cells[task.id] = (
                {
                    "run_id": run.id,
                    "status": run.status,
                    "status_label": RUN_STATUS_LABELS.get(run.status, run.status),
                    "duration_seconds": run.duration_seconds,
                    "error_count": int(run.error_count or 0),
                    "error_steps": run.error_steps,
                }
                if run is not None
                else None
            )
        grid.append(
            {
                "participant_id": participant.id,
                "alias": participant.alias,
                "group_type": participant.group_type,
                "group_label": PARTICIPANT_GROUP_LABELS.get(participant.group_type, participant.group_type),
                "is_valid": bool(participant.is_valid),
                "cells": cells,
            }
        )

    return {
        "study_id": study.id,
        "tasks": [
            {"id": t.id, "task_no": t.task_no, "flow": t.flow, "module": t.module, "content": t.content}
            for t in tasks
        ],
        "rows": grid,
        "matrix_progress": _progress_of(participants, tasks, runs),
    }


def upsert_run(
    db: Session,
    *,
    study: UsabilityStudy,
    payload: Any,
    account: Account,
    ctx: RequestContext | None = None,
) -> dict[str, Any]:
    _validate_run_status(payload.status)
    _validate_duration(payload.duration_seconds)

    task = get_or_404(db, StudyTask, payload.task_id, "任务")
    if task.study_id != study.id:
        raise NotFoundError("任务不属于该研究")
    participant = get_or_404(db, StudyParticipant, payload.participant_id, "参与者")
    if participant.study_id != study.id:
        raise NotFoundError("参与者不属于该研究")

    run = db.execute(
        select(TaskRun).where(
            TaskRun.task_id == task.id, TaskRun.participant_id == participant.id
        )
    ).scalars().first()

    error_count = _count_error_steps(payload.error_steps)
    now = utcnow()
    if run is None:
        run = TaskRun(
            id=new_id(),
            study_id=study.id,
            task_id=task.id,
            participant_id=participant.id,
            status=payload.status,
            duration_seconds=payload.duration_seconds,
            error_steps=payload.error_steps or "",
            error_count=error_count,
            note=payload.note or "",
            created_at=now,
            updated_at=now,
        )
        db.add(run)
    else:
        run.status = payload.status
        run.duration_seconds = payload.duration_seconds
        run.error_steps = payload.error_steps or ""
        run.error_count = error_count
        run.note = payload.note or ""
        run.updated_at = now

    if study.status == STUDY_DRAFT:
        study.status = STUDY_RUNNING
    study.updated_at = now
    db.commit()
    db.refresh(run)

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="task_run_upserted",
        target_type="task_run",
        target_id=run.id,
        summary=f"研究 {study.code} 录入运行记录（{participant.alias} × 任务 #{task.task_no}）",
        detail={
            "study_code": study.code,
            "task_no": task.task_no,
            "alias": participant.alias,
            "status": run.status,
            "duration_seconds": run.duration_seconds,
            "error_count": run.error_count,
        },
    )
    return {"run": _run_row(run), "matrix_progress": _progress_of(
        _study_participants(db, study.id), _study_tasks(db, study.id), _study_runs(db, study.id)
    )}


# ============================================================================ SUS 录入


def _sus_row(answer: SusAnswer | None, participant_id: str | None = None) -> dict[str, Any]:
    answers = {key: getattr(answer, key) if answer is not None else None for key in _QUESTION_KEYS}
    computed = compute_sus(answers)
    return {
        "id": answer.id if answer else None,
        "study_id": answer.study_id if answer else None,
        "participant_id": answer.participant_id if answer else participant_id,
        "answers": {key: answers[key] for key in _QUESTION_KEYS},
        "satisfaction": answer.satisfaction if answer else None,
        "entered_at": iso_z(answer.entered_at) if answer else None,
        **computed,
    }


def list_sus(db: Session, study: UsabilityStudy) -> dict[str, Any]:
    participants = _study_participants(db, study.id)
    rows = {row.participant_id: row for row in _study_sus_rows(db, study.id)}
    items = []
    for participant in participants:
        answer = rows.get(participant.id)
        item = _sus_row(answer, participant.id)
        item["alias"] = participant.alias
        item["group_type"] = participant.group_type
        item["is_valid"] = bool(participant.is_valid)
        items.append(item)
    return {"study_id": study.id, "total": len(items), "items": items}


def compute_sus_payload(payload: Any) -> dict[str, Any]:
    """纯计算（不落库），用于即时预览；同时校验题面范围。"""
    answers: dict[str, Any] = {}
    for key in _QUESTION_KEYS:
        value = getattr(payload, key, None)
        _validate_sus_question(key, value)
        answers[key] = value
    return compute_sus(answers)


def upsert_sus(
    db: Session,
    *,
    study: UsabilityStudy,
    payload: Any,
    account: Account,
    ctx: RequestContext | None = None,
) -> dict[str, Any]:
    participant = get_or_404(db, StudyParticipant, payload.participant_id, "参与者")
    if participant.study_id != study.id:
        raise NotFoundError("参与者不属于该研究")

    if payload.satisfaction is not None:
        _validate_satisfaction(payload.satisfaction)

    answers: dict[str, Any] = {}
    for key in _QUESTION_KEYS:
        value = getattr(payload, key, None)
        _validate_sus_question(key, value)
        answers[key] = value

    computed = compute_sus(answers)

    answer = db.execute(
        select(SusAnswer).where(
            SusAnswer.study_id == study.id, SusAnswer.participant_id == participant.id
        )
    ).scalars().first()
    now = utcnow()
    if answer is None:
        answer = SusAnswer(
            id=new_id(),
            study_id=study.id,
            participant_id=participant.id,
            sus_score=computed["sus_score"],
            satisfaction=payload.satisfaction,
            entered_at=now,
            created_at=now,
            updated_at=now,
        )
        db.add(answer)
    else:
        answer.entered_at = now
        answer.updated_at = now
        if payload.satisfaction is not None:
            answer.satisfaction = payload.satisfaction

    for key in _QUESTION_KEYS:
        setattr(answer, key, answers[key])
    answer.sus_score = computed["sus_score"]

    # 满意度同步回参与者（详情 / 统计以参与者为准，保持单一口径）
    if payload.satisfaction is not None:
        participant.satisfaction = payload.satisfaction
        participant.updated_at = now

    if study.status == STUDY_DRAFT:
        study.status = STUDY_RUNNING
    study.updated_at = now
    db.commit()
    db.refresh(answer)

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="sus_answer_upserted",
        target_type="sus_answer",
        target_id=answer.id,
        summary=f"研究 {study.code} 录入 SUS（{participant.alias}）",
        detail={
            "study_code": study.code,
            "alias": participant.alias,
            "sus_score": answer.sus_score,
            "missing_questions": computed["missing_questions"],
            "satisfaction": payload.satisfaction,
        },
    )
    row = _sus_row(answer, participant.id)
    row["alias"] = participant.alias
    row["group_type"] = participant.group_type
    row["is_valid"] = bool(participant.is_valid)
    return row


# ============================================================================ 统计


def _mean(values: list[Decimal]) -> Decimal | None:
    if not values:
        return None
    result = (sum(values, Decimal(0)) / Decimal(len(values))).quantize(
        Decimal("0.1"), rounding=ROUND_HALF_UP
    )
    return result


def _decimal(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except Exception:  # noqa: BLE001 - 非数值一律视为缺失
        return None


def study_stats(db: Session, study: UsabilityStudy, *, top_n: int = DEFAULT_TOP_N) -> dict[str, Any]:
    top_n = max(1, min(int(top_n or DEFAULT_TOP_N), MAX_TOP_N))
    participants = _study_participants(db, study.id)
    valid = [p for p in participants if p.is_valid]
    invalid = [p for p in participants if not p.is_valid]
    tasks = _study_tasks(db, study.id)
    task_map = {t.id: t for t in tasks}
    runs = _study_runs(db, study.id)
    sus_rows = {row.participant_id: row for row in _study_sus_rows(db, study.id)}

    reference = Decimal(SUS_INDUSTRY_REFERENCE)

    # --- SUS：仅有效参与者且有分者 ---
    sus_details: list[dict[str, Any]] = []
    sus_values: list[Decimal] = []
    for participant in participants:
        answer = sus_rows.get(participant.id)
        score = _decimal(answer.sus_score) if answer else None
        detail = {
            "participant_id": participant.id,
            "alias": participant.alias,
            "group_type": participant.group_type,
            "group_label": PARTICIPANT_GROUP_LABELS.get(participant.group_type, participant.group_type),
            "is_valid": bool(participant.is_valid),
            "sus_score": str(score) if score is not None else None,
            "included": bool(participant.is_valid and score is not None),
        }
        sus_details.append(detail)
        if participant.is_valid and score is not None:
            sus_values.append(score)

    sus_mean = _mean(sus_values)
    sus_diff = (
        (sus_mean - reference).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
        if sus_mean is not None
        else None
    )
    if sus_diff is None:
        comparison, comparison_label = "unknown", "无有效样本"
    elif sus_diff > 0:
        comparison, comparison_label = "above", "高于行业均值"
    elif sus_diff < 0:
        comparison, comparison_label = "below", "低于行业均值"
    else:
        comparison, comparison_label = "equal", "与行业均值持平"

    # --- 满意度：仅有效参与者 ---
    satisfaction_details: list[dict[str, Any]] = []
    satisfaction_values: list[Decimal] = []
    for participant in participants:
        included = bool(participant.is_valid and participant.satisfaction is not None)
        satisfaction_details.append(
            {
                "participant_id": participant.id,
                "alias": participant.alias,
                "is_valid": bool(participant.is_valid),
                "satisfaction": participant.satisfaction,
                "included": included,
            }
        )
        if included:
            satisfaction_values.append(Decimal(participant.satisfaction))
    satisfaction_mean = _mean(satisfaction_values)

    # --- 完成度：completed / 全部 run（按任务 + 整体） ---
    def _rate(completed: int, total: int) -> float:
        return round(completed / total * 100, 1) if total else 0.0

    by_task_completion: list[dict[str, Any]] = []
    for task in tasks:
        task_runs = [r for r in runs if r.task_id == task.id]
        completed = sum(1 for r in task_runs if r.status == RUN_COMPLETED)
        by_task_completion.append(
            {
                "task_id": task.id,
                "task_no": task.task_no,
                "module": task.module,
                "content": task.content,
                "run_count": len(task_runs),
                "completed_count": completed,
                "completion_rate": _rate(completed, len(task_runs)),
            }
        )
    completed_total = sum(1 for r in runs if r.status == RUN_COMPLETED)
    completion = {
        "overall": {
            "run_count": len(runs),
            "completed_count": completed_total,
            "completion_rate": _rate(completed_total, len(runs)),
        },
        "by_task": by_task_completion,
    }

    # --- 时间：仅有效参与者（无效参与者不进入均值） ---
    valid_ids = {p.id for p in valid}
    valid_runs = [r for r in runs if r.participant_id in valid_ids and r.duration_seconds is not None]
    by_task_timing: list[dict[str, Any]] = []
    for task in tasks:
        samples = [r.duration_seconds for r in valid_runs if r.task_id == task.id]
        avg = round(sum(samples) / len(samples), 1) if samples else None
        by_task_timing.append(
            {
                "task_id": task.id,
                "task_no": task.task_no,
                "module": task.module,
                "sample_count": len(samples),
                "avg_duration_seconds": avg,
            }
        )
    all_samples = [r.duration_seconds for r in valid_runs]
    overall_avg = round(sum(all_samples) / len(all_samples), 1) if all_samples else None

    def _group_avg(group_type: str) -> float | None:
        ids = {p.id for p in valid if p.group_type == group_type}
        samples = [r.duration_seconds for r in valid_runs if r.participant_id in ids]
        return round(sum(samples) / len(samples), 1) if samples else None

    novice_avg = _group_avg(PARTICIPANT_NOVICE)
    expert_avg = _group_avg(PARTICIPANT_EXPERT)
    ratio = None
    if novice_avg is not None and expert_avg not in (None, 0):
        ratio = round(novice_avg / expert_avg, 2)

    timing = {
        "by_task": by_task_timing,
        "overall_avg_duration_seconds": overall_avg,
        "novice_avg_duration_seconds": novice_avg,
        "expert_avg_duration_seconds": expert_avg,
        "novice_vs_expert_ratio": ratio,
        "sample_scope": "valid_participants",
    }

    # --- 模块 Top N ---
    module_agg: dict[str, dict[str, Any]] = {}
    valid_run_ids = {r.id for r in valid_runs}
    for run in runs:
        task = task_map.get(run.task_id)
        module = (task.module if task else "") or "未分类"
        bucket = module_agg.setdefault(
            module,
            {"module": module, "run_count": 0, "failed_count": 0, "error_count": 0, "_dur": []},
        )
        bucket["run_count"] += 1
        if run.status == RUN_FAILED:
            bucket["failed_count"] += 1
        bucket["error_count"] += int(run.error_count or 0)
        if run.id in valid_run_ids:
            bucket["_dur"].append(run.duration_seconds)
    module_list = []
    for bucket in module_agg.values():
        samples = bucket.pop("_dur")
        bucket["avg_duration_seconds"] = round(sum(samples) / len(samples), 1) if samples else None
        module_list.append(bucket)
    module_list.sort(
        key=lambda b: (b["failed_count"], b["error_count"], b["run_count"]), reverse=True
    )
    module_top_n = module_list[:top_n]

    # --- 无效参与者（保留原始值与理由） ---
    invalid_participants = []
    for participant in invalid:
        answer = sus_rows.get(participant.id)
        invalid_participants.append(
            {
                "participant_id": participant.id,
                "alias": participant.alias,
                "group_type": participant.group_type,
                "group_label": PARTICIPANT_GROUP_LABELS.get(participant.group_type, participant.group_type),
                "exclusion_reason": participant.exclusion_reason,
                "satisfaction": participant.satisfaction,
                "sus_score": answer.sus_score if answer else None,
                "note": participant.note,
                "run_count": sum(1 for r in runs if r.participant_id == participant.id),
                "excluded_from_means": True,
                "raw_values_retained": True,
            }
        )

    return {
        "study_id": study.id,
        "study_code": study.code,
        "sus": {
            "mean": str(sus_mean) if sus_mean is not None else None,
            "valid_sample_count": len(sus_values),
            "industry_reference": SUS_INDUSTRY_REFERENCE,
            "difference": str(sus_diff) if sus_diff is not None else None,
            "comparison": comparison,
            "comparison_label": comparison_label,
            "details": sus_details,
        },
        "satisfaction": {
            "mean": str(satisfaction_mean) if satisfaction_mean is not None else None,
            "valid_sample_count": len(satisfaction_values),
            "min": SATISFACTION_MIN,
            "max": SATISFACTION_MAX,
            "details": satisfaction_details,
        },
        "completion": completion,
        "timing": timing,
        "module_top_n": {"top_n": top_n, "items": module_top_n},
        "invalid_participants": {
            "count": len(invalid_participants),
            "items": invalid_participants,
            "note": "无效参与者不进入任何均值，但其原始值（满意度、SUS、耗时）与排除理由均已保留。",
        },
        "counts": {
            "participants_total": len(participants),
            "participants_valid": len(valid),
            "tasks": len(tasks),
            "runs": len(runs),
        },
    }


# ============================================================================ 报告


def _summary_text(study: UsabilityStudy, stats: dict[str, Any]) -> str:
    sus = stats["sus"]
    satisfaction = stats["satisfaction"]
    completion = stats["completion"]["overall"]
    timing = stats["timing"]
    top_modules = stats["module_top_n"]["items"]
    lines = [f"研究「{study.name}」（{study.code}）测试结果总结："]
    if sus["mean"] is None:
        lines.append(f"SUS：暂无完整有效的十题答卷；行业参考均值 {SUS_INDUSTRY_REFERENCE}。")
    else:
        lines.append(
            f"SUS 均值 {sus['mean']}，与行业参考均值 {SUS_INDUSTRY_REFERENCE} 相比{sus['comparison_label']}"
            f"（差异 {sus['difference']}），有效样本 {sus['valid_sample_count']} 人。"
        )
    if satisfaction["mean"] is None:
        lines.append("满意度：暂无有效样本。")
    else:
        lines.append(f"满意度均值 {satisfaction['mean']}（1–10），有效样本 {satisfaction['valid_sample_count']} 人。")
    lines.append(
        f"任务完成度：{completion['completed_count']}/{completion['run_count']}（{completion['completion_rate']}%）。"
    )
    if timing["overall_avg_duration_seconds"] is not None:
        lines.append(f"任务平均耗时 {timing['overall_avg_duration_seconds']} 秒。")
    if timing["novice_vs_expert_ratio"] is not None:
        lines.append(
            f"新手平均用时是熟手的 {timing['novice_vs_expert_ratio']} 倍"
            f"（新手 {timing['novice_avg_duration_seconds']} 秒 / 熟手 {timing['expert_avg_duration_seconds']} 秒）。"
        )
    if top_modules:
        modules = "、".join(
            f"{m['module']}（未完成 {m['failed_count']}，错误 {m['error_count']}）" for m in top_modules
        )
        lines.append(f"问题模块 Top {len(top_modules)}：{modules}。")
    if stats["invalid_participants"]["count"]:
        lines.append(f"另有 {stats['invalid_participants']['count']} 名参与者标记为无效，已排除出均值但保留原始值。")
    return "\n".join(lines)


def _report_details(stats: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for module in stats["module_top_n"]["items"]:
        rows.append(
            {
                "功能页面": module["module"],
                "问题描述": f"未完成任务 {module['failed_count']} 条，累计出错步骤 {module['error_count']} 个",
                "问题等级": "待分类",
                "问题类型": "可用性问题",
                "解决方案与价值提升": "待体验人员结合明细补充改进方案",
            }
        )
    return rows


def _report_payload(study: UsabilityStudy, stats: dict[str, Any]) -> dict[str, Any]:
    return {
        "study_id": study.code,
        "summary": _summary_text(study, stats),
        "improvement": "",  # 改进方案由体验人员在报告区填写，此处留空待人工补全
        "details": _report_details(stats),
    }


def _n12_node(db: Session, project_id: str) -> WorkflowNode | None:
    return db.execute(
        select(WorkflowNode).where(
            WorkflowNode.project_id == project_id, WorkflowNode.code == N12_NODE_CODE
        )
    ).scalars().first()


def _write_report_artifact(
    db: Session,
    *,
    study: UsabilityStudy,
    payload: dict[str, Any],
    account: Account,
) -> Artifact | None:
    node = _n12_node(db, study.project_id)
    if node is None:
        return None

    artifact: Artifact | None = None
    if study.report_artifact_id:
        artifact = db.get(Artifact, study.report_artifact_id)
    if artifact is None:
        artifact = db.execute(
            select(Artifact)
            .where(
                Artifact.project_id == study.project_id,
                Artifact.node_id == node.id,
                Artifact.kind == REPORT_ARTIFACT_KIND,
            )
            .order_by(Artifact.created_at.desc())
        ).scalars().first()

    now = utcnow()
    if artifact is None:
        artifact = Artifact(
            id=new_id(),
            project_id=study.project_id,
            node_id=node.id,
            node_code=N12_NODE_CODE,
            kind=REPORT_ARTIFACT_KIND,
            title=f"{study.name} · 可用性测试报告",
            status=st.ARTIFACT_DRAFT,
            current_version_no=1,
            collaborators_text="",
            not_applicable_reason="",
            created_by=account.id,
            created_by_name=account.name,
            updated_by=account.id,
            updated_by_name=account.name,
            row_version=1,
            last_saved_at=now,
            created_at=now,
            updated_at=now,
        )
        db.add(artifact)
        db.flush()

    max_no = int(
        db.execute(
            select(func.max(ArtifactVersion.version_no)).where(
                ArtifactVersion.artifact_id == artifact.id
            )
        ).scalar()
        or 0
    )
    version = ArtifactVersion(
        id=new_id(),
        artifact_id=artifact.id,
        version_no=max_no + 1,
        status=st.ARTIFACT_DRAFT,
        payload_json=json.dumps(payload, ensure_ascii=False),
        is_frozen=False,
        change_note=f"由可用性研究 {study.code} 生成报告",
        source_version_no=None,
        issue_ids_json="[]",
        created_by=account.id,
        created_by_name=account.name,
        request_id="",
        created_at=now,
        updated_at=now,
    )
    db.add(version)
    artifact.current_version_no = version.version_no
    artifact.last_saved_at = now
    artifact.updated_at = now
    artifact.updated_by = account.id
    artifact.updated_by_name = account.name
    artifact.row_version = int(artifact.row_version or 0) + 1

    study.report_artifact_id = artifact.id
    return artifact


def generate_report(
    db: Session,
    *,
    study: UsabilityStudy,
    create_artifact: bool,
    top_n: int,
    account: Account,
    ctx: RequestContext | None = None,
) -> dict[str, Any]:
    stats = study_stats(db, study, top_n=top_n)

    artifact_info: dict[str, Any] | None = None
    artifact: Artifact | None = None
    if create_artifact:
        payload = _report_payload(study, stats)
        artifact = _write_report_artifact(db, study=study, payload=payload, account=account)
        if artifact is not None:
            artifact_info = {
                "id": artifact.id,
                "kind": artifact.kind,
                "node_code": artifact.node_code,
                "title": artifact.title,
                "status": artifact.status,
                "current_version_no": artifact.current_version_no,
            }
        else:
            artifact_info = {
                "created": False,
                "reason": f"项目下不存在 {N12_NODE_CODE} 节点，未创建报告产物",
            }

    study.updated_at = utcnow()
    db.commit()
    db.refresh(study)

    report = {
        "study": study_detail(db, study),
        "summary": {
            "sus": stats["sus"],
            "module_top_n": stats["module_top_n"],
            "completion": stats["completion"],
            "timing": stats["timing"],
            "satisfaction": stats["satisfaction"],
            "text": _summary_text(study, stats),
        },
        "improvement": {
            "status": "placeholder",
            "content": "",
            "note": "改进方案由体验人员结合问题明细填写，系统不自动生成结论（N13 人工边界）。",
        },
        "details": _report_details(stats),
        "module_overview": stats["module_top_n"]["items"],
        "module_top_n": stats["module_top_n"],
        "invalid_participants": stats["invalid_participants"],
        "counts": stats["counts"],
        "artifact": artifact_info,
    }

    audit_business(
        db,
        account=account,
        ctx=ctx,
        action="usability_report_generated",
        target_type="usability_study",
        target_id=study.id,
        summary=f"生成可用性研究报告（{study.code}）",
        detail={
            "code": study.code,
            "create_artifact": create_artifact,
            "artifact_id": artifact.id if artifact else None,
            "sus_mean": stats["sus"]["mean"],
        },
    )
    return report
