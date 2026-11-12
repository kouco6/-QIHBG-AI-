"""BEI（事业部体验重视度指数）常量与归一化算法（PRD §8.8 / T01 冻结阈值表）。

来源：``docs/BEI_THRESHOLD_SOURCE.md``（自 PRD V1.2 §8.8.6 提取）。
状态：**经验阈值 · 待校准** —— 运行期以「阈值版本」实体管理，可新增版本，
不得原地覆盖；本模块仅作为首版种子与算法实现。

硬性口径：

1. 维度分 = 该维度下**有数据**的二级指标分的**算术平均**；
2. 某维度**全部无数据** → 该维度整体剔除，剩余维度权重**等比放大**至 100%；
3. 参评问题 < 5 → 样本不足，不给分不排名；同期无在研产品 → 本期无参评数据（不记 0）；
4. 人工印象分占比 **≤ 20%**，与自动分**分栏**存储与显示。
"""

from __future__ import annotations

from decimal import Decimal
from typing import NamedTuple

# --- 方向 ---
DIRECTION_HIGHER_BETTER = "higher_better"  # ↑
DIRECTION_LOWER_BETTER = "lower_better"    # ↓
DIRECTION_LABELS = {DIRECTION_HIGHER_BETTER: "越大越好", DIRECTION_LOWER_BETTER: "越小越好"}

# --- 归一化断点键 ---
FULL_SCORE_LINE = Decimal("100")
PASS_SCORE_LINE = Decimal("60")
ZERO_SCORE_LINE = Decimal("0")

# --- 数据充分性 ---
MIN_ISSUES_FOR_SCORE = 5
SAMPLE_GAP_CODE = "insufficient_sample"
NO_DATA_CODE = "no_participating_data"

# --- 人工分上限 ---
MANUAL_WEIGHT_MAX = Decimal("0.20")
MANUAL_WEIGHT_DEFAULT = Decimal("0.20")
AUTO_WEIGHT_MIN = Decimal("0.80")

DISCLAIMER = "本指数仅反映事业部对产品体验的重视程度，不作为人事考核依据。"

THRESHOLD_VERSION_STATUS = "经验阈值 · 待校准"


class MetricSpec(NamedTuple):
    """二级指标定义（含经验阈值三线断点）。"""

    key: str
    dimension: str
    name: str
    unit: str
    direction: str
    full: str | None       # 满分线（100 分）
    passing: str | None    # 及格线（60 分）
    zero: str | None       # 零分线（0 分）
    source_field: str      # 自动取数来源
    drill_down: str        # 下钻说明
    scoring: bool = True   # False = 仅说明性指标，不参与单点归一化


class DimensionSpec(NamedTuple):
    code: str
    name: str
    weight: str
    metrics: tuple[str, ...]


DIMENSIONS: tuple[DimensionSpec, ...] = (
    DimensionSpec("D1", "响应及时性", "0.20", ("response_rate", "first_response_hours", "overdue_unreplied")),
    DimensionSpec("D2", "问题闭环率", "0.25", ("issue_close_rate", "on_time_close_rate", "overdue_backlog")),
    DimensionSpec("D3", "整改质量", "0.20", ("retest_pass_rate", "avg_retry_after_reject", "repeat_issue_rate")),
    DimensionSpec("D4", "体验投入度", "0.20", ("commitment_fulfill_rate", "experience_adoption_rate", "review_participation")),
    DimensionSpec("D5", "体验成效", "0.15", ("uei_gain", "critical_major_drop_rate", "product_line_uei_contribution")),
)
DIMENSION_BY_CODE: dict[str, DimensionSpec] = {d.code: d for d in DIMENSIONS}

METRICS: tuple[MetricSpec, ...] = (
    # D1
    MetricSpec("response_rate", "D1", "问题回复率", "%", DIRECTION_HIGHER_BETTER, "95", "80", "60",
               "问题·事业部回复及其时间戳", "下钻到未回复问题清单"),
    MetricSpec("first_response_hours", "D1", "平均首次响应时长", "小时", DIRECTION_LOWER_BETTER, "8", "48", "120",
               "问题·事业部回复时间戳 − 问题登记时间", "下钻到每条问题的响应时长"),
    MetricSpec("overdue_unreplied", "D1", "超期未回复数", "条", DIRECTION_LOWER_BETTER, "0", "3", "10",
               "问题·超期且无回复计数", "下钻到超期未回复问题清单"),
    # D2
    MetricSpec("issue_close_rate", "D2", "问题关闭率", "%", DIRECTION_HIGHER_BETTER, "90", "70", "50",
               "问题状态流转", "下钻到未关闭问题清单"),
    MetricSpec("on_time_close_rate", "D2", "承诺版本内按期关闭率", "%", DIRECTION_HIGHER_BETTER, "85", "65", "45",
               "承诺修改版本 vs 实际发布版本", "下钻到逾期关闭问题清单"),
    MetricSpec("overdue_backlog", "D2", "超期遗留数", "条", DIRECTION_LOWER_BETTER, "0", "3", "10",
               "承诺版本已发布而未关闭的问题数", "下钻到超期遗留问题清单"),
    # D3
    MetricSpec("retest_pass_rate", "D3", "复测验收通过率", "%", DIRECTION_HIGHER_BETTER, "95", "80", "60",
               "问题验收记录", "下钻到驳回问题清单"),
    MetricSpec("avg_retry_after_reject", "D3", "驳回后平均重试次数", "次", DIRECTION_LOWER_BETTER, "0.2", "1.0", "2.0",
               "问题·驳回次数与整改记录", "下钻到多次驳回问题清单"),
    MetricSpec("repeat_issue_rate", "D3", "同类问题重复发生率", "%", DIRECTION_LOWER_BETTER, "5", "15", "30",
               "问题去重比对（模块＋二级指标）", "下钻到重复问题清单"),
    # D4
    MetricSpec("commitment_fulfill_rate", "D4", "承诺版本兑现率", "%", DIRECTION_HIGHER_BETTER, "95", "80", "60",
               "承诺修改版本 vs 实际发布版本", "下钻到未兑现承诺清单"),
    MetricSpec("experience_adoption_rate", "D4", "体验需求采纳率", "%", DIRECTION_HIGHER_BETTER, "70", "50", "30",
               "问题解决方案采纳比", "下钻到未采纳问题清单"),
    MetricSpec("review_participation", "D4", "评审参与记录（缺席次数）", "次", DIRECTION_LOWER_BETTER, "0", "1", "3",
               "评审部门签署（代录）", "下钻到评审签署记录"),
    # D5
    MetricSpec("uei_gain", "D5", "版本 UEI 提升幅度", "分", DIRECTION_HIGHER_BETTER, "5", "0", "-5",
               "评分快照对比", "下钻到前后两个 L1 快照"),
    MetricSpec("critical_major_drop_rate", "D5", "致命+严重问题下降率", "%", DIRECTION_HIGHER_BETTER, "40", "0", "-20",
               "评分快照问题等级分布", "下钻到两期致命/严重问题清单"),
    MetricSpec("product_line_uei_contribution", "D5", "产品线 UEI 贡献度", "%", DIRECTION_HIGHER_BETTER, None, None, None,
               "该部门产品线 UEI 占其全域比重", "说明性指标，不参与单点打分", scoring=False),
)
METRIC_BY_KEY: dict[str, MetricSpec] = {m.key: m for m in METRICS}

SCORING_METRICS: tuple[MetricSpec, ...] = tuple(m for m in METRICS if m.scoring)
DESCRIPTIVE_METRICS: tuple[MetricSpec, ...] = tuple(m for m in METRICS if not m.scoring)

# --- 四档 ---
GRADE_EXCELLENT = "excellent"
GRADE_GOOD = "good"
GRADE_FAIR = "fair"
GRADE_POOR = "poor"

GRADE_BANDS: tuple[tuple[str, str, str, str | None], ...] = (
    # (code, label, lower_bound_inclusive, upper_bound_exclusive)
    (GRADE_EXCELLENT, "卓越", "85", None),
    (GRADE_GOOD, "良好", "70", "85"),
    (GRADE_FAIR, "一般", "55", "70"),
    (GRADE_POOR, "待改进", None, "55"),
)
GRADE_LABELS: dict[str, str] = {code: label for code, label, _, _ in GRADE_BANDS}
GRADE_SEMANTICS: dict[str, str] = {
    GRADE_EXCELLENT: "主动推动体验改进，承诺必兑现",
    GRADE_GOOD: "响应与闭环良好，个别项待补",
    GRADE_FAIR: "基本响应，闭环与整改质量不稳定",
    GRADE_POOR: "响应滞后或承诺兑现差",
}


def normalize(spec: MetricSpec, raw: Decimal | float | int | None) -> Decimal | None:
    """按经验阈值三线断点归一化到 0–100；无数据返回 ``None``。

    采用**线性插值**：满分线→100、及格线→60、零分线→0。
    超出满分/零分线时截断到 100 / 0。
    """
    if raw is None or not spec.scoring:
        return None
    value = Decimal(str(raw))
    full = Decimal(spec.full or "0")
    passing = Decimal(spec.passing or "0")
    zero = Decimal(spec.zero or "0")

    if spec.direction == DIRECTION_HIGHER_BETTER:
        if value >= full:
            return FULL_SCORE_LINE
        if value <= zero:
            return ZERO_SCORE_LINE
        if value >= passing:
            span = full - passing
            if span == 0:
                return FULL_SCORE_LINE
            return PASS_SCORE_LINE + (value - passing) / span * (FULL_SCORE_LINE - PASS_SCORE_LINE)
        span = passing - zero
        if span == 0:
            return ZERO_SCORE_LINE
        return (value - zero) / span * PASS_SCORE_LINE

    # 越小越好
    if value <= full:
        return FULL_SCORE_LINE
    if value >= zero:
        return ZERO_SCORE_LINE
    if value <= passing:
        span = passing - full
        if span == 0:
            return FULL_SCORE_LINE
        return FULL_SCORE_LINE - (value - full) / span * (FULL_SCORE_LINE - PASS_SCORE_LINE)
    span = zero - passing
    if span == 0:
        return ZERO_SCORE_LINE
    return PASS_SCORE_LINE - (value - passing) / span * PASS_SCORE_LINE


def rescale_weights(active_dimensions: list[str]) -> dict[str, Decimal]:
    """缺失维度剔除后，剩余维度权重**等比放大**至 100%。"""
    base = {d.code: Decimal(d.weight) for d in DIMENSIONS if d.code in active_dimensions}
    total = sum(base.values(), Decimal("0"))
    if total == 0:
        return {}
    factor = Decimal("1") / total
    return {code: weight * factor for code, weight in base.items()}


def grade_of(score: Decimal | float | None) -> str | None:
    """档位判定；``None``（无分/样本不足）返回 ``None``。"""
    if score is None:
        return None
    value = Decimal(str(score))
    for code, _label, lower, upper in GRADE_BANDS:
        low_ok = lower is None or value >= Decimal(lower)
        high_ok = upper is None or value < Decimal(upper)
        if low_ok and high_ok:
            return code
    return None


def assert_config_frozen() -> None:
    """自检：五维权重、指标数量、四档边界。"""
    assert len(DIMENSIONS) == 5, "BEI 维度必须为 5"
    total = sum((Decimal(d.weight) for d in DIMENSIONS), Decimal("0"))
    assert total == Decimal("1.00"), f"五维权重合计必须为 1.00，实际 {total}"
    assert [d.weight for d in DIMENSIONS] == ["0.20", "0.25", "0.20", "0.20", "0.15"]
    assert len(METRICS) == 15, f"二级指标必须为 15，实际 {len(METRICS)}"
    assert len(SCORING_METRICS) == 14, "参与打分的二级指标必须为 14（贡献度为说明性）"
    for dim in DIMENSIONS:
        for key in dim.metrics:
            assert key in METRIC_BY_KEY, f"{dim.code} 引用了不存在的指标 {key}"
            assert METRIC_BY_KEY[key].dimension == dim.code
    assert grade_of(Decimal("85")) == GRADE_EXCELLENT
    assert grade_of(Decimal("84.9")) == GRADE_GOOD
    assert grade_of(Decimal("70")) == GRADE_GOOD
    assert grade_of(Decimal("69.9")) == GRADE_FAIR
    assert grade_of(Decimal("55")) == GRADE_FAIR
    assert grade_of(Decimal("54.9")) == GRADE_POOR
    assert grade_of(None) is None


assert_config_frozen()
