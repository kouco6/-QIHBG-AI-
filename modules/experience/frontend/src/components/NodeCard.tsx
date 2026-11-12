import { NodeStatusBadge } from '@/components/StatusBadge'

export interface NodeCardProps {
  code: string
  name: string
  status: string
  onClick?: () => void
}

/**
 * 节点卡片：编码 + 名称 + 状态徽章。
 * 状态一律走 NodeStatusBadge 的中文标签（未开始/进行中/已完成/不适用），
 * 禁止用节点名称代替状态文字（T14 验收）。
 */
export function NodeCard({ code, name, status, onClick }: NodeCardProps) {
  return (
    <div
      className="node-card"
      style={onClick ? { cursor: 'pointer' } : undefined}
      onClick={onClick}
      data-node-code={code}
      data-node-status={status}
    >
      <div className="node-card__code">{code}</div>
      <div className="node-card__name">{name}</div>
      <div className="node-card__meta">
        <NodeStatusBadge status={status} />
      </div>
    </div>
  )
}
