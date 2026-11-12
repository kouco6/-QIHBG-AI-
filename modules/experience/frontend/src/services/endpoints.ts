/**
 * 前端 API 服务层：封装 backend/app/api/v1 全部已挂载的 REST 端点。
 * 设计要点：
 * - 不修改 services/api.ts 的核心契约（api.get/post/patch/del 已具备鉴权头与错误形状）。
 * - 所有响应类型按「只读呈现」定义，字段尽量可选，便于后端返回结构差异时优雅降级。
 * - BEI / divisions 端点由 T11 后端真实计算（预估 → 定榜），403/404 由页面按错误态或空态降级。
 */

import { api, type ApiError } from './api'

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') usp.set(k, String(v))
  }
  const s = usp.toString()
  return s ? `?${s}` : ''
}

export interface Page<T> {
  page: number
  page_size: number
  total: number
  items: T[]
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof Error && 'status' in e && 'code' in e
}

export interface ErrorMessage {
  message: string
  requestId?: string
  /** HTTP 状态码：五态边界据此区分 401 登录失效 / 403 无权限 / 其它错误 */
  status?: number
  /** 后端业务错误码，便于页面按 code 分支 */
  code?: string
}

export function errMessage(e: unknown): ErrorMessage {
  if (isApiError(e)) return { message: e.message || '请求失败', requestId: e.requestId, status: e.status, code: e.code }
  return { message: e instanceof Error ? e.message : '未知错误' }
}

// ---------------------------------------------------------------------------
// 后端字段 → 视图字段归一化
// 后端以业务语义命名（version_code / owner_text / display_uei …），视图层使用
// 页面既有字段名。统一在此适配，避免每个页面各自猜字段、也避免改动后端契约。
// ---------------------------------------------------------------------------
type Raw = Record<string, unknown>

const str = (v: unknown, fallback = ''): string => (v === null || v === undefined ? fallback : String(v))
const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : [])

function adaptProjectRow(r: Raw): ProjectRow {
  return {
    ...(r as unknown as ProjectRow),
    id: str(r.id),
    name: str(r.name),
    version_name: str(r.version_code) || str(r.version_name),
    type: str(r.project_type) || str(r.type),
    owner_name: str(r.owner_text) || str(r.owner_name),
    current_node_code: str(r.current_node_code),
    current_node_name: str(r.current_node_name),
    archived: r.status === 'archived' || Boolean(r.archived),
    system: r.system && typeof r.system === 'object' ? { id: String((r.system as Raw).id), name: String((r.system as Raw).name) } : null,
  }
}

function adaptProjectDetail(r: Raw): ProjectDetail {
  const nodes = arr(r.nodes)
  const summary = nodes.map((x) => ({
    code: str(x.code),
    name: str(x.name),
    status: str(x.status),
    order: num(x.node_order) ?? 0,
  }))
  const currentNode =
    nodes.find((x) => x.status === 'in_progress') ?? nodes.find((x) => x.status === 'not_started')
  return {
    ...adaptProjectRow(r),
    node_summary: summary.length ? summary : undefined,
    current_node_code: str(r.current_node_code) || str(currentNode?.code),
    current_node_name: str(r.current_node_name) || str(currentNode?.name),
    timeline: arr(r.audit_timeline).map((x) => ({
      at: str(x.created_at),
      actor: str(x.actor_name),
      action: str(x.action),
      summary: str(x.summary),
    })),
    risks_text: str(r.risks_text) || undefined,
  }
}

function adaptIssueRow(r: Raw): IssueRow {
  const metric = [str(r.metric_l1), str(r.metric_l2)].filter(Boolean).join(' / ')
  const sources = arr(r.source_labels).map((x) => str(x)).filter(Boolean)
  return {
    ...(r as unknown as IssueRow),
    id: str(r.id),
    uid: str(r.code) || str(r.uid),
    description: str(r.description),
    project_name: str(r.project_name),
    version_name: str(r.version_code) || str(r.version_name),
    business_level: str(r.business_level),
    severity: str(r.severity),
    metric_name: metric || str(r.metric_name) || undefined,
    owner_name: str(r.owner_text) || str(r.owner_name),
    source: sources.join('、') || str(r.source) || undefined,
  }
}

function adaptIssueDetail(r: Raw): IssueDetail {
  const proxy = arr(r.proxy_records).find((x) => x.field_key === 'division_reply')
  const reply = str(r.division_reply)
  const acceptances = arr(r.acceptances)
  const first = acceptances[0]
  return {
    ...adaptIssueRow(r),
    classification: {
      business_level: str(r.business_level),
      severity: str(r.severity),
      metric: str(r.metric_l1),
      category: str(r.issue_type),
    },
    replies: reply
      ? [
          {
            id: 'division_reply',
            content: reply,
            at: str(r.first_replied_at),
            provider_name: str(r.division_name),
            actual_provider: str(proxy?.actual_provider) || undefined,
          },
        ]
      : [],
    commitments: str(r.committed_version)
      ? [{ id: 'commitment', version: str(r.committed_version), content: str(r.solution) }]
      : [],
    acceptance: first
      ? { evidence: str(first.evidence), conclusion: str(first.conclusion) }
      : undefined,
    matrix_preview: r.matrix_preview
      ? {
          cell: str((r.matrix_preview as Raw).cell_label),
          deduction: num((r.matrix_preview as Raw).deduction),
        }
      : undefined,
    timeline: arr(r.timeline).map((x) => ({
      at: str(x.created_at) || str(x.at),
      actor: str(x.actor_name) || str(x.actor),
      action: str(x.action),
      summary: str(x.summary) || str(x.detail),
    })),
  }
}

function adaptReviewRow(r: Raw): ReviewRow {
  return {
    ...(r as unknown as ReviewRow),
    id: str(r.id),
    version_name: str(r.version_code) || str(r.version_name),
    dispute_count: num(r.open_dispute_count) ?? num(r.dispute_count),
    status: str(r.stage) || str(r.status),
  }
}

function adaptReviewDetail(r: Raw): ReviewDetail {
  const tabs = (r.tabs ?? {}) as Raw
  const during = (tabs.during ?? {}) as Raw
  return {
    ...adaptReviewRow(r),
    before: (tabs.before as Record<string, unknown>) ?? {},
    during: {
      disputes: arr(during.decisions).map((x) => ({
        id: str(x.id),
        topic: str(x.dispute) || str(x.discussion),
        status: str(x.status_label) || str(x.status),
        decision: str(x.decision),
      })),
      plan: (during.plan as Record<string, unknown>) ?? undefined,
    },
    after: (tabs.after as Record<string, unknown>) ?? {},
    signatures: arr((r.signatures as Raw | undefined)?.items).map((x) => ({
      dept: str(x.department),
      signed_by: str(x.principal),
      actual_provider: str(x.actual_provider),
      at: str(x.proxy_at) || str(x.created_at),
    })),
  }
}

function adaptPreview(r: Raw): ScorePreview {
  const scheme = (r.scheme ?? {}) as Raw
  const counts = (r.cell_counts ?? {}) as Record<string, number>
  const labels = (r.cell_labels ?? {}) as Record<string, string>
  return {
    scheme_version: str(scheme.code) || str(r.scheme_version),
    scheme_name: str(scheme.name) || str(r.scheme_name),
    counts_by_category: counts,
    matrix_hits: arr(r.issues).map((x) => ({
      issue_id: str(x.issue_id),
      description: str(x.description),
      business_level: str(x.business_level),
      severity: str(x.severity),
      cell: labels[str(x.cell_key)] ?? str(x.cell_key),
      deduction: num(x.deduction) ?? 0,
    })),
    core_deduction: num(r.core_deduction),
    non_core_deduction: num(r.non_core_deduction),
    total_deduction: num(r.total_deduction),
    uei: num(r.display_uei) ?? num(r.uei),
    base_score: 100,
  }
}

function adaptSnapshot(r: Raw): SnapshotDetail {
  return {
    ...(r as unknown as SnapshotDetail),
    id: str(r.id),
    project_id: str(r.project_id),
    scheme_version: str(r.scheme_code) || str(r.scheme_version),
    project_name: str(r.project_name),
    product_name: str(r.product_name),
    version_name: str(r.version_code) || str(r.version_name),
    uei: num(r.display_uei) ?? num(r.uei),
    total_deduction: num(r.total_deduction),
    created_at: str(r.snapshot_at) || str(r.created_at),
    issue_count: num(r.issue_count),
    issues: arr(r.issues).map((x) => ({
      issue_id: str(x.issue_id),
      description: str(x.description_digest) || str(x.description),
      business_level: str(x.business_level),
      severity: str(x.severity),
      cell: str(x.cell_label) || str(x.cell_key),
      deduction: num(x.deduction) ?? 0,
    })),
  }
}

function adaptLibraryEntry(r: Raw): LibraryEntry {
  const period = str(r.period)
  const version = str(r.version_code)
  return {
    ...(r as unknown as LibraryEntry),
    id: str(r.id),
    level: str(r.level),
    object: str(r.object_name) || str(r.object),
    period_version: period || version || undefined,
    score: num(r.display_score) ?? num(r.score),
    caliber: str(r.caliber),
    scheme_version: str(r.scheme_ref) || str(r.scheme_version),
    threshold_version: str(r.threshold_ref) || str(r.threshold_version),
    snapshot_at: str(r.snapshot_at),
    snapshot_id: str(r.source_snapshot_id) || str(r.snapshot_id),
  }
}

function adaptSystemRow(r: Raw): SystemRow {
  return {
    ...(r as unknown as SystemRow),
    id: str(r.id),
    code: str(r.code),
    name: str(r.name),
    owner_text: str(r.owner_text),
    division_id: r.division_id === null ? null : str(r.division_id),
    status: str(r.status),
    status_label: str(r.status_label),
    scheme_id: str(r.scheme_id),
    scheme_version: num(r.scheme_version),
    scheme_code: str(r.scheme_code),
    scheme_name: str(r.scheme_name),
    note: str(r.note),
    member_count: num(r.member_count),
    effective_project_count: num(r.effective_project_count),
    updated_at: str(r.updated_at),
    updated_by_name: str(r.updated_by_name),
  }
}

function adaptSystemMember(x: Raw): SystemMember {
  return {
    id: str(x.id),
    system_id: str(x.system_id),
    project_id: str(x.project_id),
    project_name: str(x.project_name),
    code: str(x.code),
    version_code: str(x.version_code),
    weight: str(x.weight),
    project_type: str(x.project_type),
    owner_text: str(x.owner_text),
    status: str(x.status),
    current_node_name: str(x.current_node_name),
  }
}

function adaptSnapshotSummary(r: Raw): SystemSnapshotSummary {
  return {
    id: str(r.id),
    system_id: str(r.system_id),
    system_code: str(r.system_code),
    system_name: str(r.system_name),
    scheme_code: str(r.scheme_code),
    selection_mode: str(r.selection_mode),
    filters: (r.filters as Record<string, unknown>) ?? undefined,
    source_snapshot_count: num(r.source_snapshot_count),
    effective_project_count: num(r.effective_project_count),
    outlier_project_count: num(r.outlier_project_count),
    raw_issue_count: num(r.raw_issue_count),
    deduped_issue_count: num(r.deduped_issue_count),
    core_deduction: str(r.core_deduction),
    non_core_deduction: str(r.non_core_deduction),
    total_deduction: str(r.total_deduction),
    authoritative_uei: str(r.authoritative_uei),
    weighted_average_uei: str(r.weighted_average_uei),
    bucket_uei: str(r.bucket_uei),
    sample_sufficient: Boolean(r.sample_sufficient),
    cell_counts: (r.cell_counts as Record<string, number>) ?? undefined,
    created_by_name: str(r.created_by_name),
    snapshot_at: r.snapshot_at === null ? null : str(r.snapshot_at),
  }
}

function adaptSystemDetail(r: Raw): SystemDetail {
  return {
    ...adaptSystemRow(r),
    members: arr(r.members).map(adaptSystemMember),
    active_members: arr(r.active_members).map(adaptSystemMember),
    alerts: arr(r.alerts).map((x) => ({
      level: str(x.level),
      kind: str(x.kind),
      message: str(x.message),
      project_name: str(x.project_name),
      system_name: str(x.system_name),
    })),
    snapshot_history: arr(r.snapshot_history).map(adaptSnapshotSummary),
  }
}

function adaptL2Snapshot(r: Raw): L2SnapshotDetail {
  const aux = (r.auxiliary ?? {}) as Raw
  return {
    ...adaptSnapshotSummary(r),
    id: str(r.id),
    scheme_code: str(r.scheme_code),
    selection_mode: str(r.selection_mode),
    sources: arr(r.sources).map((x) => ({
      project_id: str(x.project_id),
      project_name: str(x.project_name),
      version_code: str(x.version_code),
      weight: str(x.weight),
      l1_snapshot_id: str(x.l1_snapshot_id),
      l1_scheme_code: str(x.l1_scheme_code),
      l1_uei: str(x.l1_uei),
      project_uei: str(x.project_uei),
      is_out_of_scope: Boolean(x.is_out_of_scope),
      issue_count: num(x.issue_count) ?? 0,
    })),
    issues: arr(r.issues).map((x) => ({
      issue_id: str(x.issue_id),
      issue_code: str(x.issue_code),
      business_level: str(x.business_level),
      severity: str(x.severity),
      cell_key: str(x.cell_key),
      deduction: str(x.deduction),
      project_id: str(x.project_id),
      project_name: str(x.project_name),
    })),
    auxiliary: {
      weighted_average_uei: str(aux.weighted_average_uei),
      bucket_uei: str(aux.bucket_uei),
      caliber_weighted: str(aux.caliber_weighted),
      caliber_bucket: str(aux.caliber_bucket),
    },
    cell_counts: (r.cell_counts as Record<string, number>) ?? undefined,
    sample_gap: str(r.sample_gap),
    caliber_note: str(r.caliber_note),
    immutable: r.immutable === false ? false : true,
  }
}

function currentQuarter(): string {
  const now = new Date()
  return `${now.getFullYear()}Q${Math.floor(now.getMonth() / 3) + 1}`
}

function adaptBeiList(r: Raw, period: string): { items: BeiQuarter[] } {
  const items = arr(r.items).map((x) => ({
    id: str(x.division_id),
    name: str(x.division_name),
    sample_status: x.sample_sufficient === false ? '样本不足' : '样本充足',
    auto_score: num(x.auto_score),
    manual_score: num(x.manual_score),
    final_score: num(x.combined_score),
    grade: str(x.grade_label) || str(x.grade) || undefined,
    ranking_status: str(x.status_label) || str(x.status),
  }))
  return { items: items.length ? [{ quarter: str(r.period) || period, divisions: items }] : [] }
}

function adaptBeiDetail(r: Raw): BeiDetail {
  const metrics = arr(r.metrics)
  return {
    division_id: str(r.division_id),
    division_name: str(r.division_name) || undefined,
    quarter: str(r.period),
    dimensions: arr(r.dimensions).map((d) => {
      const code = str(d.code)
      return {
        code,
        name: str(d.name),
        weight: str(d.rescaled_weight) || str(d.weight),
        metric_values: metrics
          .filter((m) => str(m.dimension) === code)
          .map((m) => ({
            key: str(m.metric_key),
            raw: num(m.raw_value),
            normalized: m.has_data === false ? null : num(m.normalized),
            scoring: Boolean(m.is_scoring),
          })),
        dimension_score: num(d.score),
      }
    }),
    manual_score: num(r.manual_score),
    manual_reason: str(r.manual_reason) || undefined,
    final_score: num(r.combined_score),
    grade: str(r.grade_label) || str(r.grade) || null,
    disclaimer: str(r.disclaimer) || undefined,
  }
}


// ===========================================================================
// 项目 / 产品 / 版本 / 事业部 / 节点
// ===========================================================================
export interface ProjectRow {
  id: string
  name: string
  product_name?: string
  product_id?: string
  system?: { id: string; name: string } | null
  version_name?: string
  version_id?: string
  type?: string
  owner_name?: string
  division_name?: string
  current_node_code?: string
  current_node_name?: string
  status?: string
  updated_by_name?: string
  updated_at?: string
  archived?: boolean
}
export interface ProjectDetail extends ProjectRow {
  members_text?: string
  risks_text?: string
  node_summary?: Array<{ code: string; name: string; status: string; order: number }>
  timeline?: Array<{ at: string; actor: string; action: string; summary: string }>
  system?: { id: string; name: string } | null
}

export const projectsApi = {
  list: (params: Record<string, string | number | undefined> = {}) => {
    const { q, type, ...rest } = params
    return api
      .get<Page<Raw>>(`/projects${qs({ ...rest, keyword: q, project_type: type })}`)
      .then((p) => ({ ...p, items: p.items.map(adaptProjectRow) }))
  },
  get: (id: string) => api.get<Raw>(`/projects/${id}`).then(adaptProjectDetail),
  create: (body: Record<string, unknown>) => api.post<Raw>(`/projects`, body).then(adaptProjectDetail),
  patch: (id: string, body: Record<string, unknown>) => api.patch<Raw>(`/projects/${id}`, body).then(adaptProjectDetail),
  archive: (id: string) => api.post<Raw>(`/projects/${id}/archive`).then(adaptProjectDetail),
  batchArchive: (ids: string[]) => api.post<{ archived: number }>(`/projects/batch-archive`, { ids }),
  board: (id: string) => api.get<{ stages: Array<{ code: string; name: string; nodes: NodeCard[] }> }>(`/projects/${id}/board`),
  submitCoreBusiness: (id: string, body: Record<string, unknown>) => api.post<Raw>(`/projects/${id}/core-business`, body).then(adaptProjectDetail),
  nodes: (id: string) => api.get<{ items: NodeDetail[] }>(`/projects/${id}/nodes`),
}

export interface NodeCard {
  id: string
  code: string
  name: string
  status: string
  order: number
  stage_code: string
  duration_days?: number
  blocked_reason?: string | null
  artifact_count?: number
  artifact_confirmed?: boolean
}
export interface NodeDetail {
  id: string
  code: string
  name: string
  status: string
  order: number
  stage_code: string
  scenario?: string
  inputs?: string
  steps?: string[] | string
  outputs?: string
  completion_condition?: string
  completion_conditions?: string[]
  issue_stats?: { total?: number; by_status?: Record<string, number> }
  allow_not_applicable?: boolean
  upstream_deps?: string[]
  artifact_kinds?: string[]
  artifacts?: Array<{ id: string; kind: string; title: string; status: string; status_label?: string }>
  artifact_summary?: Array<{
    artifact_id: string | null
    kind: string
    template_name: string
    status: string
    status_label: string
  }>
  issues?: Array<{ id: string; description: string; status: string }>
  history?: Array<{ at: string; actor: string; action: string }>
}
export const nodesApi = {
  metaSpecs: () => api.get<{ stages: Array<{ code: string; name: string }>; nodes: NodeDetail[] }>(`/workflow-nodes/meta/specs`),
  get: (nodeId: string) =>
    api.get<Raw>(`/workflow-nodes/${nodeId}`).then((r) => {
      const scene = (r.scene_explanation ?? {}) as Raw
      return {
        ...(r as unknown as NodeDetail),
        id: str(r.id),
        code: str(r.code),
        name: str(r.name),
        status: str(r.status),
        scenario: str(scene.scope) || str(r.scenario),
        steps: Array.isArray(r.steps) ? (r.steps as string[]) : str(r.steps),
        history: arr(r.history).map((h) => ({
          at: str(h.created_at),
          actor: str(h.actor_name),
          action: str(h.action_label) || str(h.action),
        })),
      }
    }),
  transition: (nodeId: string, body: { action: string; target: string; reason?: string }) =>
    api.post<NodeDetail>(`/workflow-nodes/${nodeId}/transition`, body),
}

export const divisionsApi = {
  list: (params: Record<string, string | number | undefined> = {}) => api.get<Page<{ id: string; name: string }>>(`/divisions${qs(params)}`),
}

// ===========================================================================
// 产物
// ===========================================================================
export interface ArtifactRow {
  id: string
  kind: string
  title?: string
  project_id?: string
  project_name?: string
  node_code?: string
  node_name?: string
  status: string
  owner_name?: string
  updated_at?: string
}
export interface ArtifactDetail extends ArtifactRow {
  collaborators_text?: string
  fields?: Array<{ key: string; label: string; group: string; required?: boolean; value: unknown; type?: string; columns?: string[] }>
  field_groups?: Array<{ group: string; fields: Array<{ key: string; label: string; required?: boolean; value: unknown; type?: string; columns?: string[] }> }>
  issue_refs?: Array<{ id: string; description: string }>
  current_version?: number
  status_note?: string
  template?: { kind: string; title: string; groups: Array<{ group: string; fields: Array<{ key: string; label: string; required?: boolean; type?: string }> }> }
  attachments?: Array<{ id: string; name: string }>
}
export interface ArtifactVersion { version_no: number; created_by_name?: string; created_at?: string; status?: string; note?: string }
export interface FieldDiff { field: string; label?: string; from: unknown; to: unknown; changed: boolean }

/**
 * 产物详情归一化。
 *
 * 后端返回 `template.fields`（字段定义平铺数组，可能带 group）与
 * `current_version.payload`（字段值），两者分离；编辑器按
 * `field_groups[].fields[].value` 消费。此处合并，否则打开/刷新编辑器时字段值全为空。
 * 同时兼容 `template.groups` 形态。
 */
function artifactGroups(tpl: Raw | null): Array<{
  group: string
  fields: Array<{ key: string; label: string; required?: boolean; type?: string; columns?: string[] }>
}> {
  if (!tpl) return []
  const norm = (f: Raw) => ({
    key: str(f.key),
    label: str(f.label) || str(f.key),
    required: Boolean(f.required),
    type: str(f.type) || undefined,
    // 表格 / 勾选式字段的列名：编辑器据此渲染行单元格
    columns: Array.isArray(f.columns) ? (f.columns as unknown[]).map((c) => String(c)) : undefined,
  })

  const grouped = Array.isArray(tpl.groups) ? (tpl.groups as Raw[]) : []
  if (grouped.length) {
    return grouped
      .map((g) => ({
        group: str(g.group) || '内容',
        fields: (Array.isArray(g.fields) ? (g.fields as Raw[]) : []).map(norm),
      }))
      .filter((g) => g.fields.length > 0)
  }

  const flat = Array.isArray(tpl.fields) ? (tpl.fields as Raw[]) : []
  const bucket = new Map<string, Array<{ key: string; label: string; required?: boolean; type?: string; columns?: string[] }>>()
  for (const f of flat) {
    const name = str(f.group) || '内容'
    if (!bucket.has(name)) bucket.set(name, [])
    bucket.get(name)?.push(norm(f))
  }
  return [...bucket.entries()].map(([group, fields]) => ({ group, fields }))
}

function adaptArtifactDetail(raw: Raw): ArtifactDetail {
  const base = raw as unknown as ArtifactDetail
  const cv = raw.current_version
  const version = cv && typeof cv === 'object' ? (cv as Raw) : null
  const payload =
    version?.payload && typeof version.payload === 'object' ? (version.payload as Record<string, unknown>) : {}
  const tpl = raw.template && typeof raw.template === 'object' ? (raw.template as Raw) : null

  const groups = artifactGroups(tpl).map((g) => ({
    group: g.group,
    fields: g.fields.map((f) => ({ ...f, value: payload[f.key] ?? '' })),
  }))

  return {
    ...base,
    current_version: version && typeof version.version_no === 'number' ? Number(version.version_no) : undefined,
    field_groups: groups,
    fields: groups.flatMap((g) => g.fields.map((f) => ({ ...f, group: g.group }))),
    collaborators_text: base.collaborators_text ?? '',
  }
}

export const artifactsApi = {
  list: (params: Record<string, string | number | undefined> = {}) => api.get<Page<ArtifactRow>>(`/artifacts${qs(params)}`),
  // 按节点补建缺失产物：node_id 与 node_code 二选一
  create: (body: Record<string, unknown>) => api.post<ArtifactRow>(`/artifacts`, body),
  get: (id: string) => api.get<Raw>(`/artifacts/${id}`).then(adaptArtifactDetail),
  patch: (id: string, body: Record<string, unknown>) => api.patch<ArtifactDetail>(`/artifacts/${id}`, body),
  saveDraft: (id: string, body: Record<string, unknown>) => api.put<{ saved_at: string; version_no?: number }>(`/artifacts/${id}/draft`, body),
  // 后端把请求体声明为必填模型（字段均有默认值），无 body 会 422，故显式传空对象
  submit: (id: string) => api.post<ArtifactDetail>(`/artifacts/${id}/submit`, {}),
  confirm: (id: string) => api.post<ArtifactDetail>(`/artifacts/${id}/confirm`),
  returnArtifact: (id: string, reason: string) => api.post<ArtifactDetail>(`/artifacts/${id}/return`, { reason }),
  resume: (id: string, body: Record<string, unknown> = {}) => api.post<ArtifactDetail>(`/artifacts/${id}/resume`, body),
  markNa: (id: string, reason: string) => api.post<ArtifactDetail>(`/artifacts/${id}/mark-na`, { reason }),
  versions: (id: string) => api.get<ArtifactVersion[]>(`/artifacts/${id}/versions`),
  version: (id: string, v: number) => api.get<ArtifactVersion & { fields?: Record<string, unknown> }>(`/artifacts/${id}/versions/${v}`),
  diff: (id: string, from: number, to: number) => api.get<FieldDiff[]>(`/artifacts/${id}/diff?from=${from}&to=${to}`),
  setIssueRefs: (id: string, issueIds: string[]) => api.post<ArtifactVersion & { fields?: Record<string, unknown> }>(`/artifacts/${id}/issue-refs`, { issue_ids: issueIds }),
  templates: () => api.get<Array<{ kind: string; title: string }>>(`/artifacts/templates`),
}

// ===========================================================================
// 问题
// ===========================================================================
export interface IssueRow {
  id: string
  uid?: string
  description: string
  product_name?: string
  project_name?: string
  version_name?: string
  division_name?: string
  business_level?: string
  severity?: string
  metric_name?: string
  status: string
  owner_name?: string
  source?: string
  updated_at?: string
}
export interface IssueDetail extends IssueRow {
  classification?: { business_level?: string; severity?: string; metric?: string; category?: string }
  source_artifact?: { id: string; title: string; kind: string }
  replies?: Array<{ id: string; provider_name?: string; content: string; at?: string; actual_provider?: string }>
  commitments?: Array<{ id: string; version: string; content: string }>
  timeline?: Array<{ at: string; actor: string; action: string; summary: string }>
  acceptance?: { evidence?: string; conclusion?: string }
  matrix_preview?: { cell?: string; deduction?: number }
  source_refs?: Array<{ id: string; artifact_id: string; note?: string }>
}
export interface IssueBatchResult { scope_count: number; affected: number; preview?: boolean; action?: string }

export const issuesApi = {
  list: (params: Record<string, string | number | undefined> = {}) => {
    const { q, ...rest } = params
    return api
      .get<Page<Raw>>(`/issues${qs({ ...rest, keyword: q })}`)
      .then((p) => ({ ...p, items: p.items.map(adaptIssueRow) }))
  },
  get: (id: string) => api.get<Raw>(`/issues/${id}`).then(adaptIssueDetail),
  create: (body: Record<string, unknown>) => api.post<Raw>(`/issues`, body).then(adaptIssueDetail),
  patch: (id: string, body: Record<string, unknown>) => api.patch<Raw>(`/issues/${id}`, body).then(adaptIssueDetail),
  transition: (id: string, body: { action: string; target: string; reason?: string }) =>
    api.post<Raw>(`/issues/${id}/transition`, body).then(adaptIssueDetail),
  batch: (body: { ids: string[]; action: string; business_level?: string; severity?: string; preview?: boolean; evidence?: string }) => {
    const actionMap: Record<string, string> = { 改等级: 'set_level', 同步: 'sync', 验收: 'accept' }
    const action = actionMap[body.action] ?? body.action
    const payload: Record<string, string> = {}
    if (body.business_level) payload.business_level = body.business_level
    if (body.severity) payload.severity = body.severity
    if (body.evidence) payload.evidence = body.evidence
    return api
      .post<Raw>(`/issues/batch`, {
        issue_ids: body.ids,
        action,
        payload,
        dry_run: Boolean(body.preview),
      })
      .then((r) => ({
        scope_count: num((r.scope as Raw | undefined)?.count) ?? body.ids.length,
        affected: num(r.affected) ?? 0,
        preview: Boolean(r.dry_run),
        action,
      }))
  },
  addRef: (id: string, body: { artifact_id: string; note?: string }) => api.post<Raw>(`/issues/${id}/refs`, body).then(adaptIssueDetail),
  remove: (id: string) => api.del<{ ok: boolean }>(`/issues/${id}`),
}

// ===========================================================================
// 评审
// ===========================================================================
export interface ReviewRow { id: string; project_name?: string; version_name?: string; stage?: string; conclusion?: string; dispute_count?: number; reviewed_at?: string; updated_at?: string; status?: string }
export interface ReviewDetail extends ReviewRow {
  before?: Record<string, unknown>
  during?: { disputes: Array<{ id: string; topic: string; status: string; decision?: string }>; plan?: Record<string, unknown> }
  after?: Record<string, unknown>
  signatures?: Array<{ dept: string; signed_by?: string; actual_provider?: string; at?: string }>
}

export const reviewsApi = {
  list: (params: Record<string, string | number | undefined> = {}) =>
    api.get<Page<Raw>>(`/reviews${qs(params)}`).then((p) => ({ ...p, items: p.items.map(adaptReviewRow) })),
  get: (id: string) => api.get<Raw>(`/reviews/${id}`).then(adaptReviewDetail),
  create: (body: Record<string, unknown>) => api.post<Raw>(`/reviews`, body).then(adaptReviewDetail),
  transition: (id: string, body: { action: string; target: string; reason?: string; archive_note?: string }) =>
    api.post<Raw>(`/reviews/${id}/transition`, body).then(adaptReviewDetail),
  addDecision: (id: string, body: { topic: string }) => api.post<Raw>(`/reviews/${id}/decisions`, body).then(adaptReviewDetail),
  patchDecision: (id: string, decisionId: string, body: { status: string; decision: string }) =>
    api.patch<Raw>(`/reviews/${id}/decisions/${decisionId}`, body).then(adaptReviewDetail),
  putSignatures: (id: string, body: { signatures: Array<{ dept: string; actual_provider: string; signed_by: string }> }) =>
    api.put<Raw>(`/reviews/${id}/signatures`, body).then(adaptReviewDetail),
}

// ===========================================================================
// 评分方案 / UEI 预览 / L1 快照
// ===========================================================================
export interface SchemeRow { id: string; code: string; name: string; business_ratio: string; problem_ratio: string; is_default?: boolean; is_active?: boolean; status?: string; ref_count?: number }
export interface ScorePreview {
  scheme_version?: string
  scheme_name?: string
  counts_by_category?: Record<string, number>
  matrix_hits?: Array<{ issue_id: string; description: string; business_level: string; severity: string; cell: string; deduction: number }>
  core_deduction?: number
  non_core_deduction?: number
  total_deduction?: number
  uei?: number
  base_score?: number
}
export interface SnapshotRow { id: string; scheme_version?: string; product_name?: string; project_name?: string; version_name?: string; uei?: number; total_deduction?: number; created_at?: string; issue_count?: number }
export interface SnapshotDetail extends SnapshotRow {
  project_id?: string
  issues?: Array<{ issue_id: string; description: string; business_level: string; severity: string; cell: string; deduction: number }>
  audit?: Record<string, unknown>
}

export const scoringApi = {
  listSchemes: (params: Record<string, string | number | undefined> = {}) => api.get<{ items: SchemeRow[] }>(`/scoring-schemes${qs(params)}`),
  getScheme: (id: string) => api.get<{ id: string; code: string; name: string; business_ratio: string; problem_ratio: string; is_default?: boolean; cells: Array<{ key: string; value: number }> }>(`/scoring-schemes/${id}`),
  createScheme: (body: Record<string, unknown>) => api.post<SchemeRow>(`/scoring-schemes`, body),
  patchScheme: (id: string, body: Record<string, unknown>) => api.patch<SchemeRow>(`/scoring-schemes/${id}`, body),
  setDefault: (id: string) => api.post<SchemeRow>(`/scoring-schemes/${id}/set-default`),
  disable: (id: string) => api.post<SchemeRow>(`/scoring-schemes/${id}/disable`),
  preview: (projectId: string, params: Record<string, string | number | undefined> = {}) =>
    api.get<Raw>(`/scores/preview?project_id=${projectId}${qs(params)}`).then(adaptPreview),
  createSnapshot: (projectId: string, body: Record<string, unknown>) =>
    api.post<Raw>(`/project-score-snapshots`, { project_id: projectId, ...body }).then(adaptSnapshot),
  listSnapshots: (params: Record<string, string | number | undefined> = {}) =>
    api.get<Page<Raw>>(`/project-score-snapshots${qs(params)}`).then((p) => ({ ...p, items: p.items.map(adaptSnapshot) })),
  getSnapshot: (id: string) => api.get<Raw>(`/project-score-snapshots/${id}`).then(adaptSnapshot),
}

// ===========================================================================
// 可用性研究（usability-studies）
// ===========================================================================
export interface StudyRow { id: string; uid?: string; name: string; project_name?: string; version_name?: string; study_type?: string; participant_count?: number; task_count?: number; status?: string; updated_at?: string }
export interface StudyDetail extends StudyRow {
  participants?: Array<{ id: string; name: string; satisfaction?: number }>
  tasks?: Array<{ id: string; name: string }>
  progress?: Record<string, unknown>
  report?: { generated_at?: string; path?: string }
  stats?: Record<string, unknown>
}
export const usabilityApi = {
  list: (params: Record<string, string | number | undefined> = {}) =>
    api.get<Page<Raw>>(`/usability-studies${qs(params)}`).then((p) => ({
      ...p,
      items: p.items.map((x) => ({
        ...(x as unknown as StudyRow),
        id: str(x.id),
        name: str(x.name),
        version_name: str(x.version_code) || str(x.version_name),
        study_type: str(x.study_kind_label) || str(x.study_type),
      })),
    })),
  get: (id: string) =>
    api.get<Raw>(`/usability-studies/${id}`).then((x) => ({
      ...(x as unknown as StudyDetail),
      id: str(x.id),
      name: str(x.name),
      version_name: str(x.version_code) || str(x.version_name),
      study_type: str(x.study_kind_label) || str(x.study_type),
      stats: (x.stats as Record<string, unknown>) ?? undefined,
    })),
  create: (body: Record<string, unknown>) => api.post<StudyDetail>(`/usability-studies`, body),
  patch: (id: string, body: Record<string, unknown>) => api.patch<StudyDetail>(`/usability-studies/${id}`, body),
  markNa: (id: string, reason: string) => api.post<StudyDetail>(`/usability-studies/${id}/mark-na`, { reason }),
  participants: (id: string) => api.get<Array<{ id: string; name: string; satisfaction?: number }>>(`/usability-studies/${id}/participants`),
  addParticipant: (id: string, body: Record<string, unknown>) => api.post<{ id: string }>(`/usability-studies/${id}/participants`, body),
  patchParticipant: (id: string, pid: string, body: Record<string, unknown>) => api.patch<{ id: string }>(`/usability-studies/${id}/participants/${pid}`, body),
  tasks: (id: string) => api.get<Array<{ id: string; name: string }>>(`/usability-studies/${id}/tasks`),
  addTask: (id: string, body: Record<string, unknown>) => api.post<{ id: string }>(`/usability-studies/${id}/tasks`, body),
  patchTask: (id: string, tid: string, body: Record<string, unknown>) => api.patch<{ id: string }>(`/usability-studies/${id}/tasks/${tid}`, body),
  delTask: (id: string, tid: string) => api.del<{ ok: boolean }>(`/usability-studies/${id}/tasks/${tid}`),
  runs: (id: string) => api.get<Array<Record<string, unknown>>>(`/usability-studies/${id}/runs`),
  putRun: (id: string, body: Record<string, unknown>) => api.put<{ ok: boolean }>(`/usability-studies/${id}/runs`, body),
  sus: (id: string) => api.get<Array<Record<string, unknown>>>(`/usability-studies/${id}/sus`),
  putSus: (id: string, body: Record<string, unknown>) => api.put<{ ok: boolean }>(`/usability-studies/${id}/sus`, body),
  calcSus: (id: string) => api.post<{ sus_score?: number; per_question?: number[] }>(`/usability-studies/${id}/sus/calculate`, {}),
  stats: (id: string) => api.get<Record<string, unknown>>(`/usability-studies/${id}/stats`),
  report: (id: string) => api.post<{ report_id?: string; path?: string }>(`/usability-studies/${id}/report`, {}),
}

// ===========================================================================
// 系统 / 系统合并 UEI 快照 / 跨系统对比（v1.1 层级合并：产品线 → 系统）
// ===========================================================================
export interface SystemRow {
  id: string
  code: string
  name: string
  owner_text?: string
  division_id?: string | null
  status?: string
  status_label?: string
  scheme_id?: string
  scheme_version?: number
  scheme_code?: string
  scheme_name?: string
  note?: string
  member_count?: number
  effective_project_count?: number
  updated_at?: string
  updated_by_name?: string
}
export interface SystemMember {
  id: string
  system_id?: string
  project_id: string
  project_name: string
  code?: string
  version_code?: string
  weight?: string
  project_type?: string
  owner_text?: string
  status?: string
  current_node_name?: string
}
export interface SystemSnapshotSummary {
  id: string
  system_id?: string
  system_code?: string
  system_name?: string
  scheme_code?: string
  selection_mode?: string
  filters?: Record<string, unknown>
  source_snapshot_count?: number
  effective_project_count?: number
  outlier_project_count?: number
  raw_issue_count?: number
  deduped_issue_count?: number
  core_deduction?: string
  non_core_deduction?: string
  total_deduction?: string
  authoritative_uei?: string
  weighted_average_uei?: string
  bucket_uei?: string
  sample_sufficient?: boolean
  cell_counts?: Record<string, number>
  created_by_name?: string
  snapshot_at?: string | null
}
export interface SystemDetail extends SystemRow {
  members?: SystemMember[]
  active_members?: SystemMember[]
  alerts?: Array<{ level?: string; kind?: string; message: string; project_name?: string; system_name?: string }>
  snapshot_history?: SystemSnapshotSummary[]
}
export interface L2Source {
  project_id: string
  project_name: string
  version_code?: string
  weight?: string
  l1_snapshot_id?: string
  l1_scheme_code?: string
  l1_uei?: string
  project_uei?: string
  is_out_of_scope?: boolean
  issue_count?: number
}
export interface L2Issue {
  issue_id: string
  issue_code?: string
  business_level: string
  severity: string
  cell_key: string
  deduction: string
  project_id?: string
  project_name?: string
}
export interface L2SnapshotRow {
  id: string
  system_code?: string
  system_name?: string
  scheme_code?: string
  selection_mode?: string
  effective_project_count?: number
  deduped_issue_count?: number
  core_deduction?: string
  non_core_deduction?: string
  total_deduction?: string
  authoritative_uei?: string
  weighted_average_uei?: string
  bucket_uei?: string
  sample_sufficient?: boolean
  snapshot_at?: string | null
  created_by_name?: string
}
export interface L2SnapshotDetail extends L2SnapshotRow {
  sources?: L2Source[]
  issues?: L2Issue[]
  auxiliary?: { weighted_average_uei?: string; bucket_uei?: string; caliber_weighted?: string; caliber_bucket?: string }
  cell_counts?: Record<string, number>
  sample_gap?: string
  caliber_note?: string
  immutable?: boolean
}
export interface SystemComparisonColumn {
  system_id: string
  system_code?: string
  system_name?: string
  scheme_code?: string
  authoritative_uei?: string
  weighted_average_uei?: string
  bucket_uei?: string
  sample_sufficient?: boolean
  effective_project_count?: number
  deduped_issue_count?: number
  outlier_project_count?: number
  cell_counts?: Record<string, number>
  top_exposure?: Array<{ key: string; label?: string; issue_count?: number }>
  trend?: Array<{ version_code?: string; project_count?: number; deduped_issue_count?: number; uei?: string }>
  ranking_excluded?: boolean
  exclude_reason?: string
}
export interface SystemComparison {
  system_count?: number
  selection_mode?: string
  same_caliber_note?: string
  columns?: SystemComparisonColumn[]
  ranking?: string[]
  excluded_from_ranking?: Array<Record<string, string>>
  comparison_note?: string
}

export const systemsApi = {
  list: (params: Record<string, string | number | undefined> = {}) =>
    api.get<Page<Raw>>(`/systems${qs(params)}`).then((p) => ({ ...p, items: p.items.map(adaptSystemRow) })),
  get: (id: string) => api.get<Raw>(`/systems/${id}`).then(adaptSystemDetail),
  create: (body: Record<string, unknown>) => api.post<Raw>(`/systems`, body).then(adaptSystemDetail),
  patch: (id: string, body: Record<string, unknown>) => api.patch<Raw>(`/systems/${id}`, body).then(adaptSystemRow),
  archive: (id: string) => api.post<Raw>(`/systems/${id}/archive`).then(adaptSystemRow),
  members: (id: string) => api.get<SystemMember[]>(`/systems/${id}/members`),
  attachProject: (id: string, body: { project_id: string; weight?: string }) =>
    api.post<SystemMember>(`/systems/${id}/members`, body),
  setMemberWeight: (id: string, projectId: string, body: { weight: string }) =>
    api.post<SystemMember>(`/systems/${id}/members/${projectId}/weight`, body),
  changeScheme: (id: string, body: { scheme_id: string; reason?: string }) =>
    api.post<Raw>(`/systems/${id}/scheme`, body).then(adaptSystemRow),
  analytics: (id: string, params: Record<string, string | number | undefined> = {}) =>
    api.get<Record<string, unknown>>(`/systems/${id}/analytics${qs(params)}`),
  createSnapshot: (body: Record<string, unknown>) =>
    api.post<Raw>(`/system-snapshots`, body).then(adaptL2Snapshot),
  listSnapshots: (params: Record<string, string | number | undefined> = {}) =>
    api.get<Page<SystemSnapshotSummary>>(`/system-snapshots${qs(params)}`),
  getSnapshot: (id: string) => api.get<Raw>(`/system-snapshots/${id}`).then(adaptL2Snapshot),
  compare: (body: { system_ids: string[]; selection_mode?: string; from?: string; to?: string; version_prefix?: string; top_n?: number }) =>
    api.post<SystemComparison>(`/system-comparisons`, body),
}

// ===========================================================================
// 字典（dictionaries）
// ===========================================================================
export interface DictTreeItem { id: string; name: string; parent_id: string | null; level: number; code?: string; count?: number; children?: DictTreeItem[] }
export interface DictItem { id: string; code?: string; name: string; description?: string; standard?: string; example?: string; level_name?: string; deduction?: number | string; status?: string }
export interface DictSummary { total: number; by_level?: Record<string, number>; checked?: number }

export const dictionariesApi = {
  batches: () => api.get<Array<{ id: string; source: string; hash: string; rows: number; imported_at?: string }>>(`/dictionaries/batches`),
  tree: (type: string, params: Record<string, string | number | undefined> = {}) => api.get<DictTreeItem>(`/dictionaries/${type}/tree${qs(params)}`),
  items: (type: string, params: Record<string, string | number | undefined> = {}) =>
    api.get<Page<Raw>>(`/dictionaries/${type}/items${qs(params)}`).then((p) => ({
      ...p,
      items: p.items.map((x) => ({
        ...(x as unknown as DictItem),
        id: str(x.id),
        code: x.item_no === null || x.item_no === undefined ? str(x.code) : String(x.item_no),
        name: str(x.name),
        description: str(x.description),
        standard: str(x.source_standard) || str(x.standard),
        example: str(x.example),
        status: x.is_active === false ? 'disabled' : 'active',
        deduction: str(x.deduction) || undefined,
      })),
    })),
  summary: (type: string) =>
    api.get<Raw>(`/dictionaries/${type}/summary`).then((r) => {
      const counts = (r.counts ?? {}) as Record<string, number>
      return {
        total: num(counts.nodes_total) ?? num(r.total) ?? 0,
        by_level: (counts.nodes_by_level as unknown as Record<string, number>) ?? undefined,
        checked: num(counts.check_items),
      }
    }),
  importPrecheck: (body: { source: string; rows: unknown[] }) => api.post<{ id: string; rows: number; errors: unknown[] }>(`/dictionaries/import/precheck`, body),
  importApply: (body: { source: string; rows: unknown[] }) => api.post<{ id: string; rows: number }>(`/dictionaries/import/apply`, body),
  updateNode: (nodeId: string, body: Record<string, unknown>) => api.patch<{ ok: boolean }>(`/dictionaries/nodes/${nodeId}`, body),
  updateItem: (itemId: string, body: Record<string, unknown>) => api.patch<{ ok: boolean }>(`/dictionaries/items/${itemId}`, body),
  disableNode: (nodeId: string) => api.patch<{ ok: boolean }>(`/dictionaries/nodes/${nodeId}`, { status: 'disabled' }),
  disableItem: (itemId: string) => api.patch<{ ok: boolean }>(`/dictionaries/items/${itemId}`, { status: 'disabled' }),
}

// ===========================================================================
// 分值库（score-library，必须指定 level）
// ===========================================================================
export const SCORE_LIBRARY_LEVELS = ['L1', 'L2', 'L3'] as const
export type ScoreLibraryLevel = (typeof SCORE_LIBRARY_LEVELS)[number]
export interface LibraryEntry { id: string; level: string; object: string; period_version?: string; score?: number; caliber?: string; scheme_version?: string; threshold_version?: string; snapshot_at?: string; snapshot_id?: string }
export const scoreLibraryApi = {
  levels: () => api.get<{ levels: Array<{ code: string; label: string; description: string }> }>(`/score-library/levels`),
  query: (level: ScoreLibraryLevel, params: Record<string, string | number | undefined> = {}) =>
    api.get<Page<Raw>>(`/score-library${qs({ level, ...params })}`).then((p) => ({
      ...p,
      items: p.items.map(adaptLibraryEntry),
    })),
  get: (id: string) => api.get<Raw>(`/score-library/${id}`).then((r) => adaptLibraryEntry(r)),
}

// ===========================================================================
// 事业部评价 BEI（后端真实计算：五维加权 → 自动分 → 人工微调 → 定榜）
// ===========================================================================
export interface BeiQuarter { quarter: string; divisions: Array<{ id: string; name: string; sample_status: string; auto_score?: number; manual_score?: number; final_score?: number; grade?: string; ranking_status?: string }> }
export interface BeiDetail { division_id: string; division_name?: string; quarter: string; dimensions: Array<{ code: string; name: string; weight: string; metric_values: Array<{ key: string; raw?: number; normalized?: number | null; scoring: boolean }>; dimension_score?: number | null }>; manual_score?: number; manual_reason?: string; final_score?: number | null; grade?: string | null; disclaimer?: string }
export const beiApi = {
  // 后端要求 period（如 2026Q4），且返回平面 items；此处统一补默认季度并聚合为季度分组。
  list: (params: Record<string, string | number | undefined> = {}) => {
    const period = str(params.period) || str(params.quarter) || currentQuarter()
    return api.get<Raw>(`/bei?period=${encodeURIComponent(period)}`).then((r) => adaptBeiList(r, period))
  },
  get: (divisionId: string, period: string) => api.get<Raw>(`/divisions/${divisionId}/bei/${period}`).then(adaptBeiDetail),
  preview: (period: string) => api.get<{ quarter: string; divisions: unknown[] }>(`/bei/preview?period=${period}`),
  // 后端定榜端点为 POST /bei/quarterly-snapshots/finalize，周期随 body 传入
  rank: (period: string, body: Record<string, unknown>) =>
    api.post<{ ok: boolean }>(`/bei/quarterly-snapshots/finalize`, { period, ...body }),
  patchMetric: (divisionId: string, period: string, body: Record<string, unknown>) =>
    api.patch<Raw>(`/divisions/${divisionId}/bei/${period}`, body).then(adaptBeiDetail),
  thresholdVersions: () => api.get<Array<{ version: string; status: string; source?: string }>>(`/bei-threshold-versions`),
}

// ===========================================================================
// 协作 / AI / Provider 作业（integration）
// ===========================================================================
export interface ThreadRow { id: string; title: string; project_name?: string; message_count?: number; updated_at?: string; closed?: boolean }
export interface ThreadDetail extends ThreadRow { messages?: Array<{ id: string; author: string; content: string; at?: string; ref_type?: string; ref_id?: string }> }
export const collaborationApi = {
  list: (params: Record<string, string | number | undefined> = {}) => api.get<Page<ThreadRow>>(`/collaboration/threads${qs(params)}`),
  create: (body: Record<string, unknown>) => api.post<ThreadDetail>(`/collaboration/threads`, body),
  get: (id: string) =>
    api.get<Raw>(`/collaboration/threads/${id}`).then((r) => ({
      ...(r as unknown as ThreadDetail),
      id: str(r.id),
      title: str(r.title),
      message_count: num(r.message_count) ?? num(r.reply_count),
      closed: str(r.status) === 'closed',
      messages: arr(r.messages).map((m) => ({
        id: str(m.id),
        author: str(m.author_name),
        content: str(m.body),
        at: str(m.created_at),
        ref_type: str(m.ref_type) || undefined,
        ref_id: str(m.ref_id) || undefined,
      })),
    })),
  post: (id: string, body: { content: string; ref_type?: string; ref_id?: string }) =>
    api
      .post<Raw>(`/collaboration/threads/${id}/messages`, { body: body.content, ref_type: body.ref_type, ref_id: body.ref_id })
      .then(async (r) => {
        const threadId = str((r.message as Raw | undefined)?.thread_id) || id
        return collaborationApi.get(threadId)
      }),
  close: (id: string) => api.post<Raw>(`/collaboration/threads/${id}/close`).then((r) => collaborationApi.get(str((r as Raw).id) || id)),
}

export interface ConversationRow { id: string; title: string; project_name?: string; message_count?: number; model?: string; is_mock?: boolean; updated_at?: string }
export interface ConversationDetail extends ConversationRow { messages?: Array<{ id: string; role: string; content: string; refs?: string[]; is_mock?: boolean; job_id?: string }> }
export const aiApi = {
  list: (params: Record<string, string | number | undefined> = {}) => api.get<Page<ConversationRow>>(`/ai-conversations${qs(params)}`),
  create: (body: Record<string, unknown>) => api.post<ConversationDetail>(`/ai-conversations`, body),
  get: (id: string) => api.get<ConversationDetail>(`/ai-conversations/${id}`),
  analyze: (id: string, body: { prompt: string; context?: Record<string, unknown> }) =>
    api
      .post<Raw>(`/ai-conversations/${id}/messages`, { content: body.prompt, context: body.context })
      .then((r) => (r.conversation ? (r.conversation as unknown as ConversationDetail) : (r as unknown as ConversationDetail))),
  retry: (id: string) =>
    api
      .post<Raw>(`/ai-conversations/${id}/retry`)
      .then((r) => (r.conversation ? (r.conversation as unknown as ConversationDetail) : (r as unknown as ConversationDetail))),
}

export interface ProviderJob { id: string; type: string; target?: string; idempotency_key?: string; mode?: string; status: string; progress?: number; receipt?: string; retry_count?: number; created_at?: string; updated_at?: string }
export const providerJobsApi = {
  list: (params: Record<string, string | number | undefined> = {}) => api.get<Page<ProviderJob>>(`/provider-jobs${qs(params)}`),
  get: (id: string) => api.get<ProviderJob & { receipt?: string; allowed_actions?: string[] }>(`/provider-jobs/${id}`),
  retry: (id: string) => api.post<ProviderJob>(`/provider-jobs/${id}/retry`),
  cancel: (id: string) => api.post<ProviderJob>(`/provider-jobs/${id}/cancel`),
}
export const providersApi = {
  list: () => api.get<Array<{ kind: string; configured: boolean; mode: string; endpoint?: string }>>(`/providers`),
  test: (kind: string) => api.post<{ ok: boolean; note?: string }>(`/providers/${kind}/test`, {}),
}

// ===========================================================================
// 审计日志（settings.py: /audit-logs，所有账号可读）
// ===========================================================================
export interface AuditRow {
  id: string
  category?: string
  action?: string
  actor_name?: string
  actor_role?: string
  target_type?: string
  target_id?: string
  summary?: string
  detail?: string
  request_id?: string
  created_at?: string
}
export const auditApi = {
  list: (params: Record<string, string | number | undefined> = {}) => api.get<Page<AuditRow>>(`/audit-logs${qs(params)}`),
}
