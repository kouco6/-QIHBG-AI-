import type { ReactNode } from 'react'
import {
  ARTIFACT_STATUSES,
  ISSUE_STATUSES,
  JOB_STATUSES,
  NODE_STATUSES,
  REVIEW_STATUSES,
  STUDY_STATUSES,
  statusMeta,
} from '@/constants'

/** 状态徽章：色 + 图标 + 文字 三重编码（DESIGN §6.4 无障碍要求） */
export function StatusBadge({ tone, icon, children, title }: { tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; icon?: string; children: ReactNode; title?: string }) {
  return (
    <span className={`status-badge status-badge--${tone}`} title={title}>
      {icon ? <span className="status-badge__icon" aria-hidden="true">{icon}</span> : null}
      <span>{children}</span>
    </span>
  )
}

export function NodeStatusBadge({ status }: { status: string }) {
  const m = statusMeta(NODE_STATUSES, status)
  return <StatusBadge tone={m.tone} icon={m.icon}>{m.label}</StatusBadge>
}
export function ArtifactStatusBadge({ status }: { status: string }) {
  const m = statusMeta(ARTIFACT_STATUSES, status)
  return <StatusBadge tone={m.tone} icon={m.icon}>{m.label}</StatusBadge>
}
export function IssueStatusBadge({ status }: { status: string }) {
  const m = statusMeta(ISSUE_STATUSES, status)
  return <StatusBadge tone={m.tone} icon={m.icon}>{m.label}</StatusBadge>
}
export function ReviewStatusBadge({ status }: { status: string }) {
  const m = statusMeta(REVIEW_STATUSES, status)
  return <StatusBadge tone={m.tone} icon={m.icon}>{m.label}</StatusBadge>
}
export function JobStatusBadge({ status }: { status: string }) {
  const m = statusMeta(JOB_STATUSES, status)
  return <StatusBadge tone={m.tone} icon={m.icon}>{m.label}</StatusBadge>
}
export function StudyStatusBadge({ status }: { status: string }) {
  const m = statusMeta(STUDY_STATUSES, status)
  return <StatusBadge tone={m.tone} icon={m.icon}>{m.label}</StatusBadge>
}
