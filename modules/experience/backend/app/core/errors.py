"""统一错误模型与异常处理器。

响应形状（DESIGN §5）：{code, message, field_errors, request_id}
语义：未登录 401 / 设置越权 403 / 不存在 404 / 版本或状态冲突 409 / 校验失败 422
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

REQUEST_ID_HEADER = "X-Request-Id"


class AppError(Exception):
    """业务异常基类。"""

    status_code: int = status.HTTP_400_BAD_REQUEST
    code: str = "bad_request"

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        status_code: int | None = None,
        field_errors: list[dict[str, Any]] | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        if code:
            self.code = code
        if status_code:
            self.status_code = status_code
        self.field_errors = field_errors or []
        self.extra = extra or {}


class UnauthorizedError(AppError):
    status_code = status.HTTP_401_UNAUTHORIZED
    code = "unauthorized"


class ForbiddenError(AppError):
    status_code = status.HTTP_403_FORBIDDEN
    code = "forbidden"


class NotFoundError(AppError):
    status_code = status.HTTP_404_NOT_FOUND
    code = "not_found"


class ConflictError(AppError):
    """非法状态迁移、版本冲突、并发更新冲突。"""

    status_code = status.HTTP_409_CONFLICT
    code = "conflict"


class ValidationError(AppError):
    # 直接使用 422 字面值：避免 starlette 新旧常量名差异带来的弃用告警
    status_code = 422
    code = "validation_error"


class BlockedError(AppError):
    """前置条件缺失（例如源不可读、阈值缺失）导致的显式阻塞。"""

    status_code = status.HTTP_409_CONFLICT
    code = "blocked"


def _request_id(request: Request) -> str:
    rid = request.headers.get(REQUEST_ID_HEADER)
    if rid:
        return rid
    rid = str(uuid.uuid4())
    request.state.request_id = rid
    return rid


def _payload(code: str, message: str, request_id: str, field_errors: list[dict[str, Any]] | None = None, **extra: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "code": code,
        "message": message,
        "field_errors": field_errors or [],
        "request_id": request_id,
    }
    if extra:
        body.update(extra)
    return body


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError) -> JSONResponse:  # noqa: ANN202
        rid = _request_id(request)
        return JSONResponse(
            status_code=exc.status_code,
            content=_payload(exc.code, exc.message, rid, exc.field_errors, **exc.extra),
            headers={REQUEST_ID_HEADER: rid},
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:  # noqa: ANN202
        rid = _request_id(request)
        field_errors = []
        for err in exc.errors():
            loc = [str(x) for x in err.get("loc", []) if x != "body"]
            field_errors.append(
                {
                    "field": ".".join(loc) or "body",
                    "message": err.get("msg", "校验失败"),
                    "type": err.get("type", "value_error"),
                }
            )
        return JSONResponse(
            status_code=422,
            content=_payload("validation_error", "请求参数校验失败", rid, field_errors),
            headers={REQUEST_ID_HEADER: rid},
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:  # noqa: ANN202
        rid = _request_id(request)
        code_map = {401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "method_not_allowed", 409: "conflict"}
        code = code_map.get(exc.status_code, "http_error")
        return JSONResponse(
            status_code=exc.status_code,
            content=_payload(code, str(exc.detail), rid),
            headers={REQUEST_ID_HEADER: rid},
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:  # noqa: ANN202
        rid = _request_id(request)
        # 不向客户端泄漏堆栈；详细内容仅进服务端日志
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=_payload("internal_error", "服务内部错误，请稍后重试或联系管理员", rid),
            headers={REQUEST_ID_HEADER: rid},
        )
