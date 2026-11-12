import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { DataTable, type Column } from '@/components/DataTable'
import { JobStatusBadge, IssueStatusBadge } from '@/components/StatusBadge'
import { NodeCard } from '@/components/NodeCard'
import { useAsync } from '@/hooks/useAsync'
import { useCurrentProject } from '@/app/CurrentProject'
import {
  projectsApi,
  issuesApi,
  scoringApi,
  scoreLibraryApi,
  beiApi,
  providerJobsApi,
  auditApi,
  type IssueRow,
  type ProviderJob,
  type AuditRow,
} from '@/services/endpoints'
import { type Page } from '@/services/endpoints'
import { STAGES, UEI_CATEGORY_LABELS, formatDateTime, fmt1 } from '@/constants'

/**
 * 工作台首页（/）— DESIGN §6.2.2。
 * 查看待办、风险、近期分值和作业；首屏优先加载摘要。
 * 区域：当前项目 / 节点进度 / 我的最近操作 / 待验收问题 / L1·L2·L3 分列摘要 / Provider 状态。
 * 主要操作：继续节点、录问题、评分预览、打开看板、打开分值库。
 * 三层卡片（L1/L2/L3）分列展示，禁止混排。
 */
export default function WorkbenchPage() {
  const navigate = useNavigate()
  const { projectId, projectName, recent } = useCurrentProject()
  const hasProject = Boolean(projectId)

  // 各区块独立加载与五态，互不阻塞
  const boardState = useAsync(() => (hasProject ? projectsApi.board(projectId as string) : Promise.reject(new Error('未选择项目'))), [projectId])
  const l1State = useAsync(() => (hasProject ? scoringApi.preview(projectId as string) : Promise.resolve(null)), [projectId])
  const pendingState = useAsync<Page<IssueRow>>(() => issuesApi.list({ status: 'pending_acceptance', page_size: 6 }), [])
  const l2State = useAsync<Page<{ id: string; score?: number }>>(
    () => scoreLibraryApi.query('L2', { page_size: 1 }) as unknown as Promise<Page<{ id: string; score?: number }>>,
    [],
  )
  const l3State = useAsync(() => beiApi.list(), [])
  const jobsState = useAsync<Page<ProviderJob>>(() => providerJobsApi.list({ page_size: 6 }), [])
  const auditState = useAsync<Page<AuditRow>>(() => auditApi.list({ page_size: 6 }), [])

  // 节点进度：统计四阶段完成度，并定位首个可执行（未开始/进行中）节点用于「继续节点」
  const nodeProgress = useMemo(() => {
    const board = boardState.data
    if (!board) return null
    const flat = board.stages.flatMap((s) => s.nodes)
    const total = flat.length || 13
    const completed = flat.filter((n) => n.status === 'completed').length
    const inProgress = flat.filter((n) => n.status === 'in_progress').length
    const notStarted = flat.filter((n) => n.status === 'not_started').length
    const na = flat.filter((n) => n.status === 'not_applicable').length
    const firstActionable = flat.find((n) => n.status === 'not_started' || n.status === 'in_progress')
    const nextCode = firstActionable?.code
    return { total, completed, inProgress, notStarted, na, nextCode, pct: Math.round((completed / total) * 100) }
  }, [boardState.data])

  const l1Columns: Column<{ label: string; value: number }>[] = [
    { key: 'label', header: '类别', minWidth: 120, render: (r) => r.label },
    { key: 'value', header: '计数', minWidth: 70, align: 'right', className: 'num', render: (r) => String(r.value) },
  ]
  const l1Rows = useMemo(() => {
    const counts = (l1State.data?.counts_by_category ?? {}) as Record<string, number>
    return Object.entries(UEI_CATEGORY_LABELS).map(([k, label]) => ({ label, value: counts[k] ?? 0 }))
  }, [l1State.data])

  const pendingColumns: Column<IssueRow>[] = [
    { key: 'id', header: 'ID', fixed: true, minWidth: 90, render: (r) => <a href={`/issues/${r.id}`} onClick={(e) => { e.preventDefault(); navigate(`/issues/${r.id}`) }}>{r.uid ?? r.id.slice(0, 8)}</a> },
    { key: 'desc', header: '描述', minWidth: 220, className: 'wrap', render: (r) => r.description },
    { key: 'product', header: '项目 / 版本', minWidth: 130, render: (r) => `${r.project_name ?? '—'}${r.version_name ? ` / ${r.version_name}` : ''}` },
    { key: 'status', header: '状态', minWidth: 90, render: (r) => <IssueStatusBadge status={r.status} /> },
  ]

  const jobColumns: Column<ProviderJob>[] = [
    { key: 'type', header: '类型', minWidth: 130, render: (r) => r.type },
    { key: 'target', header: '目标', minWidth: 160, className: 'wrap', render: (r) => r.target ?? '—' },
    { key: 'status', header: '状态', minWidth: 100, render: (r) => <JobStatusBadge status={r.status} /> },
    { key: 'progress', header: '进度', minWidth: 100, align: 'right', className: 'num', render: (r) => (r.progress !== undefined ? `${r.progress}%` : '—') },
    { key: 'retry', header: '重试', minWidth: 70, align: 'right', className: 'num', render: (r) => String(r.retry_count ?? 0) },
    { key: 'updated', header: '更新', minWidth: 140, render: (r) => formatDateTime(r.updated_at) },
  ]

  const auditColumns: Column<AuditRow>[] = [
    { key: 'at', header: '时间', minWidth: 150, render: (r) => formatDateTime(r.created_at) },
    { key: 'actor', header: '操作人', minWidth: 120, render: (r) => `${r.actor_name ?? '—'}${r.actor_role ? `（${r.actor_role}）` : ''}` },
    { key: 'action', header: '动作', minWidth: 110, render: (r) => r.action ?? '—' },
    { key: 'summary', header: '摘要', minWidth: 240, className: 'wrap', render: (r) => r.summary ?? '' },
  ]

  return (
    <div className="stack">
      <PageHeader
        title="工作台"
        subtitle={projectName ? `当前项目：${projectName}` : '请选择当前项目以加载节点进度与评分预览'}
        actions={
          <>
            <button className="btn" onClick={() => navigate('/issues?new=1')}>录问题</button>
            {hasProject ? (
              <>
                <button className="btn" onClick={() => navigate(`/projects/${projectId}/board`)}>打开看板</button>
                <button className="btn btn--primary" onClick={() => navigate(`/projects/${projectId}/scores/preview`)}>评分预览</button>
              </>
            ) : null}
          </>
        }
      />

      {!hasProject ? (
        <div className="state-block" role="status">
          <div className="state-block__title">尚未选择当前项目</div>
          <div>在顶部「当前项目」下拉中选择项目，或前往项目列表新建，工作台将展示节点进度与评分预览。</div>
          <div style={{ marginTop: 12 }}>
            <button className="btn btn--primary" onClick={() => navigate('/projects')}>前往项目</button>
          </div>
        </div>
      ) : null}

      {/* 节点进度 */}
      {hasProject ? (
        <section className="card">
          <div className="row row--between row--wrap" style={{ marginBottom: 10 }}>
            <h2 className="card__title" style={{ margin: 0 }}>节点进度</h2>
            {nodeProgress?.nextCode ? (
              <button className="btn btn--primary" onClick={() => navigate(`/projects/${projectId}/nodes/${nodeProgress.nextCode}`)}>继续节点（{nodeProgress.nextCode}）</button>
            ) : null}
          </div>
          <AsyncBoundary state={boardState} emptyTitle="看板不可用" emptyReason="无法加载该项目的阶段看板。">
            {() => (
              <>
                <div className="progress" aria-label={`进度 ${nodeProgress?.pct ?? 0}%`}>
                  <div className="progress__bar" style={{ width: `${nodeProgress?.pct ?? 0}%` }} />
                </div>
                <div className="text-tertiary" style={{ fontSize: 12, marginTop: 6 }}>
                  已完成 {nodeProgress?.completed ?? 0} / 进行中 {nodeProgress?.inProgress ?? 0} / 未开始 {nodeProgress?.notStarted ?? 0} / 不适用 {nodeProgress?.na ?? 0}（共 {nodeProgress?.total ?? 13} 节点）
                </div>
                <div className="board" style={{ gridTemplateColumns: 'repeat(4, minmax(200px, 1fr))', marginTop: 12 }}>
                  {STAGES.map((stage) => {
                    const lane = boardState.data?.stages.find((s) => s.code === stage.code)
                    const nodes = lane?.nodes ?? []
                    const done = nodes.filter((n) => n.status === 'completed').length
                    return (
                      <div className="board__lane" key={stage.code}>
                        <div className="board__lane-title">
                          <span>{stage.name}</span>
                          <span className="text-tertiary">{done}/{nodes.length}</span>
                        </div>
                        {nodes.slice(0, 3).map((n) => (
                          <NodeCard
                            key={n.id}
                            code={n.code}
                            name={n.name}
                            status={n.status}
                            onClick={() => navigate(`/projects/${projectId}/nodes/${n.code}`)}
                          />
                        ))}
                        {nodes.length > 3 ? <div className="text-tertiary" style={{ fontSize: 12 }}>…共 {nodes.length} 个节点</div> : null}
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </AsyncBoundary>
        </section>
      ) : null}

      {/* L1 / L2 / L3 分列摘要（禁止混排） */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        <section className="card">
          <div className="row row--between row--wrap" style={{ marginBottom: 8 }}>
            <h2 className="card__title" style={{ margin: 0 }}>L1 产品评分</h2>
            {hasProject ? <button className="btn" onClick={() => navigate(`/projects/${projectId}/scores/preview`)}>评分预览</button> : <button className="btn" onClick={() => navigate('/score-library')}>分值库</button>}
          </div>
          <AsyncBoundary state={l1State} emptyTitle="请选择当前项目" emptyReason="在顶部「当前项目」中选择项目后展示 UEI 评分预览。">
            {(d) => {
              if (!d) return null
              return (
              <>
                <div className="grid-cards" style={{ marginBottom: 8 }}>
                  <div className="card kpi"><span className="kpi__value glow-number">{fmt1(d.uei ?? d.base_score)}</span><span className="kpi__label">UEI</span></div>
                  <div className="card kpi"><span className="kpi__value">{fmt1(d.total_deduction)}</span><span className="kpi__label">总扣分</span></div>
                  <div className="card kpi"><span className="kpi__value">{fmt1(d.core_deduction)}</span><span className="kpi__label">核心扣分</span></div>
                  <div className="card kpi"><span className="kpi__value">{fmt1(d.non_core_deduction)}</span><span className="kpi__label">非核心扣分</span></div>
                </div>
                <DataTable columns={l1Columns} rows={l1Rows} rowKey={(r) => r.label} pageSize={undefined} ariaLabel="L1 八类计数" />
              </>
              )
            }}
          </AsyncBoundary>
        </section>

        <section className="card">
          <div className="row row--between row--wrap" style={{ marginBottom: 8 }}>
            <h2 className="card__title" style={{ margin: 0 }}>L2 系统评价</h2>
            <button className="btn" onClick={() => navigate('/score-library?level=L2')}>打开 L2</button>
          </div>
          <AsyncBoundary state={l2State} isEmpty={(d) => !d.items || d.items.length === 0} emptyTitle="暂无 L2 记录" emptyReason="系统评价快照尚未生成，可先完成系统评估。">
            {(d) => (
              <div className="grid-cards">
                <div className="card kpi"><span className="kpi__value">{d.total}</span><span className="kpi__label">L2 快照数</span></div>
                {d.items[0] ? (
                  <div className="card kpi"><span className="kpi__value">{fmt1(d.items[0].score)}</span><span className="kpi__label">最近 UEI</span></div>
                ) : null}
              </div>
            )}
          </AsyncBoundary>
        </section>

        <section className="card">
          <div className="row row--between row--wrap" style={{ marginBottom: 8 }}>
            <h2 className="card__title" style={{ margin: 0 }}>L3 事业部评价</h2>
            <button className="btn" onClick={() => navigate('/divisions/bei')}>打开 BEI</button>
          </div>
          <AsyncBoundary state={l3State} isEmpty={(d) => !d.items || d.items.length === 0} emptyTitle="暂无 L3 记录" emptyReason="当前季度尚无预估或定榜记录；完成季度定榜后，此处展示各事业部 BEI 排名。">
            {(d) => (
              <div className="grid-cards">
                <div className="card kpi"><span className="kpi__value">{d.items.length}</span><span className="kpi__label">季度榜</span></div>
              </div>
            )}
          </AsyncBoundary>
        </section>
      </div>

      {/* 待验收问题 */}
      <section className="card">
        <div className="row row--between row--wrap" style={{ marginBottom: 8 }}>
          <h2 className="card__title" style={{ margin: 0 }}>待验收问题</h2>
          <button className="btn" onClick={() => navigate('/issues?status=pending_acceptance')}>查看全部</button>
        </div>
        <AsyncBoundary state={pendingState} isEmpty={(d) => !d.items || d.items.length === 0} emptyTitle="暂无待验收问题" emptyReason="当前没有处于「待验收」状态的问题。">
          {(d) => (
            <DataTable columns={pendingColumns} rows={d.items} rowKey={(r) => r.id} onRowClick={(r) => navigate(`/issues/${r.id}`)} pageSize={undefined} ariaLabel="待验收问题" />
          )}
        </AsyncBoundary>
      </section>

      {/* Provider 作业状态 */}
      <section className="card">
        <div className="row row--between row--wrap" style={{ marginBottom: 8 }}>
          <h2 className="card__title" style={{ margin: 0 }}>Provider 作业状态</h2>
          <button className="btn" onClick={() => navigate('/provider-jobs')}>查看全部</button>
        </div>
        <AsyncBoundary state={jobsState} isEmpty={(d) => !d.items || d.items.length === 0} emptyTitle="暂无作业" emptyReason="当前没有 Provider 作业记录。">
          {(d) => (
            <DataTable columns={jobColumns} rows={d.items} rowKey={(r) => r.id} pageSize={undefined} ariaLabel="Provider 作业" />
          )}
        </AsyncBoundary>
      </section>

      {/* 我的最近操作（审计流） */}
      <section className="card">
        <div className="row row--between row--wrap" style={{ marginBottom: 8 }}>
          <h2 className="card__title" style={{ margin: 0 }}>最近操作</h2>
          <button className="btn" onClick={() => navigate('/settings/audit')}>审计日志</button>
        </div>
        <AsyncBoundary state={auditState} isEmpty={(d) => !d.items || d.items.length === 0} emptyTitle="暂无操作记录" emptyReason="最近没有可展示的操作记录。">
          {(d) => (
            <DataTable columns={auditColumns} rows={d.items} rowKey={(r) => r.id} pageSize={undefined} ariaLabel="最近操作" />
          )}
        </AsyncBoundary>
      </section>

      {recent.length > 0 ? (
        <div className="text-tertiary" style={{ fontSize: 12 }}>
          最近访问项目：{recent.slice(0, 5).map((p) => p.name).join('、')}
          {' · '}共 {recent.length} 个
        </div>
      ) : null}

      <div className="text-tertiary" style={{ fontSize: 12 }}>
        提示：按 <kbd>/</kbd> 聚焦全局搜索，<kbd>Esc</kbd> 返回，编辑类页面支持 <kbd>Ctrl</kbd>+<kbd>S</kbd> 保存。
      </div>
    </div>
  )
}
