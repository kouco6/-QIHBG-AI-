"""FastAPI 应用入口。

- REST 前缀 /api/v1
- 健康检查 /api/health（无需鉴权）
- 统一错误响应与请求 ID 贯穿
"""

from __future__ import annotations

import logging
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import __version__
from app.core.config import LOG_DIR, settings
from app.core.db import check_database
from app.core.errors import REQUEST_ID_HEADER, install_error_handlers

logger = logging.getLogger("uei")


def _configure_logging() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    handler = logging.FileHandler(LOG_DIR / "backend.log", encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    root = logging.getLogger()
    if not any(isinstance(h, logging.FileHandler) for h in root.handlers):
        root.addHandler(handler)
    root.setLevel(logging.INFO)


def create_app() -> FastAPI:
    _configure_logging()
    app = FastAPI(
        title=settings.app_name,
        version=__version__,
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=[REQUEST_ID_HEADER],
    )

    @app.middleware("http")
    async def _request_context(request: Request, call_next):  # noqa: ANN001, ANN202
        rid = request.headers.get(REQUEST_ID_HEADER) or str(uuid.uuid4())
        request.state.request_id = rid
        started = time.perf_counter()
        response = await call_next(request)
        elapsed_ms = (time.perf_counter() - started) * 1000
        response.headers[REQUEST_ID_HEADER] = rid
        logger.info(
            "%s %s -> %s %.1fms rid=%s",
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms,
            rid,
        )
        return response

    install_error_handlers(app)

    # --- 业务路由（统一 /api/v1 前缀） ---
    from app.api.v1 import api_router

    app.include_router(api_router)

    @app.get("/api/health", tags=["system"])
    async def health() -> JSONResponse:
        """健康检查：数据库连通性、方言与 Provider 模式。"""
        db_ok, db_detail = check_database()
        body = {
            "status": "ok" if db_ok else "degraded",
            "app": settings.app_name,
            "version": __version__,
            "env": settings.app_env,
            "database": {"ok": db_ok, "detail": db_detail},
            "provider": {
                "configured_mode": settings.provider_mode,
                "effective_mode": settings.effective_provider_mode,
                "feishu_configured": settings.feishu_configured,
                "ai_configured": settings.ai_configured,
            },
        }
        return JSONResponse(status_code=200 if db_ok else 503, content=body)

    @app.get("/api/v1/meta", tags=["system"])
    async def meta() -> dict[str, object]:
        """合同元信息，便于前端展示与联调自检。"""
        return {
            "job_id": "0185fa0a-1784-4353-8988-ee1aa4372b32",
            "project": "体验工作台（UEI Experience Workbench）",
            "api_prefix": "/api/v1",
            "role_model": "single-experience-member",
            "frozen_baselines": {
                "workflow_nodes": 13,
                "scoring_schemes": 20,
                "scoring_matrix_cells": 160,
                "dictionary": {
                    "software_l3": 33,
                    "software_check_items": 114,
                    "hardware_l3": 15,
                    "hardware_single_unit_rows": 224,
                    "interactive_components": 46,
                },
            },
        }

    return app


app = create_app()
