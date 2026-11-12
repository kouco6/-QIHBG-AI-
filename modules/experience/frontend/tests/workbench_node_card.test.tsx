import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NodeCard } from '@/components/NodeCard'

/**
 * T14-FIX-01 回归：节点卡片的状态徽章必须显示中文状态标签，
 * 不得用节点名称代替状态（原缺陷：徽章取 NODE_SPECS.name）。
 */

const CASES = [
  { status: 'not_started', label: '未开始', tone: 'neutral' },
  { status: 'in_progress', label: '进行中', tone: 'info' },
  { status: 'completed', label: '已完成', tone: 'success' },
  { status: 'not_applicable', label: '不适用', tone: 'neutral' },
]

/** 取 node-card__meta 区块中状态文字节点（排除 aria-hidden 的图标字形） */
function metaText(html: string): string {
  const i = html.indexOf('node-card__meta')
  expect(i).toBeGreaterThanOrEqual(0)
  const seg = html.slice(i)
  const m = seg.match(/<span>([^<]+)<\/span>/)
  expect(m).not.toBeNull()
  return (m as RegExpMatchArray)[1]
}

describe('节点卡片状态徽章（T14）', () => {
  for (const c of CASES) {
    it(`status=${c.status} 显示「${c.label}」而非节点名称`, () => {
      const html = renderToStaticMarkup(<NodeCard code="N01" name="项目启动与需求确认" status={c.status} />)
      // 名称在 node-card__name 正常展示
      expect(html).toContain('项目启动与需求确认')
      // 徽章文字必须是状态标签
      expect(metaText(html)).toBe(c.label)
      expect(metaText(html)).not.toContain('项目启动与需求确认')
      // 色 + 图标 + 文字三重编码：色调与状态语义一致
      expect(html).toContain(`status-badge--${c.tone}`)
      // 状态原值透出到 DOM，便于浏览器验证脚本断言
      expect(html).toContain(`data-node-status="${c.status}"`)
    })
  }

  it('四种状态产出四个互不相同的标签', () => {
    const labels = CASES.map((c) => metaText(renderToStaticMarkup(<NodeCard code="N01" name="N01 节点" status={c.status} />)))
    expect(new Set(labels).size).toBe(4)
    expect(labels).toEqual(['未开始', '进行中', '已完成', '不适用'])
  })
})
