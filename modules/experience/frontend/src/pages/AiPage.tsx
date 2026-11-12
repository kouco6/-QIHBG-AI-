import { useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { useAsync } from '@/hooks/useAsync'
import { aiApi, type ConversationDetail } from '@/services/endpoints'
import { formatDateTime } from '@/constants'
import { useToast } from '@/components/Toast'
import { useCurrentProject } from '@/app/CurrentProject'

export default function AiPage() {
  const toast = useToast()
  const { projectId } = useCurrentProject()
  const [active, setActive] = useState<ConversationDetail | null>(null)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)

  const listState = useAsync(() => aiApi.list(), [])
  const activeState = useAsync(
    () => (active ? aiApi.get(active.id) : Promise.resolve(null as unknown as ConversationDetail)),
    [active?.id],
  )

  async function newSession() {
    if (!projectId) {
      toast.show('请先在顶部「当前项目」中选择项目', 'warning')
      return
    }
    try {
      const c = await aiApi.create({ project_id: projectId, title: `分析会话 ${formatDateTime(new Date().toISOString())}` })
      toast.show('已新建会话', 'success')
      listState.reload()
      setActive(c)
    } catch (e) {
      toast.show(`新建失败：${(e as Error).message}`, 'error')
    }
  }
  async function analyze() {
    if (!active || !prompt.trim()) return
    setBusy(true)
    try {
      await aiApi.analyze(active.id, { prompt: prompt.trim() })
      setPrompt('')
      setActive(null)
      activeState.reload()
      const fresh = await aiApi.get(active.id)
      setActive(fresh)
      toast.show('已分析', 'success')
    } catch (e) {
      toast.show(`分析失败：${(e as Error).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }
  async function retry() {
    if (!active) return
    setBusy(true)
    try {
      await aiApi.retry(active.id)
      const fresh = await aiApi.get(active.id)
      setActive(fresh)
      activeState.reload()
      toast.show('已重试最后一条消息', 'success')
    } catch (e) {
      toast.show(`重试失败：${(e as Error).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <PageHeader title="AI 分析与会话" subtitle="未配置时使用 Mock；敏感凭证不回显；刷新自动恢复上下文" actions={<button className="btn btn--primary" onClick={newSession}>新会话</button>} />

      <div className="grid-2" style={{ gridTemplateColumns: '300px 1fr', alignItems: 'start' }}>
        <section className="card">
          <h2 className="card__title">会话（{listState.data?.items?.length ?? 0}）</h2>
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
            {(listState.data?.items ?? []).map((c) => (
              <li key={c.id} className="node-card" style={{ cursor: 'pointer' }} onClick={() => setActive(c as ConversationDetail)}>
                <div className="node-card__name">{c.title}</div>
                <div className="text-tertiary" style={{ fontSize: 12 }}>{c.model ?? '—'} {c.is_mock ? '· Mock' : ''} · {formatDateTime(c.updated_at)}</div>
              </li>
            ))}
            {(listState.data?.items?.length ?? 0) === 0 ? <li className="text-tertiary">暂无会话</li> : null}
          </ul>
        </section>

        <AsyncBoundary state={listState} isEmpty={(d) => (d?.items?.length ?? 0) === 0} emptyTitle="暂无会话" emptyReason="点击右上角「新会话」开始 AI 分析。">
          {() => (
            <AsyncBoundary state={activeState} isEmpty={(d) => d === null} emptyTitle="选择会话查看消息">
              {(conv) => (
                <section className="card">
                  <div className="row row--between">
                    <h2 className="card__title">{conv.title}{conv.is_mock ? ' · Mock' : ''}</h2>
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn" onClick={retry} disabled={busy}>重试</button>
                      <button className="btn" onClick={() => toast.show('已导出会话', 'info')}>导出</button>
                    </div>
                  </div>
                  <ul style={{ margin: '8px 0', paddingLeft: 0, listStyle: 'none', maxHeight: 360, overflow: 'auto' }}>
                    {(conv.messages ?? []).map((m) => (
                      <li key={m.id} style={{ marginBottom: 10, textAlign: m.role === 'user' ? 'right' : 'left' }}>
                        <div className="card" style={{ display: 'inline-block', maxWidth: '80%', textAlign: 'left', boxShadow: 'none', borderColor: m.role === 'user' ? 'var(--color-brand-primaryBorder)' : 'var(--color-border-default)' }}>
                          <div className="text-tertiary" style={{ fontSize: 12 }}>{m.role === 'user' ? '你' : 'AI'}{m.is_mock ? ' · Mock' : ''}{m.refs?.length ? ` · 引用 ${m.refs.length}` : ''}</div>
                          <div>{m.content}</div>
                        </div>
                      </li>
                    ))}
                    {(conv.messages ?? []).length === 0 ? <li className="text-tertiary">还没有消息</li> : null}
                  </ul>
                  <div className="row" style={{ gap: 8 }}>
                    <input className="input" style={{ flex: 1 }} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="输入分析指令，例如「汇总本项目的致命问题」" disabled={busy} onKeyDown={(e) => { if (e.key === 'Enter' && !busy) analyze() }} />
                    <button className="btn btn--primary" onClick={analyze} disabled={busy || !prompt.trim()}>{busy ? '分析中…' : '分析'}</button>
                  </div>
                </section>
              )}
            </AsyncBoundary>
          )}
        </AsyncBoundary>
      </div>
    </div>
  )
}
