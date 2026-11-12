import { Link } from 'react-router-dom'

export default function NotFoundPage() {
  return (
    <div className="state-block" role="alert">
      <div className="state-block__title">页面不存在（404）</div>
      <div>该地址不存在，或页面已迁移。</div>
      <div style={{ marginTop: 12 }}>
        <Link className="btn" to="/">
          返回工作台
        </Link>
      </div>
    </div>
  )
}
