"""项目域接口（T04 / v1.1）：事业部 / 系统（见 /systems）/ 项目 / 13 节点状态机。

覆盖 ``/projects/*``、``/divisions/*``、``/workflow-nodes/*`` 三个接口族
（产品 / 产品版本接口族已在 v1.1 层级合并中取消，项目直挂系统）。

统一约定：

- 所有端点依赖 :func:`app.api.deps.get_current_account`，未登录 401；
- 实体不存在 404，非法状态迁移 409（附 ``current`` / ``target`` / ``allowed_targets``），
  缺理由 / 缺必填 422，编码重复 409；
- 写操作统一留审计（服务层完成）。
"""

from __future__ import annotations

import datetime as _dt

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.api.deps import RequestContext, get_current_account, get_request_context
from app.core.db import get_db
from app.core.errors import ValidationError
from app.core.timeutil import to_naive_utc
from app.models.account import Account
from app.models.flow import Division, Project, WorkflowNode
from app.schemas.flow import (
    ArchiveRequest,
    BoardOut,
    CoreBusinessConfirmRequest,
    CoreBusinessRequest,
    DivisionCreate,
    DivisionListOut,
    DivisionOut,
    DivisionUpdate,
    NodeDetailOut,
    NodeListOut,
    NodeSpecsOut,
    ProjectCreate,
    ProjectDetailOut,
    ProjectListOut,
    ProjectUpdate,
    TransitionRequest,
)
from app.services import flow as flow_service
from app.services.common import get_or_404, page_payload

router = APIRouter(tags=["projects"])

divisions_router = APIRouter(prefix="/divisions", tags=["divisions"])
projects_router = APIRouter(prefix="/projects", tags=["projects"])
nodes_router = APIRouter(prefix="/workflow-nodes", tags=["workflow-nodes"])


# --------------------------------------------------------------------------- 工具


def _parse_datetime(value: str | None, *, field: str) -> _dt.datetime | None:
    """解析可选时间字段（支持 ``YYYY-MM-DD`` 与 ISO 8601）。"""
    text = (value or "").strip()
    if not text:
        return None
    candidate = text.replace("Z", "+00:00")
    try:
        parsed = _dt.datetime.fromisoformat(candidate)
    except ValueError:
        raise ValidationError(
            "时间格式不正确",
            field_errors=[{"field": field, "message": "请使用 YYYY-MM-DD 或 ISO 8601 格式", "type": "value_error"}],
        ) from None
    return to_naive_utc(parsed)


def _project(db: Session, project_id: str) -> Project:
    return get_or_404(db, Project, project_id, "项目")


def _node(db: Session, node_id: str) -> tuple[WorkflowNode, Project]:
    node = get_or_404(db, WorkflowNode, node_id, "节点")
    project = get_or_404(db, Project, node.project_id, "项目")
    return node, project


# =========================================================================== 事业部


@divisions_router.get("", response_model=DivisionListOut, summary="事业部列表（分页 + 过滤）")
async def list_divisions(
    status_filter: str | None = Query(default=None, alias="status"),
    keyword: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> DivisionListOut:
    items, total = flow_service.list_divisions(
        db, status=status_filter, keyword=keyword, page=page, page_size=page_size
    )
    return DivisionListOut(**page_payload(items, total, page, page_size, lambda x: x))


@divisions_router.post(
    "",
    response_model=DivisionOut,
    status_code=status.HTTP_201_CREATED,
    summary="创建事业部",
)
async def create_division(
    payload: DivisionCreate,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> DivisionOut:
    division = flow_service.create_division(
        db,
        code=payload.code,
        name=payload.name,
        owner_text=payload.owner_text,
        note=payload.note,
        account=account,
        ctx=ctx,
    )
    return DivisionOut(**flow_service.division_out(db, division))


@divisions_router.get("/{division_id}", response_model=DivisionOut, summary="事业部详情")
async def get_division(
    division_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> DivisionOut:
    division = get_or_404(db, Division, division_id, "事业部")
    return DivisionOut(**flow_service.division_out(db, division))


@divisions_router.patch("/{division_id}", response_model=DivisionOut, summary="更新事业部")
async def update_division(
    division_id: str,
    payload: DivisionUpdate,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> DivisionOut:
    division = get_or_404(db, Division, division_id, "事业部")
    division = flow_service.update_division(db, division, payload=payload, account=account, ctx=ctx)
    return DivisionOut(**flow_service.division_out(db, division))


@divisions_router.post("/{division_id}/archive", response_model=DivisionOut, summary="停用事业部（不物理删除）")
async def archive_division(
    division_id: str,
    payload: ArchiveRequest | None = None,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> DivisionOut:
    division = get_or_404(db, Division, division_id, "事业部")
    division = flow_service.archive_division(
        db, division, reason=payload.reason if payload else None, account=account, ctx=ctx
    )
    return DivisionOut(**flow_service.division_out(db, division))


# =========================================================================== 项目


@projects_router.get("", response_model=ProjectListOut, summary="项目列表（分页 + 过滤，默认按更新时间降序）")
async def list_projects(
    keyword: str | None = Query(default=None),
    project_type: str | None = Query(default=None),
    system_id: str | None = Query(default=None),
    division_id: str | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> ProjectListOut:
    items, total = flow_service.list_projects(
        db,
        keyword=keyword,
        project_type=project_type,
        status=status_filter,
        system_id=system_id,
        division_id=division_id,
        page=page,
        page_size=page_size,
    )
    return ProjectListOut(**page_payload(items, total, page, page_size, lambda x: x))


@projects_router.post(
    "",
    response_model=ProjectDetailOut,
    status_code=status.HTTP_201_CREATED,
    summary="创建项目（自动实例化 13 个节点）",
)
async def create_project(
    payload: ProjectCreate,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> ProjectDetailOut:
    project = flow_service.create_project(db, payload, account, ctx)
    return ProjectDetailOut(**flow_service.project_detail(db, project))


@projects_router.get("/{project_id}", response_model=ProjectDetailOut, summary="项目详情")
async def get_project(
    project_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> ProjectDetailOut:
    project = _project(db, project_id)
    return ProjectDetailOut(**flow_service.project_detail(db, project))


@projects_router.patch("/{project_id}", response_model=ProjectDetailOut, summary="更新项目（乐观锁）")
async def update_project(
    project_id: str,
    payload: ProjectUpdate,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> ProjectDetailOut:
    project = _project(db, project_id)
    project = flow_service.update_project(db, project, payload, account, ctx)
    return ProjectDetailOut(**flow_service.project_detail(db, project))


@projects_router.post("/{project_id}/archive", response_model=ProjectDetailOut, summary="归档项目")
async def archive_project(
    project_id: str,
    payload: ArchiveRequest | None = None,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> ProjectDetailOut:
    project = _project(db, project_id)
    project = flow_service.archive_project(
        db, project, reason=payload.reason if payload else None, account=account, ctx=ctx
    )
    return ProjectDetailOut(**flow_service.project_detail(db, project))


@projects_router.get("/{project_id}/board", response_model=BoardOut, summary="阶段看板（四阶段泳道 + 13 节点卡）")
async def get_board(
    project_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> BoardOut:
    project = _project(db, project_id)
    return BoardOut(**flow_service.board(db, project))


@projects_router.post("/{project_id}/core-business", response_model=ProjectDetailOut, summary="N03 提交核心业务判定")
async def submit_core_business(
    project_id: str,
    payload: CoreBusinessRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> ProjectDetailOut:
    project = _project(db, project_id)
    project = flow_service.submit_core_business(
        db, project, involved=payload.involved, reason=payload.reason, account=account, ctx=ctx
    )
    return ProjectDetailOut(**flow_service.project_detail(db, project))


@projects_router.post(
    "/{project_id}/core-business/confirm",
    response_model=ProjectDetailOut,
    summary="N04 确认核心业务判定",
)
async def confirm_core_business(
    project_id: str,
    payload: CoreBusinessConfirmRequest | None = None,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> ProjectDetailOut:
    project = _project(db, project_id)
    project = flow_service.confirm_core_business(
        db, project, note=payload.note if payload else "", account=account, ctx=ctx
    )
    return ProjectDetailOut(**flow_service.project_detail(db, project))


# =========================================================================== 节点


@nodes_router.get("/meta/specs", response_model=NodeSpecsOut, summary="13 节点冻结定义（含阶段）")
async def node_specs(_account: Account = Depends(get_current_account)) -> NodeSpecsOut:
    return NodeSpecsOut(**flow_service.node_specs_payload())


@nodes_router.get("", response_model=NodeListOut, summary="列出项目节点")
async def list_nodes(
    project_id: str = Query(..., description="项目 ID"),
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> NodeListOut:
    project = _project(db, project_id)
    items = flow_service.list_nodes(db, project)
    return NodeListOut(project_id=project.id, total=len(items), items=items)


@nodes_router.get("/{node_id}", response_model=NodeDetailOut, summary="节点详情")
async def get_node(
    node_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> NodeDetailOut:
    node, project = _node(db, node_id)
    return NodeDetailOut(**flow_service.node_detail(db, project, node))


@nodes_router.post("/{node_id}/transition", response_model=NodeDetailOut, summary="节点状态迁移")
async def transition_node(
    node_id: str,
    payload: TransitionRequest,
    ctx: RequestContext = Depends(get_request_context),
    account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> NodeDetailOut:
    node, project = _node(db, node_id)
    data = flow_service.transition_node(db, project, node, payload, account, ctx)
    return NodeDetailOut(**data)


router.include_router(divisions_router)
router.include_router(projects_router)
router.include_router(nodes_router)

__all__ = ["router"]
