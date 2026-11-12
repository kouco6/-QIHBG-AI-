import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { systemApi, type HealthResponse } from '@/services/api'
import { projectsApi } from '@/services/endpoints'
import { NODE_BY_CODE } from '@/constants'
import { useAuth } from './AuthProvider'
import { useCurrentProject } from './CurrentProject'
import { useGlobalHotkeys } from '@/hooks/useHotkeys'

interface NavChild {
  label: string
  to: string
  icon: string
  primaryOnly?: boolean
  disabledHint?: string
  reserved?: boolean
}
interface NavGroup {
  key: string
  label: string
  icon: string
  primaryOnly?: boolean
  children: NavChild[]
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [healthError, setHealthError] = useState<string>('')
  const { account, isPrimary, logout } = useAuth()
  const { projectId, projectName, recent, setProject } = useCurrentProject()
  const navigate = useNavigate()
  const location = useLocation()
  const searchRef = useRef<HTMLInputElement>(null)
  const [collapsed, setCollapsed] = useState(() => window.matchMedia('(max-width: 850px)').matches)
  const [projectMenu, setProjectMenu] = useState(false)
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(['dashboard', 'workspace', 'rules', 'settings']))

  useEffect(() => {
    let alive = true
    systemApi
      .health()
      .then((h) => {
        if (alive) setHealth(h)
      })
      .catch((e: unknown) => {
        if (alive) setHealthError(e instanceof Error ? e.message : '后端未连接')
      })
    return () => {
      alive = false
    }
  }, [])

  const pid = projectId

  // 从 URL 解析项目 id：直链进入项目页时自动补齐"当前项目"与面包屑项目名
  const pathProjectId = useMemo(() => {
    const m = location.pathname.match(/^\/projects\/([0-9a-fA-F-]{8,})(?:\/|$)/)
    return m ? m[1] : null
  }, [location.pathname])
  const [pathProjectName, setPathProjectName] = useState<string | null>(null)
  useEffect(() => {
    setPathProjectName(null)
    if (!pathProjectId) return
    if (pathProjectId === projectId && projectName) return
    let alive = true
    projectsApi
      .get(pathProjectId)
      .then((p) => {
        if (!alive || !p.name) return
        setPathProjectName(p.name)
        setProject(pathProjectId, p.name)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // setProject 为稳定引用；projectId/projectName 变化时上面已有短路，避免循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathProjectId])
  const menus: NavGroup[] = useMemo(() => {
    const projectChild = (path: string, label: string, icon: string): NavChild => ({
      label,
      icon,
      to: pid ? `/projects/${pid}${path}` : '/projects',
      disabledHint: pid ? undefined : '请先在顶部选择项目',
    })
    return [
      {
        key: 'dashboard',
        label: '体验看板',
        icon: 'chart',
        children: [
          { label: '总览工作台', to: '/', icon: 'board' },
          { label: '系统 UEI 大盘', to: '/systems', icon: 'chart' },
          { label: '跨系统对比', to: '/systems/compare', icon: 'compare' },
          { label: '事业群体验评分', to: '/divisions/bei', icon: 'bars' },
          { label: '人员工作量与进度', to: '#', icon: 'people', reserved: true, disabledHint: '规划中：独立人员维度看板后续上线' },
        ],
      },
      {
        key: 'workspace',
        label: '工作区',
        icon: 'folder',
        children: [
          { label: '项目', to: '/projects', icon: 'folder' },
          { label: '问题中心', to: '/issues', icon: 'alert' },
          { label: '评审工作区', to: '/reviews', icon: 'check' },
          { label: '可用性研究', to: '/usability', icon: 'search' },
          projectChild('/collaboration', '协作空间', 'users'),
          { label: 'AI 分析', to: '/ai', icon: 'spark' },
        ],
      },
      {
        key: 'rules',
        label: '规则流程',
        icon: 'book',
        children: [
          {
            label: '体验字典',
            to: '/dictionaries/software',
            icon: 'book',
          },
          { label: '评分方案（选用）', to: '/dictionaries/scoring_scheme', icon: 'list' },
          { label: '分值库', to: '/score-library', icon: 'layers' },
        ],
      },
      {
        key: 'settings',
        label: '系统设置',
        icon: 'sliders',
        primaryOnly: true,
        children: [
          { label: '系统设置', to: '/settings', icon: 'sliders' },
          { label: '评分方案管理', to: '/settings/scoring-schemes', icon: 'list' },
          { label: '审计日志', to: '/settings/audit', icon: 'file' },
          { label: 'Provider 作业', to: '/provider-jobs', icon: 'cpu' },
        ],
      },
    ]
  }, [pid])

  const visibleGroups = menus.filter((g) => !g.primaryOnly || isPrimary)

  useGlobalHotkeys({
    onFocusSearch: () => searchRef.current?.focus(),
  })

  async function onLogout() {
    await logout()
    navigate('/login', { replace: true })
  }

  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault()
    const q = searchRef.current?.value?.trim() ?? ''
    navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/search')
  }

  function toggleGroup(key: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const crumbs = buildBreadcrumbs(location.pathname, projectName ?? pathProjectName)

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar__brand">
          <span>产品体验中心</span>
          <span className="badge">UEI V4.0</span>
        </div>

        {/* 当前项目切换 */}
        <div className="project-switch">
          <button type="button" className="project-switch__btn" onClick={() => setProjectMenu((v) => !v)} aria-haspopup="listbox" aria-expanded={projectMenu}>
            <span className="text-tertiary" style={{ fontSize: 12 }}>当前项目</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>{projectName ?? '未选择'}</span>
            <span aria-hidden="true">▾</span>
          </button>
          {projectMenu ? (
            <div className="project-switch__menu" role="listbox">
              {recent.length === 0 ? <div className="text-tertiary" style={{ padding: 8, fontSize: 12 }}>暂无项目</div> : null}
              {recent.map((p) => (
                <div
                  key={p.id}
                  role="option"
                  aria-selected={p.id === projectId}
                  className="project-switch__item"
                  onClick={() => {
                    setProject(p.id, p.name)
                    setProjectMenu(false)
                  }}
                >
                  {p.name}
                  <div className="text-tertiary" style={{ fontSize: 11 }}>{p.version_name ?? ''}</div>
                </div>
              ))}
              <div className="project-switch__item" onClick={() => { setProjectMenu(false); navigate('/projects') }}>
                浏览全部项目 →
              </div>
            </div>
          ) : null}
        </div>

        {/* 全局搜索 */}
        <div className="topbar__search">
          <span className="search-icon" aria-hidden="true">🔍</span>
          <form onSubmit={onSearchSubmit}>
            <input
              ref={searchRef}
              type="search"
              aria-label="全局搜索（按 / 聚焦）"
              placeholder="搜索问题、项目、系统…"
            />
          </form>
          <kbd>/</kbd>
        </div>

        <div className="topbar__spacer" />

        <div className="row">
          <span className={health ? 'badge' : 'badge badge--mock'} title={health?.database.detail ?? healthError}>
            {health ? `后端 ${health.status}` : '后端连接中…'}
          </span>
          <span className="badge badge--mock" title="未配置外部凭证时主流程使用本地 Mock">
            {health ? `Provider：${health.provider.effective_mode}` : 'Provider：mock'}
          </span>
          <span className={isPrimary ? 'badge badge--brand' : 'badge'} title={account?.account ?? ''}>
            {account?.name ?? '未登录'}
            {isPrimary ? ' · 首账号' : ' · 体验人员'}
          </span>
          <button type="button" className="btn" onClick={onLogout}>
            退出
          </button>
        </div>
      </header>

      <div className="app-shell__body">
        <nav className={`app-shell__side${collapsed ? ' is-collapsed' : ''}`} aria-label="业务菜单">
          <div className="brand planning-sidebar-header">
            <span className="module-badge" aria-hidden="true">
              <svg viewBox="0 0 64 64" fill="none">
                <defs>
                  <linearGradient id="exp-layer" x1="9" y1="8" x2="53" y2="60" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#10B6FF" />
                    <stop offset="1" stopColor="#1B63D5" />
                  </linearGradient>
                </defs>
                <circle cx="32" cy="32" r="18" stroke="url(#exp-layer)" strokeWidth="5" />
                <circle cx="32" cy="32" r="9" stroke="#1289E8" strokeWidth="4" />
                <path d="M32 8v8M32 48v8M8 32h8M48 32h8" stroke="#1768CF" strokeWidth="4" strokeLinecap="round" />
              </svg>
            </span>
            <div className="brand-copy">
              <h2>产品体验中心</h2>
              <small>体验评测与问题管理</small>
            </div>
          </div>
          <div className="side-scroll">
          <p className="side-kicker"><span className="kicker-icon" aria-hidden="true"><LineIcon name="board" /></span><span>业务菜单</span></p>
          {collapsed ? (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {visibleGroups.map((g) => (
                <li key={g.key}>
                  <button
                    type="button"
                    className="nav-group-toggle"
                    title={g.label}
                    onClick={() => {
                      setCollapsed(false)
                      setOpenGroups((prev) => new Set(prev).add(g.key))
                    }}
                  >
                    <LineIcon name={g.icon} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            visibleGroups.map((g) => {
              const isOpen = openGroups.has(g.key)
              const groupActive = g.children.some((c) => c.to !== '#' && location.pathname.startsWith(c.to))
              return (
                <div key={g.key} className="nav-group">
                  <button
                    type="button"
                    className={`nav-group-header${groupActive ? ' is-active' : ''}`}
                    aria-expanded={isOpen}
                    onClick={() => toggleGroup(g.key)}
                  >
                    <span className="nav-group-icon" aria-hidden="true"><LineIcon name={g.icon} /></span>
                    <span className="nav-group-label">{g.label}</span>
                    <span className="nav-group-caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                  </button>
                  {isOpen ? (
                    <ul className="nav-group-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                      {g.children
                        .filter((c) => !c.primaryOnly || isPrimary)
                        .map((c) => {
                          if (c.reserved) {
                            return (
                              <li key={c.label}>
                                <span className="nav-leaf is-reserved" title={c.disabledHint ?? '规划中'}>
                                  <span className="nav-icon" aria-hidden="true"><LineIcon name={c.icon} /></span>
                                  <span className="nav-label">{c.label}</span>
                                  <span className="nav-leaf__tag">规划中</span>
                                </span>
                              </li>
                            )
                          }
                          const disabled = !pid && c.disabledHint
                          return (
                            <li key={c.to + c.label}>
                              <NavLink
                                to={c.to}
                                end={c.to === '/'}
                                className={({ isActive }) => `nav-leaf${isActive && !disabled ? ' is-active' : ''}`}
                                style={disabled ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
                                title={c.disabledHint ?? c.label}
                              >
                                <span className="nav-icon" aria-hidden="true"><LineIcon name={c.icon} /></span>
                                <span className="nav-label">{c.label}</span>
                              </NavLink>
                            </li>
                          )
                        })}
                    </ul>
                  ) : null}
                </div>
              )
            })
          )}
          </div>
          <button
            type="button"
            className="side-toggle"
            aria-expanded={!collapsed}
            aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
            onClick={() => setCollapsed((value) => !value)}
          >
            <span aria-hidden="true">{collapsed ? '»' : '«'}</span>
            <span className="side-toggle-label">{collapsed ? '展开' : '收起'}</span>
          </button>
        </nav>

        <main className="app-shell__main">
          {crumbs.length > 0 ? (
            <nav className="breadcrumbs" aria-label="面包屑">
              {crumbs.map((c, i) => (
                <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {i > 0 ? <span className="breadcrumbs__sep" aria-hidden="true">/</span> : null}
                  {c.to ? (
                    <Link to={c.to}>{c.label}</Link>
                  ) : (
                    <span className="breadcrumbs__current">{c.label}</span>
                  )}
                </span>
              ))}
            </nav>
          ) : null}
          {children}
        </main>
      </div>
    </div>
  )
}

function LineIcon({ name }: { name: string }) {
  const paths = LINE_ICONS[name] ?? LINE_ICONS.chart
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {paths.map((d) => (
        <path key={d} d={d} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  )
}

const LINE_ICONS: Record<string, string[]> = {
  chart: ['M4 19.5V13', 'M10 19.5V6.5', 'M15.5 19.5v-9', 'M20.5 19.5H3.5'],
  board: ['M4 4.5h16v15H4z', 'M4 9h16'],
  compare: ['M4 17l5-6 3 3 7-8'],
  bars: ['M4 19.5V10', 'M9 19.5V6', 'M14 19.5v-5', 'M19 19.5V8'],
  people: ['M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6', 'M3.5 19.5c0-2.6 2-4.5 4.5-4.5s4.5 1.9 4.5 4.5', 'M16 8.2a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8', 'M15.2 14.6c2 .5 3.5 2.2 3.5 4.9'],
  folder: ['M3.5 7.5h6l1.6-2h9.4V18.5H3.5z'],
  alert: ['M12 4.5 20 18.5H4L12 4.5z', 'M12 10v4', 'M12 16.5h.01'],
  check: ['M5 12.5 9 16.5 19 6.5'],
  search: ['M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14z', 'M16.5 16.5 20.5 20.5'],
  users: ['M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6', 'M3.5 19.5c0-2.6 2-4.5 4.5-4.5s4.5 1.9 4.5 4.5', 'M16.5 11a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5', 'M16 14.8c2.2.4 3.8 2.2 3.8 4.7'],
  spark: ['M12 3.5 13.4 9.2 19 10.6 13.4 12 12 17.7 10.6 12 5 10.6 10.6 9.2z'],
  book: ['M5 5.5A2.5 2.5 0 0 1 7.5 3H19v15.5H7.5A2.5 2.5 0 0 0 5 21z', 'M5 18.5A2.5 2.5 0 0 1 7.5 16H19'],
  list: ['M8 7h12', 'M8 12h12', 'M8 17h12', 'M4 7h.01', 'M4 12h.01', 'M4 17h.01'],
  layers: ['M12 3 21 7.6 12 12.2 3 7.6z', 'M4.6 12 12 15.8 19.4 12', 'M4.6 16.4 12 20.2l7.4-3.8'],
  sliders: ['M4 7.2h9', 'M17.2 7.2H20', 'M4 16.8h3.6', 'M11.8 16.8H20', 'M15.2 5.1v4.2', 'M9 14.7v4.2'],
  file: ['M7 3.5h8l4 4V20.5H7z', 'M15 3.5V8h4.5'],
  cpu: ['M8 8h8v8H8z', 'M9 4.5v3.5', 'M15 4.5v3.5', 'M9 16v3.5', 'M15 16v3.5', 'M4.5 9H8', 'M4.5 15H8', 'M16 9h3.5', 'M16 15h3.5'],
}

function buildBreadcrumbs(path: string, projectName: string | null): Array<{ label: string; to?: string }> {
  const seg = path.split('/').filter(Boolean)
  if (seg.length === 0) return []
  const map: Record<string, string> = {
    projects: '项目',
    issues: '问题中心',
    reviews: '评审工作区',
    usability: '可用性研究',
    'score-library': '分值库',
    systems: '系统',
    divisions: '事业群评价',
    dictionaries: '体验字典',
    ai: 'AI 分析',
    'provider-jobs': 'Provider 作业',
    settings: '系统设置',
    board: '阶段看板',
    nodes: '节点详情',
    collaboration: '协作空间',
    scores: '评分',
    preview: 'UEI 预览',
    setup: '初始设置',
    artifacts: '产物',
    versions: '版本',
    edit: '编辑器',
    compare: '跨系统大盘',
    analytics: '统计',
    bei: '事业群评价',
    audit: '审计日志',
    'scoring-schemes': '评分方案管理',
    search: '搜索',
    'product-score-snapshots': 'L1 快照',
    'system-snapshots': '系统合并 UEI 快照',
  }
  const out: Array<{ label: string; to?: string }> = []
  let acc = ''
  seg.forEach((s, i) => {
    acc += `/${s}`
    const isId = /^[0-9a-fA-F-]{8,}$/.test(s) || /^\d+$/.test(s)
    const label = isId
      ? (i > 0 && seg[i - 1] === 'projects' && projectName ? projectName : s)
      : NODE_BY_CODE[s]?.name ?? map[s] ?? s
    out.push({ label, to: i === seg.length - 1 ? undefined : acc })
  })
  return out
}
