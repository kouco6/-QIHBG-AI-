import { Link, useSearchParams } from 'react-router-dom'
import { issuesApi, projectsApi } from '@/services/endpoints'
import { PageHeader } from '@/components/PageHeader'
import { AsyncBoundary } from '@/components/AsyncBoundary'
import { IssueStatusBadge } from '@/components/StatusBadge'
import { useAsync } from '@/hooks/useAsync'
import { formatDateTime } from '@/constants'

interface SearchResult {
  projects: { id: string; name: string }[]
  issues: { id: string; description: string; status: string }[]
}

/** 全局搜索落地页：跨项目与问题检索（顶部 `/` 聚焦搜索后回车进入）。 */
export default function SearchPage() {
  const [params] = useSearchParams()
  const q = params.get('q') ?? ''

  const state = useAsync<SearchResult>(async () => {
    if (!q) return { projects: [], issues: [] }
    const [projects, issues] = await Promise.all([
      projectsApi.list({ q, page_size: 10 }),
      issuesApi.list({ q, page_size: 10 }),
    ])
    return { projects: projects.items, issues: issues.items }
  }, [q])

  return (
    <div>
      <PageHeader title="搜索" subtitle={`关键词：${q || '（空）'}`} />
      <AsyncBoundary
        state={state}
        isEmpty={(data) => data.projects.length === 0 && data.issues.length === 0}
        emptyTitle={q ? '无匹配结果' : '请输入关键词'}
        emptyReason={
          q ? `未找到与「${q}」匹配的项目或问题，可减少关键词后重试。` : '在顶部搜索框输入关键词后回车，可检索项目与问题。'
        }
      >
        {(data) => (
          <>
            <div className="grid-2">
              <div className="card">
                <h2 className="card__title">项目（{data.projects.length}）</h2>
                {data.projects.length === 0 ? (
                  <div className="text-tertiary">无匹配项目</div>
                ) : (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {data.projects.map((p) => (
                      <li key={p.id}>
                        <Link to={`/projects/${p.id}`}>{p.name}</Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="card">
                <h2 className="card__title">问题（{data.issues.length}）</h2>
                {data.issues.length === 0 ? (
                  <div className="text-tertiary">无匹配问题</div>
                ) : (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {data.issues.map((i) => (
                      <li key={i.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <IssueStatusBadge status={i.status} />
                        <Link to={`/issues/${i.id}`}>{i.description.slice(0, 40)}</Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <div className="text-tertiary" style={{ marginTop: 12, fontSize: 12 }}>
              最近更新：{formatDateTime(new Date().toISOString())}
            </div>
          </>
        )}
      </AsyncBoundary>
    </div>
  )
}
