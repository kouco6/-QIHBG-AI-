import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { LoadingState, ErrorState } from '@/components/StateBlocks'
import { ArtifactStatusBadge } from '@/components/StatusBadge'
import { artifactsApi, type ArtifactVersion, type FieldDiff } from '@/services/endpoints'
import { formatDateTime } from '@/constants'
import { useToast } from '@/components/Toast'

export default function ArtifactVersionsPage() {
  const { id = '' } = useParams()
  const state = useAsync(() => artifactsApi.versions(id), [id])
  const [fromV, setFromV] = useState<number | ''>('')
  const [toV, setToV] = useState<number | ''>('')
  const [diff, setDiff] = useState<FieldDiff[] | null>(null)
  const [diffErr, setDiffErr] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const toast = useToast()

  const versions = state.data ?? []

  const options = useMemo(() => versions.map((v) => v.version_no), [versions])

  async function loadDiff() {
    if (fromV === '' || toV === '') {
      toast.show('请选择起始与目标的版本', 'warning')
      return
    }
    setDiffLoading(true)
    setDiffErr(null)
    try {
      setDiff(await artifactsApi.diff(id, Number(fromV), Number(toV)))
    } catch (e) {
      setDiffErr((e as Error).message)
    } finally {
      setDiffLoading(false)
    }
  }

  return (
    <div>
      <PageHeader title="产物版本与对比" subtitle="字段级左右差异；已确认版本只读" />

      <AsyncBoundary state={state} emptyTitle="暂无版本" emptyReason="该产物还没有任何版本记录。">
        {(list) => (
          <>
            <section className="card" style={{ marginBottom: 16 }}>
              <h2 className="card__title">版本列表（{list.length}）</h2>
              <table className="data-table">
                <thead>
                  <tr><th>版本</th><th>创建人</th><th>时间</th><th>状态</th></tr>
                </thead>
                <tbody>
                  {(list as ArtifactVersion[]).map((v) => (
                    <tr key={v.version_no}>
                      <td className="num">v{v.version_no}</td>
                      <td>{v.created_by_name ?? '—'}</td>
                      <td className="num">{formatDateTime(v.created_at)}</td>
                      <td><ArtifactStatusBadge status={v.status ?? 'draft'} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="card" style={{ marginBottom: 16 }}>
              <h2 className="card__title">字段级差异</h2>
              <div className="table-toolbar">
                <label>起始版本
                  <select className="input" value={fromV} onChange={(e) => setFromV(e.target.value === '' ? '' : Number(e.target.value))}>
                    <option value="">选择</option>
                    {options.map((o) => <option key={o} value={o}>v{o}</option>)}
                  </select>
                </label>
                <label>目标版本
                  <select className="input" value={toV} onChange={(e) => setToV(e.target.value === '' ? '' : Number(e.target.value))}>
                    <option value="">选择</option>
                    {options.map((o) => <option key={o} value={o}>v{o}</option>)}
                  </select>
                </label>
                <button className="btn btn--primary" onClick={loadDiff}>查看差异</button>
                <button className="btn" onClick={() => toast.show('差异已导出', 'info')}>导出差异</button>
              </div>

              {diffLoading ? <LoadingState rows={4} /> : null}
              {diffErr ? <ErrorState message={diffErr} onRetry={loadDiff} /> : null}
              {diff && !diffLoading && !diffErr ? (
                <table className="data-table">
                  <thead>
                    <tr><th>字段</th><th style={{ width: '40%' }}>起始</th><th style={{ width: '40%' }}>目标</th></tr>
                  </thead>
                  <tbody>
                    {diff.length === 0 ? <tr><td colSpan={3} className="text-tertiary">两版本之间无字段变化</td></tr> : null}
                    {diff.map((d) => (
                      <tr key={d.field} className={d.changed ? 'tone-warning' : ''}>
                        <td>{d.label ?? d.field}</td>
                        <td className="wrap">{String(d.from ?? '')}</td>
                        <td className="wrap">{String(d.to ?? '')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </section>
          </>
        )}
      </AsyncBoundary>
    </div>
  )
}
