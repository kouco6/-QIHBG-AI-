/**
 * 前端领域常量（镜像 backend/app/domain/* 的冻结定义）。
 * 这些值用于标签、状态色与图标双编码；与后端保持单一事实来源。
 * 颜色严格引用 tokens.css 令牌，不在此写死十六进制（仅 token 变量名）。
 */

// ---------------------------------------------------------------------------
// 工作节点（13 节点 / 4 阶段）— backend/app/domain/nodes.py
// ---------------------------------------------------------------------------
export const STAGES = [
  { code: 'S1', name: '一、产品企划', order: 1 },
  { code: 'S2', name: '二、需求分析', order: 2 },
  { code: 'S3', name: '三、产品设计', order: 3 },
  { code: 'S4', name: '四、产品发布', order: 4 },
] as const

export type StageCode = (typeof STAGES)[number]['code']

export const NODE_SPECS: ReadonlyArray<{
  code: string
  order: number
  stage_code: StageCode
  name: string
  scope: string
  owner: string
  collaborators: string
  duration_days: number
  outputs: string
  artifact_kinds: string[]
  upstream_deps: string[]
  allow_not_applicable: boolean
  iteration_only: boolean
}> = [
  { code: 'N01', order: 1, stage_code: 'S1', name: '场景调研', scope: '新产品/新领域', owner: '体验人员', collaborators: '项目经理、企划人员', duration_days: 3, outputs: '场景调研报告', artifact_kinds: ['scene_research'], upstream_deps: [], allow_not_applicable: true, iteration_only: false },
  { code: 'N02', order: 2, stage_code: 'S1', name: '体验方案设计', scope: '新产品/新领域', owner: '体验人员', collaborators: '项目经理、企划人员', duration_days: 3, outputs: '体验方案', artifact_kinds: ['experience_plan', 'user_journey'], upstream_deps: ['N01'], allow_not_applicable: true, iteration_only: false },
  { code: 'N03', order: 3, stage_code: 'S2', name: '业务场景分析', scope: '新产品/新领域/迭代产品', owner: '体验人员', collaborators: '体验人员', duration_days: 3, outputs: '业务场景分析', artifact_kinds: ['business_scenario_analysis'], upstream_deps: ['N02'], allow_not_applicable: false, iteration_only: false },
  { code: 'N04', order: 4, stage_code: 'S2', name: '内部业务场景评审', scope: '新产品/新领域/迭代产品', owner: '体验人员', collaborators: '项目经理、体验人员、产品人员', duration_days: 2, outputs: '业务场景评审表', artifact_kinds: ['internal_scenario_review'], upstream_deps: ['N03'], allow_not_applicable: false, iteration_only: false },
  { code: 'N05', order: 5, stage_code: 'S2', name: '外部业务场景评审', scope: '新产品/新领域/迭代产品', owner: '体验人员', collaborators: '市场服务部、设计部、品管部', duration_days: 2, outputs: '业务场景评审表', artifact_kinds: ['external_scenario_review'], upstream_deps: ['N04'], allow_not_applicable: true, iteration_only: false },
  { code: 'N06', order: 6, stage_code: 'S2', name: '交互点设计', scope: '新产品/新领域/迭代产品', owner: '体验人员', collaborators: '产品人员、体验人员', duration_days: 3, outputs: '交互设计点报告', artifact_kinds: ['interaction_point_report'], upstream_deps: ['N04', 'N05'], allow_not_applicable: false, iteration_only: false },
  { code: 'N07', order: 7, stage_code: 'S3', name: '原型体验', scope: '新产品/新领域/迭代产品', owner: '体验人员', collaborators: '产品人员、体验人员', duration_days: 3, outputs: '原型体验报告', artifact_kinds: ['prototype_report'], upstream_deps: ['N06'], allow_not_applicable: false, iteration_only: false },
  { code: 'N08', order: 8, stage_code: 'S3', name: '脚本设计', scope: '新产品/新领域/迭代产品', owner: '体验人员', collaborators: '体验人员', duration_days: 3, outputs: '脚本设计', artifact_kinds: ['script_design'], upstream_deps: ['N06'], allow_not_applicable: false, iteration_only: false },
  { code: 'N09', order: 9, stage_code: 'S3', name: 'UI体验', scope: '新产品/新领域/迭代产品', owner: '体验人员', collaborators: '体验人员、UI人员', duration_days: 2, outputs: 'UI体验报告', artifact_kinds: ['ui_report'], upstream_deps: ['N06'], allow_not_applicable: false, iteration_only: false },
  { code: 'N10', order: 10, stage_code: 'S4', name: '体验优化迭代验收', scope: '仅迭代产品', owner: '体验人员', collaborators: '体验人员', duration_days: 2, outputs: '体验验收准入报告', artifact_kinds: ['acceptance_admission_report'], upstream_deps: ['N07', 'N09'], allow_not_applicable: true, iteration_only: true },
  { code: 'N11', order: 11, stage_code: 'S4', name: '体验走查', scope: '新产品/新领域/迭代产品', owner: '体验人员', collaborators: '体验人员', duration_days: 7, outputs: '产品自查表、发布体验报告', artifact_kinds: ['self_check_table', 'release_experience_report'], upstream_deps: ['N07', 'N09', 'N10'], allow_not_applicable: false, iteration_only: false },
  { code: 'N12', order: 12, stage_code: 'S4', name: '可用性测试/小组走查', scope: '新产品/新领域/迭代产品', owner: '体验人员', collaborators: '体验人员、可用性测试用户', duration_days: 7, outputs: '可用性测试报告/小组走查报告', artifact_kinds: ['usability_report'], upstream_deps: ['N08'], allow_not_applicable: true, iteration_only: false },
  { code: 'N13', order: 13, stage_code: 'S4', name: '发布体验评审', scope: '新产品/新领域/迭代产品', owner: '体验人员', collaborators: '项目经理、产品人员、开发人员、市场部、品管部、设计部、事业部', duration_days: 2, outputs: '体验问题回复终版、UEI分数测评表', artifact_kinds: ['issue_final_reply', 'uei_score_sheet'], upstream_deps: ['N11', 'N12'], allow_not_applicable: false, iteration_only: false },
] as const

export const NODE_BY_CODE: Record<string, (typeof NODE_SPECS)[number]> = Object.fromEntries(
  NODE_SPECS.map((n) => [n.code, n]),
)

export const NODE_STAGE_BY_CODE: Record<string, StageCode> = Object.fromEntries(
  NODE_SPECS.map((n) => [n.code, n.stage_code]),
)

export const PROJECT_TYPES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'new_product', label: '新产品' },
  { code: 'iteration', label: '迭代产品' },
]
export const PROJECT_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  PROJECT_TYPES.map((p) => [p.code, p.label]),
)

// ---------------------------------------------------------------------------
// 状态机（5 套）— backend/app/domain/states.py
// 状态色语义：灰未开始 / 蓝进行中 / 绿完成 / 橙待处理 / 红失败阻塞
// ---------------------------------------------------------------------------
export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export interface StatusMeta {
  label: string
  tone: StatusTone
  icon: string // 内联 SVG path 或字符图标（与色、文字三重编码，保证可访问性）
}

export const NODE_STATUSES: Record<string, StatusMeta> = {
  not_started: { label: '未开始', tone: 'neutral', icon: '◌' },
  in_progress: { label: '进行中', tone: 'info', icon: '►' },
  completed: { label: '已完成', tone: 'success', icon: '✓' },
  not_applicable: { label: '不适用', tone: 'neutral', icon: '–' },
}

export const ARTIFACT_STATUSES: Record<string, StatusMeta> = {
  draft: { label: '草稿', tone: 'neutral', icon: '✎' },
  submitted: { label: '已提交', tone: 'info', icon: '↑' },
  returned: { label: '已退回', tone: 'warning', icon: '↩' },
  confirmed: { label: '已确认', tone: 'success', icon: '✓' },
  not_applicable: { label: '不适用', tone: 'neutral', icon: '–' },
}

export const ISSUE_STATUSES: Record<string, StatusMeta> = {
  draft: { label: '草稿', tone: 'neutral', icon: '✎' },
  pending_confirm: { label: '待确认', tone: 'warning', icon: '?' },
  pending_reply: { label: '待回复', tone: 'warning', icon: '⏳' },
  in_progress: { label: '处理中', tone: 'info', icon: '⚙' },
  pending_acceptance: { label: '待验收', tone: 'warning', icon: '✦' },
  accepted: { label: '已通过', tone: 'success', icon: '✓' },
  rejected: { label: '已驳回', tone: 'danger', icon: '✕' },
  closed: { label: '已关闭', tone: 'success', icon: '✓' },
}

export const REVIEW_STATUSES: Record<string, StatusMeta> = {
  before: { label: '评审前', tone: 'neutral', icon: '①' },
  during: { label: '评审中', tone: 'info', icon: '②' },
  after: { label: '评审后', tone: 'warning', icon: '③' },
  archived: { label: '已归档', tone: 'success', icon: '✓' },
}

export const JOB_STATUSES: Record<string, StatusMeta> = {
  queued: { label: '排队中', tone: 'neutral', icon: '⏳' },
  running: { label: '执行中', tone: 'info', icon: '⚙' },
  succeeded: { label: '成功', tone: 'success', icon: '✓' },
  failed: { label: '失败', tone: 'danger', icon: '✕' },
  cancelled: { label: '已取消', tone: 'warning', icon: '⊘' },
}

export function statusMeta(map: Record<string, StatusMeta>, key: string): StatusMeta {
  return map[key] ?? { label: key || '未知', tone: 'neutral', icon: '?' }
}

// 节点迁移动作（用于看板按钮）— backend domain states.py NODE_TRANSITIONS
export const NODE_TRANSITIONS: ReadonlyArray<{ source: string; target: string; action: string; label: string; requires_reason: boolean }> = [
  { source: 'not_started', target: 'in_progress', action: 'start', label: '开始节点', requires_reason: false },
  { source: 'not_started', target: 'not_applicable', action: 'mark_na', label: '标记不适用', requires_reason: true },
  { source: 'in_progress', target: 'completed', action: 'complete', label: '完成节点', requires_reason: false },
  { source: 'in_progress', target: 'not_applicable', action: 'mark_na', label: '标记不适用', requires_reason: true },
  { source: 'completed', target: 'in_progress', action: 'reopen', label: '重新打开', requires_reason: true },
  { source: 'not_applicable', target: 'not_started', action: 'restore', label: '恢复为未开始', requires_reason: true },
]

// ---------------------------------------------------------------------------
// 评分矩阵（UEI）— backend/app/domain/scoring.py
// ---------------------------------------------------------------------------
export const BUSINESS_LEVELS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'core', label: '核心业务' },
  { code: 'non_core', label: '非核心业务' },
]
export const BUSINESS_LEVEL_LABELS: Record<string, string> = Object.fromEntries(
  BUSINESS_LEVELS.map((b) => [b.code, b.label]),
)

export const SEVERITY_LEVELS: ReadonlyArray<{ code: string; label: string; definition: string; tone: StatusTone }> = [
  { code: 'fatal', label: '致命', definition: '导致任务无法完成', tone: 'danger' },
  { code: 'major', label: '严重', definition: '对任务完成情况影响较大', tone: 'danger' },
  { code: 'normal', label: '一般', definition: '降低任务完成效率、影响表达意思的文案或视觉元素', tone: 'warning' },
  { code: 'minor', label: '轻微', definition: '不影响任务完成效率、不影响表达意思的文案或视觉元素', tone: 'neutral' },
]
export const SEVERITY_LABELS: Record<string, string> = Object.fromEntries(
  SEVERITY_LEVELS.map((s) => [s.code, s.label]),
)
export const SEVERITY_TONES: Record<string, StatusTone> = Object.fromEntries(
  SEVERITY_LEVELS.map((s) => [s.code, s.tone]),
)

export const CELL_KEYS = ['core_fatal', 'core_major', 'core_normal', 'core_minor', 'non_core_fatal', 'non_core_major', 'non_core_normal', 'non_core_minor'] as const
export const CELL_LABELS: Record<string, string> = {
  core_fatal: '核心-致命',
  core_major: '核心-严重',
  core_normal: '核心-一般',
  core_minor: '核心-轻微',
  non_core_fatal: '非核心-致命',
  non_core_major: '非核心-严重',
  non_core_normal: '非核心-一般',
  non_core_minor: '非核心-轻微',
}
export const BUSINESS_RATIOS = ['9:1', '8:2', '7:3', '6:4'] as const
export const PROBLEM_RATIOS = ['6:3:2:1', '4:3:2:1', '7:5:3:1', '10:7:4:1', '7:5:1:0.5'] as const
export const DEFAULT_BUSINESS_RATIO = '8:2'
export const DEFAULT_PROBLEM_RATIO = '7:5:3:1'

// 评分方案 8 类计数标签（DESIGN §6.2.2 UEI 预览：8类计数）
export const UEI_CATEGORY_LABELS: Record<string, string> = {
  core_fatal: '核心·致命',
  core_major: '核心·严重',
  core_normal: '核心·一般',
  core_minor: '核心·轻微',
  non_core_fatal: '非核心·致命',
  non_core_major: '非核心·严重',
  non_core_normal: '非核心·一般',
  non_core_minor: '非核心·轻微',
}

// ---------------------------------------------------------------------------
// BEI（事业部体验重视度指数）— backend/app/domain/bei.py
// ---------------------------------------------------------------------------
export interface BeiMetric {
  key: string
  dimension: string
  name: string
  unit: string
  direction: 'higher_better' | 'lower_better'
  full: string | null
  passing: string | null
  zero: string | null
  source_field: string
  scoring: boolean
}
export interface BeiDimension {
  code: string
  name: string
  weight: string
  metrics: string[]
}

export const BEI_DIMENSIONS: BeiDimension[] = [
  { code: 'D1', name: '响应及时性', weight: '0.20', metrics: ['response_rate', 'first_response_hours', 'overdue_unreplied'] },
  { code: 'D2', name: '问题闭环率', weight: '0.25', metrics: ['issue_close_rate', 'on_time_close_rate', 'overdue_backlog'] },
  { code: 'D3', name: '整改质量', weight: '0.20', metrics: ['retest_pass_rate', 'avg_retry_after_reject', 'repeat_issue_rate'] },
  { code: 'D4', name: '体验投入度', weight: '0.20', metrics: ['commitment_fulfill_rate', 'experience_adoption_rate', 'review_participation'] },
  { code: 'D5', name: '体验成效', weight: '0.15', metrics: ['uei_gain', 'critical_major_drop_rate', 'product_line_uei_contribution'] },
]
export const BEI_METRICS: BeiMetric[] = [
  { key: 'response_rate', dimension: 'D1', name: '问题回复率', unit: '%', direction: 'higher_better', full: '95', passing: '80', zero: '60', source_field: '问题·事业部回复及其时间戳', scoring: true },
  { key: 'first_response_hours', dimension: 'D1', name: '平均首次响应时长', unit: '小时', direction: 'lower_better', full: '8', passing: '48', zero: '120', source_field: '问题·事业部回复时间戳 − 问题登记时间', scoring: true },
  { key: 'overdue_unreplied', dimension: 'D1', name: '超期未回复数', unit: '条', direction: 'lower_better', full: '0', passing: '3', zero: '10', source_field: '问题·超期且无回复计数', scoring: true },
  { key: 'issue_close_rate', dimension: 'D2', name: '问题关闭率', unit: '%', direction: 'higher_better', full: '90', passing: '70', zero: '50', source_field: '问题状态流转', scoring: true },
  { key: 'on_time_close_rate', dimension: 'D2', name: '承诺版本内按期关闭率', unit: '%', direction: 'higher_better', full: '85', passing: '65', zero: '45', source_field: '承诺修改版本 vs 实际发布版本', scoring: true },
  { key: 'overdue_backlog', dimension: 'D2', name: '超期遗留数', unit: '条', direction: 'lower_better', full: '0', passing: '3', zero: '10', source_field: '承诺版本已发布而未关闭的问题数', scoring: true },
  { key: 'retest_pass_rate', dimension: 'D3', name: '复测验收通过率', unit: '%', direction: 'higher_better', full: '95', passing: '80', zero: '60', source_field: '问题验收记录', scoring: true },
  { key: 'avg_retry_after_reject', dimension: 'D3', name: '驳回后平均重试次数', unit: '次', direction: 'lower_better', full: '0.2', passing: '1.0', zero: '2.0', source_field: '问题·驳回次数与整改记录', scoring: true },
  { key: 'repeat_issue_rate', dimension: 'D3', name: '同类问题重复发生率', unit: '%', direction: 'lower_better', full: '5', passing: '15', zero: '30', source_field: '问题去重比对（模块＋二级指标）', scoring: true },
  { key: 'commitment_fulfill_rate', dimension: 'D4', name: '承诺版本兑现率', unit: '%', direction: 'higher_better', full: '95', passing: '80', zero: '60', source_field: '承诺修改版本 vs 实际发布版本', scoring: true },
  { key: 'experience_adoption_rate', dimension: 'D4', name: '体验需求采纳率', unit: '%', direction: 'higher_better', full: '70', passing: '50', zero: '30', source_field: '问题解决方案采纳比', scoring: true },
  { key: 'review_participation', dimension: 'D4', name: '评审参与记录（缺席次数）', unit: '次', direction: 'lower_better', full: '0', passing: '1', zero: '3', source_field: '评审部门签署（代录）', scoring: true },
  { key: 'uei_gain', dimension: 'D5', name: '版本 UEI 提升幅度', unit: '分', direction: 'higher_better', full: '5', passing: '0', zero: '-5', source_field: '评分快照对比', scoring: true },
  { key: 'critical_major_drop_rate', dimension: 'D5', name: '致命+严重问题下降率', unit: '%', direction: 'higher_better', full: '40', passing: '0', zero: '-20', source_field: '评分快照问题等级分布', scoring: true },
  { key: 'product_line_uei_contribution', dimension: 'D5', name: '产品线 UEI 贡献度', unit: '%', direction: 'higher_better', full: null, passing: null, zero: null, source_field: '该部门产品线 UEI 占其全域比重', scoring: false },
]
export const BEI_METRIC_BY_KEY: Record<string, BeiMetric> = Object.fromEntries(BEI_METRICS.map((m) => [m.key, m]))
export const BEI_DIMENSION_BY_CODE: Record<string, BeiDimension> = Object.fromEntries(BEI_DIMENSIONS.map((d) => [d.code, d]))

export const BEI_GRADES: ReadonlyArray<{ code: string; label: string; lower: number | null; upper: number | null; semantics: string }> = [
  { code: 'excellent', label: '卓越', lower: 85, upper: null, semantics: '主动推动体验改进，承诺必兑现' },
  { code: 'good', label: '良好', lower: 70, upper: 85, semantics: '响应与闭环良好，个别项待补' },
  { code: 'fair', label: '一般', lower: 55, upper: 70, semantics: '基本响应，闭环与整改质量不稳定' },
  { code: 'poor', label: '待改进', lower: null, upper: 55, semantics: '响应滞后或承诺兑现差' },
]
export const BEI_GRADE_LABELS: Record<string, string> = Object.fromEntries(BEI_GRADES.map((g) => [g.code, g.label]))
export const BEI_DISCLAIMER = '本指数仅反映事业部对产品体验的重视程度，不作为人事考核依据。'
export const BEI_MIN_ISSUES_FOR_SCORE = 5
export const BEI_MANUAL_WEIGHT_MAX = 0.2

// ---------------------------------------------------------------------------
// 字典类型（DESIGN §6.2.2 字典管理）
// ---------------------------------------------------------------------------
export const DICT_TYPES: ReadonlyArray<{ type: string; label: string; group: string }> = [
  { type: 'software', label: '软件指标', group: '体验字典' },
  { type: 'hardware', label: '硬件指标', group: '体验字典' },
  { type: 'hardware_single', label: '硬件单品维度', group: '体验字典' },
  { type: 'interactive', label: '交互控件', group: '体验字典' },
  { type: 'scoring_scheme', label: '评分方案', group: '体验字典' },
]
export const DICT_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  DICT_TYPES.map((d) => [d.type, d.label]),
)

// ---------------------------------------------------------------------------
// 发布体验评审（backend/app/schemas/reviews.py · REVIEW_KIND_LABELS）
// ---------------------------------------------------------------------------
export const REVIEW_KINDS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'release', label: '发布体验评审' },
  { code: 'internal_scenario', label: '内部业务场景评审' },
  { code: 'external_scenario', label: '外部业务场景评审' },
]
export const REVIEW_KIND_LABELS: Record<string, string> = Object.fromEntries(
  REVIEW_KINDS.map((r) => [r.code, r.label]),
)

// ---------------------------------------------------------------------------
// 可用性研究（backend/app/api/v1/usability.py）
// ---------------------------------------------------------------------------
export const STUDY_TYPES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'usability_test', label: '可用性测试' },
  { code: 'group_walkthrough', label: '小组走查' },
]
export const STUDY_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  STUDY_TYPES.map((s) => [s.code, s.label]),
)
export const STUDY_STATUSES: Record<string, StatusMeta> = {
  draft: { label: '草稿', tone: 'neutral', icon: '✎' },
  running: { label: '进行中', tone: 'info', icon: '⚙' },
  completed: { label: '已完成', tone: 'success', icon: '✓' },
  not_applicable: { label: '不适用', tone: 'neutral', icon: '–' },
}
export const SUS_QUESTIONS = [
  '我愿意频繁使用该产品',
  '该产品过于复杂',
  '该产品使用起来很简单',
  '我需要技术人员的支持才能使用该产品',
  '各个功能很好地集成在一起',
  '产品存在太多不一致的地方',
  '我想象大多数人会很快学会使用该产品',
  '该产品用起来很麻烦',
  '我对使用该产品很有信心',
  '在使用前我需要学习很多东西',
] as const

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------
export const PAGE_SIZE_OPTIONS = [20, 50, 100] as const
export const DEFAULT_PAGE_SIZE = 50
export const VIRTUAL_SCROLL_THRESHOLD = 200

// 时间显示：Asia/Shanghai · YYYY-MM-DD HH:mm
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 数值：UEI/BEI/扣分 1 位小数；计数为整数
export function fmt1(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const n = typeof value === 'string' ? Number(value) : value
  if (Number.isNaN(n)) return '—'
  return n.toFixed(1)
}
export function fmtInt(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const n = typeof value === 'string' ? Number(value) : value
  if (Number.isNaN(n)) return '—'
  return String(Math.round(n))
}

// 状态 tone → CSS 类（对应 tokens.css 状态色）
export const TONE_CLASS: Record<StatusTone, string> = {
  neutral: 'tone-neutral',
  info: 'tone-info',
  success: 'tone-success',
  warning: 'tone-warning',
  danger: 'tone-danger',
}
