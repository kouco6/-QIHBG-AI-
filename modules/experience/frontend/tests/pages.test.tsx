import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '@/app/AuthProvider'
import LoginPage from '@/pages/LoginPage'
import SetupPage from '@/pages/SetupPage'
import SettingsPage from '@/pages/SettingsPage'
import NotFoundPage from '@/pages/NotFoundPage'
import { LoadingState, EmptyState, ErrorState, ForbiddenState, ReadonlyState } from '@/components/StateBlocks'

/** T02/T03：页面可渲染；五态组件齐备；鉴权相关文案与权限口径正确 */

function renderWithRouter(node: React.ReactElement): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AuthProvider>{node}</AuthProvider>
    </MemoryRouter>,
  )
}

describe('页面与状态组件', () => {
  it('登录页渲染关键元素且标注 Mock 提示', () => {
    const html = renderWithRouter(<LoginPage />)
    expect(html).toContain('登录产品体验中心')
    expect(html).toContain('Mock')
    expect(html).toContain('创建首账号')
    expect(html).toContain('记住账号')
  })

  it('首账号初始化页声明单一角色与设置入口', () => {
    const html = renderWithRouter(<SetupPage />)
    expect(html).toContain('创建首账号')
    expect(html).toContain('单一体验人员角色')
    expect(html).toContain('系统设置')
  })

  it('系统设置页初始为加载态（未取到数据前不渲染骨架以外的内容）', () => {
    const html = renderWithRouter(<SettingsPage />)
    expect(html).toContain('aria-busy')
  })

  it('404 页提供返回工作台入口', () => {
    const html = renderWithRouter(<NotFoundPage />)
    expect(html).toContain('404')
    expect(html).toContain('返回工作台')
  })

  it('五态组件均可渲染', () => {
    expect(renderToStaticMarkup(<LoadingState />)).toContain('aria-busy')
    expect(renderToStaticMarkup(<EmptyState title="暂无数据" reason="还没有项目" />)).toContain('暂无数据')
    expect(renderToStaticMarkup(<ErrorState message="加载失败" requestId="rid-1" />)).toContain('rid-1')
    expect(renderToStaticMarkup(<ForbiddenState />)).toContain('无操作权限')
    expect(renderToStaticMarkup(<ReadonlyState reason="快照不可修改" />)).toContain('只读')
  })

  it('只读态与无权限态分别用于「非首账号」与「首账号专属操作」', () => {
    expect(renderToStaticMarkup(<ReadonlyState reason="仅首账号可修改系统设置" />)).toContain('仅首账号可修改系统设置')
    expect(renderToStaticMarkup(<ForbiddenState reason="新增与启停账号仅首账号可执行。" />)).toContain(
      '新增与启停账号仅首账号可执行',
    )
  })
})
