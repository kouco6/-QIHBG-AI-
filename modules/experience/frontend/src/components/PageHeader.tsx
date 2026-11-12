import type { ReactNode } from 'react'

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        <h1 className="page-header__title">{title}</h1>
        {subtitle ? <div className="page-header__sub">{subtitle}</div> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  )
}

export function Breadcrumbs({ items }: { items: Array<{ label: string; to?: string }> }) {
  return (
    <nav className="breadcrumbs" aria-label="面包屑">
      {items.map((it, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {i > 0 ? <span className="breadcrumbs__sep" aria-hidden="true">/</span> : null}
          {it.to ? (
            <a href={it.to}>{it.label}</a>
          ) : (
            <span className="breadcrumbs__current" aria-current={i === items.length - 1 ? 'page' : undefined}>
              {it.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  )
}
