"""UEI 评分矩阵与口径常量（PRD §8.1–§8.6）。

**单一数据源**：20 套方案 × 8 个矩阵单元 = **160 个单元** 在此逐字冻结（来自
PRD V1.2 §8.3 表格），种子脚本据此写入 ``scoring_scheme_cells``；业务计算
**只读数据库**，不读本模块，以保证「矩阵是数据、可维护、可版本化」。

关键口径（不可违反）：

- 矩阵中的单问题扣分值**已包含业务权重**，禁止再乘 80% / 20%；
- 每条问题按「业务等级 × 问题等级」命中唯一单元；
- 默认方案 = ``8:2 / 7:5:3:1``；
- 内部使用 ``Decimal`` 十进制定点运算，展示保留 1 位小数。
"""

from __future__ import annotations

from decimal import Decimal

from typing import NamedTuple

# --- 业务等级 ---
BUSINESS_CORE = "core"
BUSINESS_NON_CORE = "non_core"
BUSINESS_LEVELS: tuple[str, ...] = (BUSINESS_CORE, BUSINESS_NON_CORE)
BUSINESS_LEVEL_LABELS: dict[str, str] = {
    BUSINESS_CORE: "核心业务",
    BUSINESS_NON_CORE: "非核心业务",
}

# --- 问题等级（PRD §8.2） ---
SEVERITY_FATAL = "fatal"
SEVERITY_MAJOR = "major"
SEVERITY_NORMAL = "normal"
SEVERITY_MINOR = "minor"
SEVERITY_LEVELS: tuple[str, ...] = (SEVERITY_FATAL, SEVERITY_MAJOR, SEVERITY_NORMAL, SEVERITY_MINOR)
SEVERITY_LABELS: dict[str, str] = {
    SEVERITY_FATAL: "致命",
    SEVERITY_MAJOR: "严重",
    SEVERITY_NORMAL: "一般",
    SEVERITY_MINOR: "轻微",
}
SEVERITY_DEFINITIONS: dict[str, str] = {
    SEVERITY_FATAL: "导致任务无法完成",
    SEVERITY_MAJOR: "对任务完成情况影响较大",
    SEVERITY_NORMAL: "降低了任务完成效率、影响表达意思的文案或视觉元素、存在更好的解决方案可提高任务完成效率",
    SEVERITY_MINOR: "不影响任务完成效率、不影响表达意思的文案或视觉元素、存在更好的解决方案可提高界面呈现效果",
}

# --- 矩阵单元键 ---
CELL_KEYS: tuple[str, ...] = ("core_fatal", "core_major", "core_normal", "core_minor",
                              "non_core_fatal", "non_core_major", "non_core_normal", "non_core_minor")
CELL_LABELS: dict[str, str] = {
    "core_fatal": "核心-致命",
    "core_major": "核心-严重",
    "core_normal": "核心-一般",
    "core_minor": "核心-轻微",
    "non_core_fatal": "非核心-致命",
    "non_core_major": "非核心-严重",
    "non_core_normal": "非核心-一般",
    "non_core_minor": "非核心-轻微",
}
CELL_ORDER: tuple[tuple[str, str], ...] = (
    (BUSINESS_CORE, SEVERITY_FATAL),
    (BUSINESS_CORE, SEVERITY_MAJOR),
    (BUSINESS_CORE, SEVERITY_NORMAL),
    (BUSINESS_CORE, SEVERITY_MINOR),
    (BUSINESS_NON_CORE, SEVERITY_FATAL),
    (BUSINESS_NON_CORE, SEVERITY_MAJOR),
    (BUSINESS_NON_CORE, SEVERITY_NORMAL),
    (BUSINESS_NON_CORE, SEVERITY_MINOR),
)


def cell_key(business_level: str, severity: str) -> str:
    """业务等级 + 问题等级 → 矩阵单元键。"""
    prefix = "core" if business_level == BUSINESS_CORE else "non_core"
    return f"{prefix}_{severity}"


# 业务比取值（4 组）
BUSINESS_RATIOS: tuple[str, ...] = ("9:1", "8:2", "7:3", "6:4")
# 问题比取值（5 组）
PROBLEM_RATIOS: tuple[str, ...] = ("6:3:2:1", "4:3:2:1", "7:5:3:1", "10:7:4:1", "7:5:1:0.5")

DEFAULT_BUSINESS_RATIO = "8:2"
DEFAULT_PROBLEM_RATIO = "7:5:3:1"


class SchemeSpec(NamedTuple):
    business_ratio: str
    problem_ratio: str
    values: tuple[str, ...]  # 8 个单元：核心 致/严/般/轻，非核心 致/严/般/轻


# 逐字取自 PRD V1.2 §8.3 评分矩阵
MATRIX: tuple[SchemeSpec, ...] = (
    SchemeSpec("9:1", "6:3:2:1", ("5.4", "2.7", "1.8", "0.9", "0.6", "0.3", "0.2", "0.1")),
    SchemeSpec("9:1", "4:3:2:1", ("3.6", "2.7", "1.8", "0.9", "0.4", "0.3", "0.2", "0.1")),
    SchemeSpec("9:1", "7:5:3:1", ("6.3", "4.5", "2.7", "0.9", "0.7", "0.5", "0.3", "0.1")),
    SchemeSpec("9:1", "10:7:4:1", ("9", "6.3", "3.6", "0.9", "1", "0.7", "0.4", "0.1")),
    SchemeSpec("9:1", "7:5:1:0.5", ("6.3", "4.5", "0.9", "0.45", "0.7", "0.5", "0.1", "0.05")),
    SchemeSpec("8:2", "6:3:2:1", ("4.8", "2.4", "1.6", "0.8", "1.2", "0.6", "0.4", "0.2")),
    SchemeSpec("8:2", "4:3:2:1", ("3.2", "2.4", "1.6", "0.8", "0.8", "0.6", "0.4", "0.2")),
    SchemeSpec("8:2", "7:5:3:1", ("5.6", "4", "2.4", "0.8", "1.4", "1", "0.6", "0.2")),
    SchemeSpec("8:2", "10:7:4:1", ("8", "5.6", "3.2", "0.8", "2", "1.4", "0.8", "0.2")),
    SchemeSpec("8:2", "7:5:1:0.5", ("5.6", "4", "0.8", "0.4", "1.4", "1", "0.2", "0.1")),
    SchemeSpec("7:3", "6:3:2:1", ("4.2", "2.1", "1.4", "0.7", "1.8", "0.9", "0.6", "0.3")),
    SchemeSpec("7:3", "4:3:2:1", ("2.8", "2.1", "1.4", "0.7", "1.2", "0.9", "0.6", "0.3")),
    SchemeSpec("7:3", "7:5:3:1", ("4.9", "3.5", "2.1", "0.7", "2.1", "1.5", "0.9", "0.3")),
    SchemeSpec("7:3", "10:7:4:1", ("7", "4.9", "2.8", "0.7", "3", "2.1", "1.2", "0.3")),
    SchemeSpec("7:3", "7:5:1:0.5", ("4.9", "3.5", "0.7", "0.35", "2.1", "1.5", "0.3", "0.15")),
    SchemeSpec("6:4", "6:3:2:1", ("3.6", "1.8", "1.2", "0.6", "2.4", "1.2", "0.8", "0.4")),
    SchemeSpec("6:4", "4:3:2:1", ("2.4", "1.8", "1.2", "0.6", "1.6", "1.2", "0.8", "0.4")),
    SchemeSpec("6:4", "7:5:3:1", ("4.2", "3", "1.8", "0.6", "2.8", "2", "1.2", "0.4")),
    SchemeSpec("6:4", "10:7:4:1", ("6", "4.2", "2.4", "0.6", "4", "2.8", "1.6", "0.4")),
    SchemeSpec("6:4", "7:5:1:0.5", ("4.2", "3", "0.6", "0.3", "2.8", "2", "0.4", "0.2")),
)

SCHEME_COUNT = len(MATRIX)
CELL_COUNT = SCHEME_COUNT * len(CELL_KEYS)

# 基准分与封 0
BASE_SCORE = Decimal("100")


def scheme_code(business_ratio: str, problem_ratio: str) -> str:
    """方案唯一编码，例如 ``8-2__7-5-3-1``。"""
    return f"{business_ratio.replace(':', '-')}__{problem_ratio.replace(':', '-')}"


def scheme_name(business_ratio: str, problem_ratio: str) -> str:
    return f"业务比 {business_ratio} / 问题比 {problem_ratio}"


DEFAULT_SCHEME_CODE = scheme_code(DEFAULT_BUSINESS_RATIO, DEFAULT_PROBLEM_RATIO)


def matrix_lookup() -> dict[tuple[str, str], dict[str, str]]:
    """``(业务比, 问题比) → {单元键: 值}``，供种子与自检使用。"""
    out: dict[tuple[str, str], dict[str, str]] = {}
    for spec in MATRIX:
        out[(spec.business_ratio, spec.problem_ratio)] = {
            key: value for key, value in zip(CELL_KEYS, spec.values, strict=True)
        }
    return out


def quantize(score: Decimal) -> Decimal:
    """展示口径：保留 1 位小数（四舍五入，ROUND_HALF_UP）。"""
    return score.quantize(Decimal("0.1"))


def format_score(score: Decimal | float | int | str | None) -> str:
    """分值统一 1 位小数字符串；``None`` 输出空串。"""
    if score is None:
        return ""
    return str(quantize(Decimal(str(score))))


def apply_clamp_zero(score: Decimal, clamp: bool) -> Decimal:
    """封 0 开关：默认**关闭**，开启时数学值仍原样保留（另存 raw）。"""
    if clamp and score < Decimal("0"):
        return Decimal("0")
    return score


def assert_matrix_frozen() -> None:
    """自检：160 单元、组合唯一、默认方案 8:2/7:5:3:1、9:1/7:5:3:1 四级值 6.3/4.5/2.7/0.9。"""
    assert SCHEME_COUNT == 20, f"方案数必须为 20，实际 {SCHEME_COUNT}"
    combos = {(s.business_ratio, s.problem_ratio) for s in MATRIX}
    assert len(combos) == 20, "存在重复的业务比/问题比组合"
    for spec in MATRIX:
        assert len(spec.values) == 8, f"{spec.business_ratio}/{spec.problem_ratio} 单元数必须为 8"
        for value in spec.values:
            assert Decimal(value) >= 0, f"矩阵单元不得为负：{spec} -> {value}"
    lookup = matrix_lookup()
    assert lookup[("9:1", "7:5:3:1")]["core_fatal"] == "6.3"
    assert lookup[("9:1", "7:5:3:1")]["core_major"] == "4.5"
    assert lookup[("9:1", "7:5:3:1")]["core_normal"] == "2.7"
    assert lookup[("9:1", "7:5:3:1")]["core_minor"] == "0.9"
    assert lookup[(DEFAULT_BUSINESS_RATIO, DEFAULT_PROBLEM_RATIO)]["core_normal"] == "2.4"
    assert lookup[(DEFAULT_BUSINESS_RATIO, DEFAULT_PROBLEM_RATIO)]["non_core_normal"] == "0.6"


assert_matrix_frozen()
