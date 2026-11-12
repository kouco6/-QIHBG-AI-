"""结构化产物路由（T05 / DESIGN §6.2.2、§6.6、PRD §7.3）。

端点族：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | ``/artifacts/templates`` | 模板列表（可按 ``node_code`` 过滤） |
| GET | ``/artifacts/templates/{kind}`` | 单模板详情 |
| GET | ``/artifacts`` | 产物列表（project_id / node_id / kind / status + 分页） |
| POST | ``/artifacts`` | 创建产物（自动生成草稿版本 1） |
| GET | ``/artifacts/{id}`` | 详情（当前版本 payload + 模板 + 可用动作） |
| PATCH | ``/artifacts/{id}`` | 更新标题 / 协作人文本 |
| PUT·POST | ``/artifacts/{id}/draft`` | 草稿自动保存（冻结版本自动派生新版本） |
| POST | ``/artifacts/{id}/submit`` | 提交（必填校验 + 冻结当前版本） |
| POST | ``/artifacts/{id}/confirm`` | 确认（签名表实际提供人校验） |
| POST | ``/artifacts/{id}/return`` | 退回（原因必填） |
| POST | ``/artifacts/{id}/resume`` | 恢复 / 重开为草稿 |
| POST | ``/artifacts/{id}/mark-na`` | 标记不适用（原因必填 + 模板需允许） |
| GET | ``/artifacts/{id}/versions`` | 版本列表 |
| GET | ``/artifacts/{id}/versions/{no}`` | 单版本 |
| GET | ``/artifacts/{id}/diff?from=&to=`` | 字段级差异 |
| POST | ``/artifacts/{id}/issue-refs`` | 写入当前版本的问题引用 |

统一约束：全部端点需登录（否则 401）；实体不存在 404；非法迁移 409 且携带
``current`` / ``target`` / ``reason`` / ``allowed_targets``；所有写操作写业务审计。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.api.deps import RequestContext, get_current_account, get_request_context
from app.core.db import get_db
from app.core.timeutil import iso_z
from app.models.account import Account
from app.models.artifact import Artifact
from app.models.flow import Project
from app.schemas.artifacts import (
    ArtifactCreateRequest,
    ArtifactDetailOut,
    ArtifactOut,
    ArtifactPageOut,
    ArtifactPatchRequest,
    ArtifactVersionOut,
    DraftSaveOut,
    DraftSaveRequest,
    FieldDiffOut,
    IssueRefsRequest,
    MarkNotApplicableRequest,
    ResumeRequest,
    ReturnRequest,
    SubmitRequest,
    TemplateOut,
)
from app.services import artifacts as artifacts_service
from app.services.common import audit_business, get_or_404

router = APIRouter(prefix="/artifacts", tags=["artifacts"])

TARGET_TYPE = "artifact"


def _audit(
    db: Session,
    *,
    actor: Account,
    ctx: RequestContext,
    action: str,
    target_id: str,
    summary: str,
    detail: dict | None = None,
) -> None:
    audit_business(
        db,
        account=actor,
        ctx=ctx,
        action=action,
        target_type=TARGET_TYPE,
        target_id=target_id,
        summary=summary,
        detail=detail or {},
    )


# ------------------------------------------------------------------------- 模板

# 注意：``/templates`` 必须先于 ``/{artifact_id}`` 注册，避免路径被当作产物 ID。
@router.get("/templates", response_model=list[TemplateOut], summary="产物模板列表")
async def list_templates(
    node_code: str | None = Query(default=None, description="按节点过滤，如 N01"),
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> list[TemplateOut]:
    rows = artifacts_service.list_templates(db, node_code=node_code)
    return [TemplateOut(**artifacts_service.serialize_template_row(row)) for row in rows]


@router.get("/templates/{kind}", response_model=TemplateOut, summary="单个产物模板详情")
async def get_template(
    kind: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> TemplateOut:
    row = artifacts_service.get_template(db, kind)
    return TemplateOut(**artifacts_service.serialize_template_row(row))


# ------------------------------------------------------------------------- 产物

@router.get("", response_model=ArtifactPageOut, summary="产物列表（过滤 + 分页）")
async def list_artifacts(
    project_id: str | None = Query(default=None),
    node_id: str | None = Query(default=None),
    kind: str | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> ArtifactPageOut:
    rows, total = artifacts_service.list_artifacts(
        db,
        project_id=project_id,
        node_id=node_id,
        kind=kind,
        status=status_filter,
        page=page,
        page_size=page_size,
    )
    return ArtifactPageOut(
        page=page,
        page_size=page_size,
        total=total,
        items=[ArtifactOut(**artifacts_service.serialize_artifact(row)) for row in rows],
    )


@router.post(
    "",
    response_model=ArtifactDetailOut,
    status_code=status.HTTP_201_CREATED,
    summary="创建产物（自动创建草稿版本 1）",
)
async def create_artifact(
    payload: ArtifactCreateRequest,
    ctx: RequestContext = Depends(get_request_context),
    actor: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> ArtifactDetailOut:
    project = get_or_404(db, Project, payload.project_id, "项目")
    node = artifacts_service.resolve_node(
        db, project=project, node_id=payload.node_id, node_code=payload.node_code
    )
    artifacts_service.check_kind_for_node(payload.kind, node)

    artifact = artifacts_service.create_artifact(
        db,
        account=actor,
        project=project,
        node=node,
        kind=payload.kind,
        title=payload.title,
        collaborators_text=payload.collaborators_text,
        payload=payload.payload,
    )
    _audit(
        db,
        actor=actor,
        ctx=ctx,
        action="artifact_created",
        target_id=artifact.id,
        summary=f"创建产物「{artifact.title or artifact.kind}」（{node.code}）",
        detail={
            "project_id": project.id,
            "node_code": node.code,
            "kind": artifact.kind,
            "version_no": artifact.current_version_no,
        },
    )
    return ArtifactDetailOut(**artifacts_service.serialize_artifact_detail(db, artifact))


@router.get("/{artifact_id}", response_model=ArtifactDetailOut, summary="产物详情")
async def get_artifact(
    artifact_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> ArtifactDetailOut:
    artifact = artifacts_service.get_artifact(db, artifact_id)
    return ArtifactDetailOut(**artifacts_service.serialize_artifact_detail(db, artifact))


@router.patch("/{artifact_id}", response_model=ArtifactDetailOut, summary="更新标题 / 协作人")
async def patch_artifact(
    artifact_id: str,
    payload: ArtifactPatchRequest,
    ctx: RequestContext = Depends(get_request_context),
    actor: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> ArtifactDetailOut:
    artifact = artifacts_service.get_artifact(db, artifact_id)
    artifact = artifacts_service.update_artifact(
        db,
        artifact=artifact,
        account=actor,
        title=payload.title,
        collaborators_text=payload.collaborators_text,
    )
    _audit(
        db,
        actor=actor,
        ctx=ctx,
        action="artifact_updated",
        target_id=artifact.id,
        summary=f"更新产物「{artifact.title or artifact.kind}」的标题 / 协作人",
        detail={"title": artifact.title, "collaborators_text": artifact.collaborators_text},
    )
    return ArtifactDetailOut(**artifacts_service.serialize_artifact_detail(db, artifact))


# ------------------------------------------------------------------------- 草稿

@router.put("/{artifact_id}/draft", response_model=DraftSaveOut, summary="草稿自动保存（PUT）")
@router.post("/{artifact_id}/draft", response_model=DraftSaveOut, summary="草稿自动保存（POST）")
async def save_draft(
    artifact_id: str,
    payload: DraftSaveRequest,
    ctx: RequestContext = Depends(get_request_context),
    actor: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> DraftSaveOut:
    artifact = artifacts_service.get_artifact(db, artifact_id)
    version, saved_at = artifacts_service.save_draft(
        db,
        artifact=artifact,
        account=actor,
        payload=payload.payload,
        autosave=payload.autosave,
    )
    _audit(
        db,
        actor=actor,
        ctx=ctx,
        action="artifact_draft_saved",
        target_id=artifact.id,
        summary=f"自动保存产物草稿 v{version.version_no}",
        detail={
            "version_no": version.version_no,
            "is_frozen": version.is_frozen,
            "autosave": payload.autosave,
        },
    )
    return DraftSaveOut(
        version_no=version.version_no, saved_at=iso_z(saved_at), autosave=payload.autosave
    )


# ------------------------------------------------------------------------- 状态迁移

@router.post("/{artifact_id}/submit", response_model=ArtifactDetailOut, summary="提交产物")
async def submit_artifact(
    artifact_id: str,
    payload: SubmitRequest,
    ctx: RequestContext = Depends(get_request_context),
    actor: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> ArtifactDetailOut:
    artifact = artifacts_service.get_artifact(db, artifact_id)
    version = artifacts_service.submit(
        db,
        artifact=artifact,
        account=actor,
        payload=payload.payload,
        change_note=payload.change_note,
    )
    _audit(
        db,
        actor=actor,
        ctx=ctx,
        action="artifact_submitted",
        target_id=artifact.id,
        summary=f"提交产物「{artifact.title or artifact.kind}」v{version.version_no}",
        detail={"version_no": version.version_no, "to_status": artifact.status},
    )
    return ArtifactDetailOut(**artifacts_service.serialize_artifact_detail(db, artifact))


@router.post("/{artifact_id}/confirm", response_model=ArtifactDetailOut, summary="确认产物")
async def confirm_artifact(
    artifact_id: str,
    ctx: RequestContext = Depends(get_request_context),
    actor: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> ArtifactDetailOut:
    artifact = artifacts_service.get_artifact(db, artifact_id)
    version = artifacts_service.confirm(db, artifact=artifact, account=actor)
    _audit(
        db,
        actor=actor,
        ctx=ctx,
        action="artifact_confirmed",
        target_id=artifact.id,
        summary=f"确认产物「{artifact.title or artifact.kind}」v{version.version_no}",
        detail={"version_no": version.version_no, "to_status": artifact.status},
    )
    return ArtifactDetailOut(**artifacts_service.serialize_artifact_detail(db, artifact))


@router.post("/{artifact_id}/return", response_model=ArtifactDetailOut, summary="退回产物")
async def return_artifact(
    artifact_id: str,
    payload: ReturnRequest,
    ctx: RequestContext = Depends(get_request_context),
    actor: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> ArtifactDetailOut:
    artifact = artifacts_service.get_artifact(db, artifact_id)
    artifact, reason = artifacts_service.return_artifact(
        db, artifact=artifact, account=actor, reason=payload.reason
    )
    _audit(
        db,
        actor=actor,
        ctx=ctx,
        action="artifact_returned",
        target_id=artifact.id,
        summary=f"退回产物「{artifact.title or artifact.kind}」",
        detail={"reason": reason, "to_status": artifact.status},
    )
    return ArtifactDetailOut(**artifacts_service.serialize_artifact_detail(db, artifact))


@router.post("/{artifact_id}/resume", response_model=ArtifactDetailOut, summary="恢复 / 重开为草稿")
async def resume_artifact(
    artifact_id: str,
    payload: ResumeRequest,
    ctx: RequestContext = Depends(get_request_context),
    actor: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> ArtifactDetailOut:
    artifact = artifacts_service.get_artifact(db, artifact_id)
    from_status = artifact.status
    version = artifacts_service.resume(
        db,
        artifact=artifact,
        account=actor,
        reason=payload.reason,
        change_note=payload.change_note,
    )
    _audit(
        db,
        actor=actor,
        ctx=ctx,
        action="artifact_resumed",
        target_id=artifact.id,
        summary=f"产物从「{from_status}」恢复为草稿 v{version.version_no}",
        detail={
            "from_status": from_status,
            "to_status": artifact.status,
            "version_no": version.version_no,
            "reason": payload.reason,
            "change_note": payload.change_note,
        },
    )
    return ArtifactDetailOut(**artifacts_service.serialize_artifact_detail(db, artifact))


@router.post(
    "/{artifact_id}/mark-na", response_model=ArtifactDetailOut, summary="标记产物不适用"
)
async def mark_not_applicable(
    artifact_id: str,
    payload: MarkNotApplicableRequest,
    ctx: RequestContext = Depends(get_request_context),
    actor: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> ArtifactDetailOut:
    artifact = artifacts_service.get_artifact(db, artifact_id)
    artifact = artifacts_service.mark_not_applicable(
        db, artifact=artifact, account=actor, reason=payload.reason
    )
    _audit(
        db,
        actor=actor,
        ctx=ctx,
        action="artifact_marked_na",
        target_id=artifact.id,
        summary=f"标记产物「{artifact.title or artifact.kind}」不适用",
        detail={"reason": payload.reason, "to_status": artifact.status},
    )
    return ArtifactDetailOut(**artifacts_service.serialize_artifact_detail(db, artifact))


# ------------------------------------------------------------------------- 版本与差异

@router.get(
    "/{artifact_id}/versions",
    response_model=list[ArtifactVersionOut],
    summary="产物版本列表",
)
async def list_versions(
    artifact_id: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> list[ArtifactVersionOut]:
    artifact = artifacts_service.get_artifact(db, artifact_id)
    rows = artifacts_service.list_versions(db, artifact)
    return [ArtifactVersionOut(**artifacts_service.serialize_version(row)) for row in rows]


@router.get(
    "/{artifact_id}/versions/{version_no}",
    response_model=ArtifactVersionOut,
    summary="单个产物版本",
)
async def get_version(
    artifact_id: str,
    version_no: int,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> ArtifactVersionOut:
    artifact = artifacts_service.get_artifact(db, artifact_id)
    version = artifacts_service.get_version(db, artifact, version_no)
    return ArtifactVersionOut(**artifacts_service.serialize_version(version))


@router.get(
    "/{artifact_id}/diff",
    response_model=list[FieldDiffOut],
    summary="字段级版本差异",
)
async def diff_versions(
    artifact_id: str,
    from_version: int = Query(alias="from", description="起始版本号"),
    to_version: int = Query(alias="to", description="目标版本号"),
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> list[FieldDiffOut]:
    artifact = artifacts_service.get_artifact(db, artifact_id)
    rows = artifacts_service.diff_versions(db, artifact, from_version, to_version)
    return [FieldDiffOut(**row) for row in rows]


# ------------------------------------------------------------------------- 问题引用

@router.post(
    "/{artifact_id}/issue-refs", response_model=ArtifactVersionOut, summary="更新问题引用"
)
async def set_issue_refs(
    artifact_id: str,
    payload: IssueRefsRequest,
    ctx: RequestContext = Depends(get_request_context),
    actor: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> ArtifactVersionOut:
    artifact: Artifact = artifacts_service.get_artifact(db, artifact_id)
    version = artifacts_service.set_issue_refs(
        db, artifact=artifact, account=actor, issue_ids=payload.issue_ids
    )
    _audit(
        db,
        actor=actor,
        ctx=ctx,
        action="artifact_issue_refs_updated",
        target_id=artifact.id,
        summary=f"更新产物「{artifact.title or artifact.kind}」的问题引用",
        detail={"version_no": version.version_no, "issue_ids": payload.issue_ids},
    )
    return ArtifactVersionOut(**artifacts_service.serialize_version(version))
