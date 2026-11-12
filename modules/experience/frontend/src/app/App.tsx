/**
 * 应用外壳与路由（T14 全局 UI 收口）。
 *
 * 路由规则：
 * - 数据库无账号 → 强制进入 /setup 创建首账号；
 * - 已有账号但未登录 → 一律重定向 /login；
 * - 已登录 → 进入业务页面；/login、/setup 自动回工作台。
 * 全部业务路由渲染于 AppShell 内，并挂载 CurrentProject / Toast 上下文。
 */

import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import AppShell from './AppShell'
import { CurrentProjectProvider } from './CurrentProject'
import { ToastProvider } from '@/components/Toast'
import { useAuth } from './AuthProvider'
import LoginPage from '@/pages/LoginPage'
import SetupPage from '@/pages/SetupPage'
import WorkbenchPage from '@/pages/WorkbenchPage'
import SettingsPage from '@/pages/SettingsPage'
import NotFoundPage from '@/pages/NotFoundPage'

import SearchPage from '@/pages/SearchPage'
import ProjectsListPage from '@/pages/ProjectsListPage'
import ProjectDetailPage from '@/pages/ProjectDetailPage'
import BoardPage from '@/pages/BoardPage'
import NodeDetailPage from '@/pages/NodeDetailPage'
import ArtifactEditorPage from '@/pages/ArtifactEditorPage'
import ArtifactVersionsPage from '@/pages/ArtifactVersionsPage'
import IssuesPage from '@/pages/IssuesPage'
import IssueDetailPage from '@/pages/IssueDetailPage'
import ReviewsPage from '@/pages/ReviewsPage'
import ReviewWorkspacePage from '@/pages/ReviewWorkspacePage'
import UeiPreviewPage from '@/pages/UeiPreviewPage'
import L1SnapshotPage from '@/pages/L1SnapshotPage'
import ScoringSchemesPage from '@/pages/ScoringSchemesPage'
import DictionaryPage from '@/pages/DictionaryPage'
import UsabilityPage from '@/pages/UsabilityPage'
import UsabilityDetailPage from '@/pages/UsabilityDetailPage'
import CollaborationPage from '@/pages/CollaborationPage'
import AiPage from '@/pages/AiPage'
import ProviderJobsPage from '@/pages/ProviderJobsPage'
import SystemsPage from '@/pages/SystemsPage'
import SystemDetailPage from '@/pages/SystemDetailPage'
import SystemAnalyticsPage from '@/pages/SystemAnalyticsPage'
import L2SnapshotPage from '@/pages/L2SnapshotPage'
import ComparePage from '@/pages/ComparePage'
import BeiPage from '@/pages/BeiPage'
import BeiDetailPage from '@/pages/BeiDetailPage'
import ScoreLibraryPage from '@/pages/ScoreLibraryPage'
import AuditPage from '@/pages/AuditPage'

export default function App() {
  const location = useLocation()
  const { account, bootstrap, loading } = useAuth()
  const isBare = location.pathname === '/login' || location.pathname === '/setup'

  if (loading) {
    return (
      <div className="login-page">
        <div className="login-card" role="status" aria-busy="true">
          <div className="skeleton" style={{ width: '60%', height: 20 }} />
          <div className="skeleton" style={{ marginTop: 12 }} />
          <div className="skeleton" style={{ marginTop: 8, width: '80%' }} />
        </div>
      </div>
    )
  }

  if (bootstrap?.needs_setup && !account) {
    return (
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    )
  }

  if (isBare) {
    if (account) return <Navigate to="/" replace />
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  if (!account) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  return (
    <CurrentProjectProvider>
      <ToastProvider>
        <AppShell>
          <Routes>
            <Route path="/" element={<WorkbenchPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/projects" element={<ProjectsListPage />} />
            <Route path="/projects/:id" element={<ProjectDetailPage />} />
            <Route path="/projects/:id/board" element={<BoardPage />} />
            <Route path="/projects/:id/nodes/:code" element={<NodeDetailPage />} />
            <Route path="/projects/:id/scores/preview" element={<UeiPreviewPage />} />
            <Route path="/projects/:id/collaboration" element={<CollaborationPage />} />
            <Route path="/artifacts/:id/edit" element={<ArtifactEditorPage />} />
            <Route path="/artifacts/:id/versions" element={<ArtifactVersionsPage />} />
            <Route path="/issues" element={<IssuesPage />} />
            <Route path="/issues/:id" element={<IssueDetailPage />} />
            <Route path="/reviews" element={<ReviewsPage />} />
            <Route path="/reviews/:id" element={<ReviewWorkspacePage />} />
            <Route path="/scores/project-score-snapshots/:snapshotId" element={<L1SnapshotPage />} />
            <Route path="/settings/scoring-schemes" element={<ScoringSchemesPage />} />
            <Route path="/dictionaries/:type" element={<DictionaryPage />} />
            <Route path="/usability" element={<UsabilityPage />} />
            <Route path="/usability/:id" element={<UsabilityDetailPage />} />
            <Route path="/systems" element={<SystemsPage />} />
            <Route path="/systems/compare" element={<ComparePage />} />
            <Route path="/systems/:id" element={<SystemDetailPage />} />
            <Route path="/systems/:id/analytics" element={<SystemAnalyticsPage />} />
            <Route path="/scores/system-snapshots/:snapshotId" element={<L2SnapshotPage />} />
            <Route path="/divisions/bei" element={<BeiPage />} />
            <Route path="/divisions/:id/bei/:period" element={<BeiDetailPage />} />
            <Route path="/score-library" element={<ScoreLibraryPage />} />
            <Route path="/provider-jobs" element={<ProviderJobsPage />} />
            <Route path="/ai" element={<AiPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/settings/audit" element={<AuditPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </AppShell>
      </ToastProvider>
    </CurrentProjectProvider>
  )
}
