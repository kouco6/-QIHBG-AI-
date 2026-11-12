"""字典管理接口（T06）。

权限口径
--------
- **读**（``/{dict_type}/tree``、``/{dict_type}/items``、``/{dict_type}/summary``、
  ``/batches``）：任意登录账号可访问；未登录 401。
- **写**（``/import/precheck``、``/import/apply``、``PATCH /nodes/{id}``、
  ``PATCH /items/{id}``）：**仅首账号**；普通账号 403。
- **删除**：一律禁止。任何 ``DELETE`` 返回 405，并提示
  「被引用条目不能物理删除，只能停用」。
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import RequestContext, get_current_account, get_request_context, require_primary_account
from app.core.db import get_db
from app.core.errors import AppError
from app.models.account import Account
from app.schemas.dictionary import (
    BatchOut,
    CheckItemOut,
    DictSummaryOut,
    ImportRequest,
    ItemPageOut,
    ItemUpdateRequest,
    NodeUpdateRequest,
    TreeOut,
    TreeNodeOut,
    UpdateResultOut,
)
from app.services import dictionary as service
from app.services.common import audit_business

router = APIRouter(prefix="/dictionaries", tags=["dictionaries"])

DELETE_MESSAGE = "被引用条目不能物理删除，只能停用"


class DeleteForbiddenError(AppError):
    """字典条目禁止物理删除（405）。"""

    status_code = 405
    code = "method_not_allowed"


# ----------------------------------------------------------------------------- 读接口


@router.get("/batches", response_model=list[BatchOut], summary="导入批次列表（含来源哈希与计数核对）")
async def list_batches(
    limit: int = Query(default=50, ge=1, le=200),
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> list[BatchOut]:
    return [BatchOut(**row) for row in service.list_batches(db, limit=limit)]


@router.get("/{dict_type}/tree", response_model=TreeOut, summary="字典左树（支持 parent_id 懒加载与 q 搜索）")
async def get_tree(
    dict_type: str,
    parent_id: str | None = Query(default=None, description="父节点 ID；为空返回第一层"),
    q: str | None = Query(default=None, max_length=128, description="按名称/编码搜索"),
    include_inactive: bool = Query(default=True, description="是否包含已停用节点"),
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> TreeOut:
    rows = service.get_tree(
        db, dict_type, parent_id=parent_id, q=q, include_inactive=include_inactive
    )
    return TreeOut(
        dict_type=dict_type,
        label=service.DICT_TYPE_LABELS.get(dict_type, dict_type),
        parent_id=parent_id,
        query=q or "",
        items=[TreeNodeOut(**row) for row in rows],
    )


@router.get("/{dict_type}/items", response_model=ItemPageOut, summary="字典右表（分页与多维过滤）")
async def list_items(
    dict_type: str,
    node_id: str | None = Query(default=None),
    level: int | None = Query(default=None, ge=1, le=6),
    keyword: str | None = Query(default=None, max_length=128),
    status: str = Query(default="all", pattern="^(all|active|inactive)$"),
    item_no_min: int | None = Query(default=None, ge=1),
    item_no_max: int | None = Query(default=None, ge=1),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> ItemPageOut:
    rows, total = service.list_items(
        db,
        dict_type,
        node_id=node_id,
        level=level,
        keyword=keyword,
        status=status,
        item_no_min=item_no_min,
        item_no_max=item_no_max,
        page=page,
        page_size=page_size,
    )
    return ItemPageOut(
        page=page, page_size=page_size, total=total, items=[CheckItemOut(**row) for row in rows]
    )


@router.get("/{dict_type}/summary", response_model=DictSummaryOut, summary="字典层级与检查项计数（数量验收）")
async def summarize(
    dict_type: str,
    _account: Account = Depends(get_current_account),
    db: Session = Depends(get_db),
) -> DictSummaryOut:
    return DictSummaryOut(**service.summarize(db, dict_type))


# ----------------------------------------------------------------------------- 导入（仅首账号）


def _json_dict(raw: str | None) -> dict[str, Any]:
    try:
        value = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _audit_batch(
    db: Session,
    *,
    account: Account,
    ctx: RequestContext,
    action: str,
    batch: object,
    summary: str,
) -> None:
    audit_business(
        db,
        account=account,
        ctx=ctx,
        action=action,
        target_type="dictionary_batch",
        target_id=str(getattr(batch, "id", "")),
        summary=summary,
        detail={
            "status": getattr(batch, "status", ""),
            "dry_run": getattr(batch, "dry_run", False),
            "source_path": getattr(batch, "source_path", ""),
            "source_sha256": getattr(batch, "source_sha256", ""),
            "counts": _json_dict(getattr(batch, "counts_json", "{}")),
            "diff_ok": _json_dict(getattr(batch, "diff_json", "{}")).get("ok"),
        },
    )


@router.post("/import/precheck", response_model=BatchOut, summary="干跑预检（仅首账号；只读源、不落字典数据）")
async def import_precheck(
    payload: ImportRequest | None = None,
    ctx: RequestContext = Depends(get_request_context),
    actor: Account = Depends(require_primary_account),
    db: Session = Depends(get_db),
) -> BatchOut:
    source = payload.source if payload else None
    try:
        batch = service.run_precheck(db, source_path=source, actor_name=actor.name)
    except AppError as exc:
        failed = getattr(exc, "extra", {}).get("batch_id")
        if failed:
            stored = db.get(service.DictionaryBatch, failed)
            if stored is not None:
                _audit_batch(
                    db, account=actor, ctx=ctx, action="dictionary_precheck_blocked",
                    batch=stored, summary=f"干跑预检未通过：{exc.message}",
                )
        raise
    _audit_batch(
        db, account=actor, ctx=ctx, action="dictionary_precheck",
        batch=batch, summary="干跑预检通过（未写入字典数据）",
    )
    return BatchOut(**service.serialize_batch(batch))


@router.post("/import/apply", response_model=BatchOut, summary="真实导入（仅首账号；幂等，失败拒绝落库）")
async def import_apply(
    payload: ImportRequest | None = None,
    ctx: RequestContext = Depends(get_request_context),
    actor: Account = Depends(require_primary_account),
    db: Session = Depends(get_db),
) -> BatchOut:
    source = payload.source if payload else None
    try:
        batch = service.run_import(db, source_path=source, actor_name=actor.name)
    except AppError as exc:
        failed = getattr(exc, "extra", {}).get("batch_id")
        if failed:
            stored = db.get(service.DictionaryBatch, failed)
            if stored is not None:
                _audit_batch(
                    db, account=actor, ctx=ctx, action="dictionary_import_failed",
                    batch=stored, summary=f"真实导入未完成：{exc.message}",
                )
        raise
    _audit_batch(
        db, account=actor, ctx=ctx, action="dictionary_import",
        batch=batch, summary="真实导入完成（幂等）",
    )
    return BatchOut(**service.serialize_batch(batch))


# ----------------------------------------------------------------------------- 维护（仅首账号）


@router.patch("/nodes/{node_id}", response_model=UpdateResultOut, summary="更新字典节点（仅首账号）")
async def update_node(
    node_id: str,
    payload: NodeUpdateRequest,
    ctx: RequestContext = Depends(get_request_context),
    actor: Account = Depends(require_primary_account),
    db: Session = Depends(get_db),
) -> UpdateResultOut:
    node, message = service.update_node(db, node_id, payload.model_dump(exclude_unset=True))
    audit_business(
        db,
        account=actor,
        ctx=ctx,
        action="dictionary_node_updated",
        target_type="dictionary_node",
        target_id=node.id,
        summary=message,
        detail={"dict_type": node.dict_type, "code": node.code, "is_active": node.is_active},
    )
    return UpdateResultOut(node=service.serialize_node(node), message=message)


@router.patch("/items/{item_id}", response_model=UpdateResultOut, summary="更新检查项（仅首账号）")
async def update_item(
    item_id: str,
    payload: ItemUpdateRequest,
    ctx: RequestContext = Depends(get_request_context),
    actor: Account = Depends(require_primary_account),
    db: Session = Depends(get_db),
) -> UpdateResultOut:
    item, message = service.update_item(db, item_id, payload.model_dump(exclude_unset=True))
    audit_business(
        db,
        account=actor,
        ctx=ctx,
        action="dictionary_item_updated",
        target_type="check_item",
        target_id=item.id,
        summary=message,
        detail={"dict_type": item.dict_type, "item_no": item.item_no, "is_active": item.is_active},
    )
    return UpdateResultOut(item=service.serialize_item(item), message=message)


# ----------------------------------------------------------------------------- 删除一律禁止


def _reject_delete(*_args: object, **_kwargs: object) -> None:
    raise DeleteForbiddenError(DELETE_MESSAGE, extra={"hint": "请改用 PATCH 将条目 is_active 置为 false"})


@router.delete("/nodes/{node_id}", summary="禁止物理删除字典节点")
async def delete_node(node_id: str) -> None:
    _reject_delete(node_id)


@router.delete("/items/{item_id}", summary="禁止物理删除检查项")
async def delete_item(item_id: str) -> None:
    _reject_delete(item_id)


@router.delete("/{rest:path}", summary="禁止对字典发起任何删除请求")
async def delete_any(rest: str) -> None:
    _reject_delete(rest)
