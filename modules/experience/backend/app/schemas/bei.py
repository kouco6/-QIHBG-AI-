"""BEI 事业部评价（L3）请求模型（T11）。

仅承载**请求体**；响应统一由服务层组装为字典（含分栏、下钻与免责声明），
便于前端按页面区域直接消费，也便于测试逐字段断言。

约束（PRD §8.8 / ACCEPTANCE「L3 事业部 BEI」）：

- 人工印象分必须同时提供 ``score`` / ``reason``（事由）/ ``basis``（依据），缺一即 422；
- ``weight``（人工占比）上限 0.20，超出由服务层返回 422；
- 阈值版本创建仅首账号可用（路由层 403）。
"""

from __future__ import annotations

from decimal import Decimal

from pydantic import BaseModel, Field

# 人工印象分上限（与 app.domain.bei.MANUAL_WEIGHT_MAX 一致，此处仅用于字段声明）
MANUAL_WEIGHT_MAX = Decimal("0.20")


class ThresholdItemIn(BaseModel):
    """二级指标阈值断点覆盖项（维度/方向/名称取自领域冻结定义，不在此处传入）。"""

    metric_key: str = Field(min_length=1, max_length=64)
    full_line: str | None = Field(default=None, max_length=24)
    pass_line: str | None = Field(default=None, max_length=24)
    zero_line: str | None = Field(default=None, max_length=24)


class ThresholdVersionCreateRequest(BaseModel):
    """新建阈值版本（不覆盖旧版本；旧版本自动置 retired）。"""

    version_label: str = Field(min_length=1, max_length=32)
    source_ref: str | None = Field(default=None, max_length=255)
    source_note: str | None = Field(default=None, max_length=2000)
    weights: dict[str, str] | None = Field(
        default=None, description="五维权重覆盖：{D1..D5: '0.20'}，缺省沿用上一版（首版为 PRD §8.8.2）"
    )
    items: list[ThresholdItemIn] | None = Field(
        default=None, description="二级指标断点覆盖；缺省沿用上一版（首版为 PRD §8.8.6）"
    )


class BeiPreviewRequest(BaseModel):
    """季度实时预估（未定榜）。"""

    division_id: str = Field(min_length=1)
    period: str = Field(min_length=6, max_length=8, description="评价季度，如 2026Q4")


class BeiFinalizeRequest(BaseModel):
    """季度定榜（不可变）。"""

    division_id: str = Field(min_length=1)
    period: str = Field(min_length=6, max_length=8)


class BeiManualScoreRequest(BaseModel):
    """人工印象分：事由、依据必填；不得改写自动指标。"""

    score: Decimal = Field(ge=0, le=100, description="人工印象分 0–100")
    reason: str = Field(min_length=1, max_length=2000, description="事由（必填）")
    basis: str = Field(min_length=1, max_length=2000, description="依据（必填）")
    weight: Decimal | None = Field(
        default=None, ge=0, le=1, description="人工占比，上限 0.20；缺省 0.20"
    )


class BeiNoteRequest(BaseModel):
    """说明备注：留录入人与时间，不影响任何指标数值与得分。"""

    content: str = Field(min_length=1, max_length=2000)
