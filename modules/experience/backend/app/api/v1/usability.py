"""可用性研究 API（T09 / N12）。

- 全部端点要求登录（未登录 401）；实体不存在 404；校验失败 422；重复别名 409；
- 所有写操作写 ``audit_business`` 审计；
- SUS 十题标准算法、满意度 1–10、耗时非负、缺题不计算，均以服务层为准。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.api.deps import RequestContext, get_current_account, get_request_context
from app.core.db import get_db
from app.models.account import Account
from app.models.usability import UsabilityStudy
from app.schemas.usability import (
    ParticipantBatchRequest,
    ParticipantUpdateRequest,
    ReportRequest,
    RunUpsertRequest,
    StudyCreateRequest,
    StudyNaRequest,
    StudyUpdateRequest,
    SusCalculateRequest,
    SusUpsertRequest,
    TaskCreateRequest,
    TaskImportRequest,
    TaskUpdateRequest,
)
from app.services import usability as usability_service
from app.services.common import get_or_404

router = APIRouter(prefix="/usability-studies", tags=["usability"])


def _study_or_404(db: Session, study_id: str) -> UsabilityStudy:
    return get_or_404(db, UsabilityStudy, study_id, "可用性研究")


# --------------------------------------------------------------------------- 研究


@router.get("", summary="可用性研究列表（项目 / 类型 / 状态过滤 + 分页）")
async def list_studies(
    project_id: str | None = None,
    study_kind: str | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    page: int = 1,
    page_size: int = usability_service.DEFAULT_PAGE_SIZE,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    filters = {"project_id": project_id, "study_kind": study_kind, "status": status_filter}
    return usability_service.list_studies(db, filters=filters, page=page, page_size=page_size)


@router.post("", status_code=status.HTTP_201_CREATED, summary="新建研究（服务端生成编号）")
async def create_study(
    payload: StudyCreateRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    study = usability_service.create_study(db, account=account, payload=payload, ctx=ctx)
    return usability_service.study_detail(db, study)


@router.get("/{study_id}", summary="研究详情（参与者 / 任务 / 进度 / 报告状态）")
async def get_study(
    study_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    study = _study_or_404(db, study_id)
    return usability_service.study_detail(db, study)


@router.patch("/{study_id}", summary="更新研究（名称 / 版本 / 关联脚本）")
async def update_study(
    study_id: str,
    payload: StudyUpdateRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    study = _study_or_404(db, study_id)
    usability_service.update_study(db, study=study, payload=payload, account=account, ctx=ctx)
    return usability_service.study_detail(db, study)


@router.post("/{study_id}/mark-na", summary="标记研究为不适用（理由必填）")
async def mark_study_na(
    study_id: str,
    payload: StudyNaRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    study = _study_or_404(db, study_id)
    usability_service.mark_study_na(db, study=study, reason=payload.reason, account=account, ctx=ctx)
    return usability_service.study_detail(db, study)


# --------------------------------------------------------------------------- 参与者


@router.get("/{study_id}/participants", summary="参与者列表")
async def list_participants(
    study_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    study = _study_or_404(db, study_id)
    return usability_service.list_participants(db, study)


@router.post(
    "/{study_id}/participants",
    status_code=status.HTTP_201_CREATED,
    summary="批量新增参与者（别名研究内唯一）",
)
async def add_participants(
    study_id: str,
    payload: ParticipantBatchRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    study = _study_or_404(db, study_id)
    usability_service.add_participants(db, study=study, payload=payload, account=account, ctx=ctx)
    return usability_service.list_participants(db, study)


@router.patch(
    "/{study_id}/participants/{participant_id}",
    summary="更新参与者（有效 / 无效 + 理由、满意度 1–10、备注）",
)
async def update_participant(
    study_id: str,
    participant_id: str,
    payload: ParticipantUpdateRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    study = _study_or_404(db, study_id)
    participant = usability_service.update_participant(
        db,
        study=study,
        participant_id=participant_id,
        payload=payload,
        account=account,
        ctx=ctx,
    )
    return usability_service.participant_row(db, participant)


# --------------------------------------------------------------------------- 任务


@router.get("/{study_id}/tasks", summary="任务列表")
async def list_tasks(
    study_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    study = _study_or_404(db, study_id)
    return usability_service.list_tasks(db, study)


@router.post("/{study_id}/tasks", status_code=status.HTTP_201_CREATED, summary="新增任务")
async def create_task(
    study_id: str,
    payload: TaskCreateRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    study = _study_or_404(db, study_id)
    task = usability_service.create_task(db, study=study, payload=payload, account=account, ctx=ctx)
    return usability_service.task_row(task)


@router.post(
    "/{study_id}/tasks/import-from-script",
    status_code=status.HTTP_201_CREATED,
    summary="从脚本设计产物导入任务",
)
async def import_tasks_from_script(
    study_id: str,
    payload: TaskImportRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    study = _study_or_404(db, study_id)
    usability_service.import_tasks_from_script(
        db, study=study, artifact_id=payload.artifact_id, account=account, ctx=ctx
    )
    return usability_service.list_tasks(db, study)


@router.patch("/{study_id}/tasks/{task_id}", summary="更新任务")
async def update_task(
    study_id: str,
    task_id: str,
    payload: TaskUpdateRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    study = _study_or_404(db, study_id)
    task = usability_service.update_task(
        db, study=study, task_id=task_id, payload=payload, account=account, ctx=ctx
    )
    return usability_service.task_row(task)


@router.delete("/{study_id}/tasks/{task_id}", summary="删除任务（被运行记录引用时 409）")
async def delete_task(
    study_id: str,
    task_id: str,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    study = _study_or_404(db, study_id)
    return usability_service.delete_task(
        db, study=study, task_id=task_id, account=account, ctx=ctx
    )


# --------------------------------------------------------------------------- 运行记录


@router.get("/{study_id}/runs", summary="运行矩阵（参与者 × 任务 + 进度）")
async def run_matrix(
    study_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    study = _study_or_404(db, study_id)
    return usability_service.run_matrix(db, study)


@router.put("/{study_id}/runs", summary="录入 / 更新运行记录（按 task + participant 幂等）")
async def upsert_run(
    study_id: str,
    payload: RunUpsertRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    study = _study_or_404(db, study_id)
    return usability_service.upsert_run(db, study=study, payload=payload, account=account, ctx=ctx)


# --------------------------------------------------------------------------- SUS


@router.get("/{study_id}/sus", summary="SUS 列表（含逐题换算与缺题定位）")
async def list_sus(
    study_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    study = _study_or_404(db, study_id)
    return usability_service.list_sus(db, study)


@router.put("/{study_id}/sus", summary="录入 / 更新 SUS 答卷（缺题不计算）")
async def upsert_sus(
    study_id: str,
    payload: SusUpsertRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    study = _study_or_404(db, study_id)
    return usability_service.upsert_sus(db, study=study, payload=payload, account=account, ctx=ctx)


@router.post("/{study_id}/sus/calculate", summary="SUS 纯计算预览（不落库）")
async def calculate_sus(
    study_id: str,
    payload: SusCalculateRequest,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _study_or_404(db, study_id)
    return usability_service.compute_sus_payload(payload)


# --------------------------------------------------------------------------- 统计与报告


@router.get("/{study_id}/stats", summary="统计（SUS / 满意度 / 完成度 / 时间 / 模块 Top N）")
async def study_stats(
    study_id: str,
    top_n: int = usability_service.DEFAULT_TOP_N,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    study = _study_or_404(db, study_id)
    return usability_service.study_stats(db, study, top_n=top_n)


@router.post("/{study_id}/report", summary="生成结构化报告（可选写入 usability_report 产物）")
async def generate_report(
    study_id: str,
    payload: ReportRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    study = _study_or_404(db, study_id)
    return usability_service.generate_report(
        db,
        study=study,
        create_artifact=payload.create_artifact,
        top_n=payload.top_n,
        account=account,
        ctx=ctx,
    )
