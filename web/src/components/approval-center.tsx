import { useMemo, useState, type FormEvent } from "react"
import {
  ArrowLeft,
  BadgeCheck,
  CalendarDays,
  Check,
  CheckCheck,
  CircleCheck,
  CircleDot,
  Clock3,
  CornerDownLeft,
  FileText,
  Inbox,
  ListChecks,
  Paperclip,
  Search,
  ShieldCheck,
  Tag,
  X,
} from "lucide-react"

import { Avatar, AvatarFallback } from "@capability-ui/avatar"
import { Badge } from "@capability-ui/badge"
import { Button } from "@capability-ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@capability-ui/dialog"
import { Input } from "@capability-ui/input"
import { Textarea } from "@capability-ui/textarea"
import "./approval-center.css"

type ReviewStatus = "pending" | "approved" | "returned" | "rejected"
type ReviewAction = Exclude<ReviewStatus, "pending">
type Queue = "pending" | "processed" | "all"

type ReviewHistory = {
  actor: string
  action: string
  time: string
  note?: string
}

type ReviewEntry = {
  id: string
  title: string
  summary: string
  description: string
  submitter: string
  initials: string
  department: string
  submittedAt: string
  category: string
  status: ReviewStatus
  unread: boolean
  reference: string
  attachments: string[]
  history: ReviewHistory[]
}

const demoEntries: ReviewEntry[] = [
  {
    id: "REQ-2026-0148",
    title: "资料补充申请",
    summary: "补充本周更新的产品资料，供工作区成员查阅。",
    description: "申请补充一份已整理的资料，方便工作区成员在后续协作中查看。资料内容已完成初步核对，请审核是否可以加入共享资料区。",
    submitter: "林乔",
    initials: "林",
    department: "产品支持组",
    submittedAt: "今天 09:42",
    category: "资料补充",
    status: "pending",
    unread: false,
    reference: "资料条目 · 更新批次 11/20",
    attachments: ["资料补充说明.pdf", "内容清单.xlsx"],
    history: [{ actor: "林乔", action: "提交了申请", time: "今天 09:42" }],
  },
  {
    id: "REQ-2026-0147",
    title: "信息更新申请",
    summary: "需要更新工作区中一条共享信息的说明文字。",
    description: "现有说明与最新整理的信息不一致。申请将说明更新为附件中的版本，并保留原有条目编号，便于后续查阅。",
    submitter: "周亦宁",
    initials: "周",
    department: "方案协作组",
    submittedAt: "今天 09:18",
    category: "信息更新",
    status: "pending",
    unread: true,
    reference: "共享信息 · 条目 0286",
    attachments: ["信息更新对照.docx"],
    history: [{ actor: "周亦宁", action: "提交了申请", time: "今天 09:18" }],
  },
  {
    id: "REQ-2026-0146",
    title: "内容修订申请",
    summary: "修订一处协作说明中的表述，已附修改前后对照。",
    description: "申请对一处协作说明进行文字修订。修改仅涉及表达方式，不改变原有内容含义；具体差异已整理在附件中。",
    submitter: "陈昕",
    initials: "陈",
    department: "项目协作组",
    submittedAt: "今天 08:56",
    category: "内容修订",
    status: "pending",
    unread: true,
    reference: "协作说明 · 第 4 节",
    attachments: ["修订对照.pdf"],
    history: [{ actor: "陈昕", action: "提交了申请", time: "今天 08:56" }],
  },
  {
    id: "REQ-2026-0145",
    title: "共享资源申请",
    summary: "申请将一份演示资源加入团队共享目录。",
    description: "该资源已完成基础检查，申请加入团队共享目录供工作区成员使用。请核对资源描述和适用范围。",
    submitter: "何嘉",
    initials: "何",
    department: "协作支持组",
    submittedAt: "昨天 17:36",
    category: "资源申请",
    status: "pending",
    unread: true,
    reference: "共享目录 · 新增条目",
    attachments: ["资源说明.txt"],
    history: [{ actor: "何嘉", action: "提交了申请", time: "昨天 17:36" }],
  },
  {
    id: "REQ-2026-0144",
    title: "资料补充申请",
    summary: "申请补充一份规范说明及其版本记录。",
    description: "申请补充资料说明和对应版本记录，便于成员确认当前使用的版本。",
    submitter: "许清",
    initials: "许",
    department: "产品支持组",
    submittedAt: "昨天 16:20",
    category: "资料补充",
    status: "approved",
    unread: false,
    reference: "资料条目 · 新增版本",
    attachments: ["版本说明.pdf"],
    history: [
      { actor: "许清", action: "提交了申请", time: "昨天 16:20" },
      { actor: "当前管理员", action: "模拟通过", time: "昨天 16:48", note: "资料内容完整。" },
    ],
  },
  {
    id: "REQ-2026-0143",
    title: "信息更新申请",
    summary: "申请更新一条共享信息的负责人和联系方式。",
    description: "申请更新共享信息的负责人和联系渠道。需要补充变更依据后再提交审核。",
    submitter: "赵宁",
    initials: "赵",
    department: "工作区运营组",
    submittedAt: "昨天 14:05",
    category: "信息更新",
    status: "returned",
    unread: false,
    reference: "共享信息 · 条目 0241",
    attachments: ["变更说明.docx"],
    history: [
      { actor: "赵宁", action: "提交了申请", time: "昨天 14:05" },
      { actor: "当前管理员", action: "模拟退回补充", time: "昨天 14:32", note: "请补充本次变更的依据。" },
    ],
  },
  {
    id: "REQ-2026-0142",
    title: "内容修订申请",
    summary: "申请调整一段共享说明的标题与展示顺序。",
    description: "申请调整共享说明的标题与展示顺序。经核对，本次修改与当前共享规范不一致。",
    submitter: "宋妍",
    initials: "宋",
    department: "方案协作组",
    submittedAt: "周三 11:12",
    category: "内容修订",
    status: "rejected",
    unread: false,
    reference: "共享说明 · 修订记录",
    attachments: ["修订内容.docx"],
    history: [
      { actor: "宋妍", action: "提交了申请", time: "周三 11:12" },
      { actor: "当前管理员", action: "模拟驳回", time: "周三 11:46", note: "本次修改与当前共享规范不一致。" },
    ],
  },
]

const categories = ["资料补充", "信息更新", "内容修订", "资源申请"]

const queueOptions: { id: Queue; label: string; icon: typeof Inbox }[] = [
  { id: "pending", label: "待审核", icon: Inbox },
  { id: "processed", label: "已处理", icon: CheckCheck },
  { id: "all", label: "全部事项", icon: ListChecks },
]

const actionLabel: Record<ReviewAction, string> = {
  approved: "通过",
  returned: "退回补充",
  rejected: "驳回",
}

const statusLabel: Record<ReviewStatus, string> = {
  pending: "待审核",
  approved: "已通过",
  returned: "已退回",
  rejected: "已驳回",
}

function StatusBadge({ status }: { status: ReviewStatus }) {
  return <Badge className={"approval-status-badge is-" + status}>{statusLabel[status]}</Badge>
}

function initialsFor(name: string) {
  return name.trim().slice(0, 1) || "用"
}

function matchesSearch(item: ReviewEntry, value: string) {
  const normalized = value.trim().toLocaleLowerCase()
  if (!normalized) return true
  return [item.title, item.submitter, item.department, item.summary, item.category, item.id].join(" ").toLocaleLowerCase().includes(normalized)
}

export function ApprovalCenter() {
  const [items, setItems] = useState<ReviewEntry[]>(() => demoEntries.map(item => ({ ...item, attachments: [...item.attachments], history: [...item.history] })))
  const [queue, setQueue] = useState<Queue>("pending")
  const [selectedId, setSelectedId] = useState(demoEntries[0].id)
  const [selectedCategory, setSelectedCategory] = useState("")
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [query, setQuery] = useState("")
  const [reviewDialog, setReviewDialog] = useState<ReviewAction | null>(null)
  const [decisionNote, setDecisionNote] = useState("")
  const [decisionError, setDecisionError] = useState("")
  const [notice, setNotice] = useState("")
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)

  const pendingCount = items.filter(item => item.status === "pending").length
  const processedCount = items.filter(item => item.status !== "pending").length
  const unreadCount = items.filter(item => (queue === "all" || (queue === "pending" ? item.status === "pending" : item.status !== "pending")) && (!selectedCategory || item.category === selectedCategory) && item.unread).length
  const selected = items.find(item => item.id === selectedId) ?? null

  const filteredItems = useMemo(() => {
    return items.filter(item => {
      const inQueue = queue === "all" || (queue === "pending" ? item.status === "pending" : item.status !== "pending")
      const inCategory = !selectedCategory || item.category === selectedCategory
      const matchesUnread = !unreadOnly || item.unread
      return inQueue && inCategory && matchesUnread && matchesSearch(item, query)
    })
  }, [items, query, queue, selectedCategory, unreadOnly])

  const selectQueue = (nextQueue: Queue) => {
    setQueue(nextQueue)
    setSelectedCategory("")
    setUnreadOnly(false)
    setNotice("")
    const firstMatch = items.find(item => matchesSearch(item, query) && (nextQueue === "all" || (nextQueue === "pending" ? item.status === "pending" : item.status !== "pending")))
    setSelectedId(firstMatch?.id ?? "")
    setMobileDetailOpen(false)
  }

  const selectItem = (item: ReviewEntry) => {
    setSelectedId(item.id)
    setItems(current => current.map(entry => entry.id === item.id ? { ...entry, unread: false } : entry))
    setUnreadOnly(false)
    setNotice("")
    setMobileDetailOpen(true)
  }

  const openDecision = (action: ReviewAction) => {
    setDecisionNote("")
    setDecisionError("")
    setReviewDialog(action)
  }

  const submitDecision = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selected || !reviewDialog || selected.status !== "pending") return
    const note = decisionNote.trim()
    if (reviewDialog !== "approved" && !note) {
      setDecisionError("请填写处理意见。")
      return
    }
    const currentId = selected.id
    const historyEntry: ReviewHistory = {
      actor: "当前管理员",
      action: "模拟" + actionLabel[reviewDialog],
      time: "刚刚",
      ...(note ? { note } : {}),
    }
    setItems(current => current.map(item => item.id === currentId
      ? { ...item, status: reviewDialog, unread: false, history: [...item.history, historyEntry] }
      : item))
    setNotice("演示操作已更新：" + actionLabel[reviewDialog] + "。数据仅保留在当前页面。")

    const nextVisiblePending = filteredItems.find(item => item.id !== currentId && item.status === "pending")
    const nextPending = nextVisiblePending ?? items.find(item => item.id !== currentId && item.status === "pending")
    if (queue === "pending" && nextPending) {
      setSelectedId(nextPending.id)
      setUnreadOnly(false)
    } else if (queue === "pending") {
      setQueue("processed")
      setSelectedId(currentId)
      setMobileDetailOpen(false)
    }
    setReviewDialog(null)
    setDecisionNote("")
    setDecisionError("")
  }

  const queueTitle = queueOptions.find(option => option.id === queue)?.label ?? "待审核"

  return (
    <section className={"approval-center" + (mobileDetailOpen ? " mobile-detail-open" : "")} aria-label="审核中心">
      <aside className="approval-queue-pane" aria-label="审核队列导航">
        <div className="approval-brand">
          <span className="approval-brand-icon"><ShieldCheck className="size-5" /></span>
          <span className="approval-brand-copy"><strong>审核中心</strong><small>工作空间管理</small></span>
        </div>
        <div className="approval-nav-section">
          <p className="approval-section-label">工作队列</p>
          <nav className="approval-folder-list" aria-label="事项状态">
            {queueOptions.map(option => {
              const Icon = option.icon
              const count = option.id === "pending" ? pendingCount : option.id === "processed" ? processedCount : items.length
              return <button key={option.id} type="button" className={"approval-folder-button" + (queue === option.id && !selectedCategory ? " is-active" : "")} aria-current={queue === option.id && !selectedCategory ? "page" : undefined} onClick={() => selectQueue(option.id)}>
                <Icon className="size-4" />
                <span>{option.label}</span>
                <span className="approval-folder-count">{count}</span>
              </button>
            })}
          </nav>
        </div>
        <div className="approval-nav-section approval-label-section">
          <div className="approval-section-heading"><p className="approval-section-label">事项标签</p><Tag className="size-3.5" /></div>
          <nav className="approval-category-list" aria-label="事项类型">
            {categories.map(category => {
              const count = items.filter(item => item.category === category && (queue === "all" || (queue === "pending" ? item.status === "pending" : item.status !== "pending"))).length
              return <button type="button" key={category} className={"approval-category-button" + (selectedCategory === category ? " is-active" : "")} aria-pressed={selectedCategory === category} onClick={() => {
                const nextCategory = selectedCategory === category ? "" : category
                setSelectedCategory(nextCategory)
                setUnreadOnly(false)
                setNotice("")
                const nextItem = items.find(item => matchesSearch(item, query) && (!nextCategory || item.category === nextCategory) && (queue === "all" || (queue === "pending" ? item.status === "pending" : item.status !== "pending")))
                setSelectedId(nextItem?.id ?? "")
                setMobileDetailOpen(false)
              }}>
                <span className={"approval-category-dot category-" + categories.indexOf(category)} />
                <span>{category}</span><span className="approval-category-count">{count}</span>
              </button>
            })}
          </nav>
        </div>
        <div className="approval-demo-note"><span className="approval-demo-dot" /><span>合成演示数据 · 不会写入服务端</span></div>
      </aside>

      <nav className="approval-mobile-folders" aria-label="事项状态">
        {queueOptions.map(option => {
          const count = option.id === "pending" ? pendingCount : option.id === "processed" ? processedCount : items.length
          return <button type="button" key={option.id} className={queue === option.id && !selectedCategory ? "is-active" : ""} aria-current={queue === option.id && !selectedCategory ? "page" : undefined} onClick={() => selectQueue(option.id)}>
            {option.label}<span>{count}</span>
          </button>
        })}
      </nav>

      <section className="approval-list-pane" aria-label="审核事项列表">
        <header className="approval-list-header">
          <div className="approval-list-title-row">
            <div><h1>{selectedCategory || queueTitle}</h1><p>{queue === "pending" ? "需要审核的工作事项" : queue === "processed" ? "已完成处理的演示事项" : "工作区内的全部演示事项"}</p></div>
            <Badge variant="secondary" className="approval-total-count">{filteredItems.length}</Badge>
          </div>
          <div className="approval-search-wrap"><Search className="size-4" /><Input type="search" aria-label="搜索事项、申请人或编号" placeholder="搜索事项…" value={query} onChange={event => { const nextQuery = event.target.value; setQuery(nextQuery); const first = items.find(item => matchesSearch(item, nextQuery) && (!selectedCategory || item.category === selectedCategory) && (!unreadOnly || item.unread) && (queue === "all" || (queue === "pending" ? item.status === "pending" : item.status !== "pending"))); setSelectedId(first?.id ?? "") }} /></div>
          <div className="approval-list-filters" role="group" aria-label="列表筛选">
            <button type="button" className={!unreadOnly ? "is-active" : ""} aria-pressed={!unreadOnly} onClick={() => { setUnreadOnly(false); const first = items.find(item => matchesSearch(item, query) && (!selectedCategory || item.category === selectedCategory) && (queue === "all" || (queue === "pending" ? item.status === "pending" : item.status !== "pending"))); setSelectedId(first?.id ?? "") }}>全部</button>
            <button type="button" className={unreadOnly ? "is-active" : ""} aria-pressed={unreadOnly} onClick={() => { const next = !unreadOnly; setUnreadOnly(next); if (next) { const first = items.find(item => item.unread && matchesSearch(item, query) && (!selectedCategory || item.category === selectedCategory) && (queue === "all" || (queue === "pending" ? item.status === "pending" : item.status !== "pending"))); setSelectedId(first?.id ?? "") } }}>未读 <span>{unreadCount}</span></button>
          </div>
        </header>
        {notice && <div className="approval-notice" role="status"><CircleCheck className="size-4" /><span>{notice}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice("")}><X className="size-4" /></button></div>}
        <div className="approval-list-scroll" aria-label="审核事项列表">
          {filteredItems.length ? filteredItems.map(item => <button type="button" key={item.id} className={"approval-list-item" + (selectedId === item.id ? " is-selected" : "") + (item.unread ? " is-unread" : "")} aria-pressed={selectedId === item.id} onClick={() => selectItem(item)}>
            <span className="approval-row-top"><span className="approval-sender">{item.unread && <span className="approval-unread-dot" aria-label="未读" />}{item.submitter}</span><span className="approval-row-date">{item.submittedAt}</span></span>
            <span className="approval-row-title">{item.title}</span>
            <span className="approval-row-summary">{item.summary}</span>
            <span className="approval-row-bottom"><Badge className="approval-category-badge">{item.category}</Badge>{item.status !== "pending" && <StatusBadge status={item.status} />}<span className="approval-row-id">{item.id}</span></span>
          </button>) : <div className="approval-empty"><Search className="size-5" /><strong>没有找到事项</strong><span>试试其他关键词或筛选条件。</span><Button variant="ghost" size="sm" onClick={() => { setQuery(""); setSelectedCategory(""); setUnreadOnly(false) }}>清除筛选</Button></div>}
        </div>
        <footer className="approval-list-footer"><span>{filteredItems.length} 项事项</span><span><span className="approval-footer-dot" />演示数据</span></footer>
      </section>

      <article className="approval-detail-pane" aria-label={selected ? "事项详情：" + selected.title : "事项详情"}>
        {selected ? <>
          <div className="approval-detail-toolbar">
            <Button variant="ghost" size="icon-sm" className="approval-mobile-back" aria-label="返回事项列表" onClick={() => setMobileDetailOpen(false)}><ArrowLeft /></Button>
            <span className="approval-detail-location"><Inbox className="size-4" />{queueTitle}<span>/</span>{selected.id}</span>
            <div className="approval-detail-actions-top"><Button variant="ghost" size="icon-sm" aria-label={selected.unread ? "标记为已读" : "标记为未读"} title={selected.unread ? "标记为已读" : "标记为未读"} onClick={() => setItems(current => current.map(item => item.id === selected.id ? { ...item, unread: !item.unread } : item))}><CircleDot /></Button></div>
          </div>
          <div className="approval-detail-scroll">
            <div className="approval-detail-heading">
              <div className="approval-detail-title-line"><h2>{selected.title}</h2><StatusBadge status={selected.status} /></div>
              <div className="approval-detail-ref"><FileText className="size-4" /><span>{selected.reference}</span><span className="approval-detail-ref-dot">·</span><span>{selected.id}</span></div>
            </div>

            <div className="approval-submitter-card">
              <Avatar><AvatarFallback>{selected.initials || initialsFor(selected.submitter)}</AvatarFallback></Avatar>
              <div className="approval-submitter-copy"><strong>{selected.submitter}</strong><span>{selected.department}</span></div>
              <div className="approval-submitted-time"><CalendarDays className="size-4" /><span>{selected.submittedAt}</span></div>
            </div>

            <section className="approval-detail-section" aria-labelledby="approval-info-title">
              <div className="approval-section-title-row"><h3 id="approval-info-title">申请信息</h3><span>{selected.category}</span></div>
              <div className="approval-info-grid">
                <div><span>事项类型</span><strong>{selected.category}</strong></div>
                <div><span>申请编号</span><strong>{selected.id}</strong></div>
                <div><span>提交时间</span><strong>{selected.submittedAt}</strong></div>
              </div>
              <p className="approval-request-body">{selected.description}</p>
              <div className="approval-attachment-heading"><span>附件</span><span>{selected.attachments.length} 个文件</span></div>
              <div className="approval-attachments">{selected.attachments.map(file => <span className="approval-attachment" key={file}><Paperclip className="size-3.5" /><span>{file}</span></span>)}</div>
            </section>

            <section className="approval-detail-section approval-history-section" aria-labelledby="approval-history-title">
              <div className="approval-history-title"><h3 id="approval-history-title">审核记录</h3><span>{selected.history.length}</span></div>
              <ol className="approval-history-list">
                {selected.history.map((entry, index) => <li key={entry.actor + entry.time + index} className={index === selected.history.length - 1 ? "is-latest" : ""}>
                  <span className="approval-history-marker">{index === selected.history.length - 1 && selected.status !== "pending" ? <BadgeCheck className="size-3.5" /> : <span />}</span>
                  <div className="approval-history-content"><div><strong>{entry.actor}</strong><span>{entry.action}</span><time>{entry.time}</time></div>{entry.note && <p>{entry.note}</p>}</div>
                </li>)}
              </ol>
            </section>

            <div className="approval-detail-disclaimer"><Clock3 className="size-3.5" />这是一条合成演示事项，审核操作仅影响当前页面。</div>
          </div>

          {selected.status === "pending" ? <footer className="approval-decision-bar">
            <div className="approval-decision-hint"><CircleDot className="size-3.5" /><span>选择处理方式</span></div>
            <div className="approval-decision-buttons"><Button variant="outline" onClick={() => openDecision("returned")}><CornerDownLeft />退回补充</Button><Button variant="destructive" onClick={() => openDecision("rejected")}><X />驳回</Button><Button onClick={() => openDecision("approved")}><Check />通过</Button></div>
          </footer> : <footer className="approval-processed-bar"><CircleCheck className="size-4" /><span>该事项已处理 · {statusLabel[selected.status]}</span></footer>}
        </> : <div className="approval-empty approval-detail-empty"><Inbox className="size-6" /><strong>选择一项审核事项</strong><span>从左侧列表打开详情。</span></div>}
      </article>

      <Dialog open={!!reviewDialog} onOpenChange={open => { if (!open) { setReviewDialog(null); setDecisionNote(""); setDecisionError("") } }}>
        <DialogContent className="approval-decision-dialog">
          <DialogHeader>
            <DialogTitle>{reviewDialog ? "确认" + actionLabel[reviewDialog] : "处理审核"} · {selected?.title}</DialogTitle>
            <DialogDescription>本次操作只更新当前页面中的演示状态，不会保存或提交至服务端。</DialogDescription>
          </DialogHeader>
          <form onSubmit={submitDecision} className="approval-decision-form">
            <label htmlFor="approval-decision-note">处理意见{reviewDialog === "approved" ? "（选填）" : ""}</label>
            <Textarea id="approval-decision-note" autoFocus required={reviewDialog !== "approved"} maxLength={300} rows={4} placeholder={reviewDialog === "approved" ? "补充说明…" : "请说明处理原因…"} value={decisionNote} aria-invalid={!!decisionError} onChange={event => { setDecisionNote(event.target.value); setDecisionError("") }} />
            {decisionError && <p className="approval-decision-error" role="alert">{decisionError}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setReviewDialog(null)}>取消</Button>
              <Button type="submit" variant={reviewDialog === "rejected" ? "destructive" : "default"} disabled={!reviewDialog}>{reviewDialog ? "确认" + actionLabel[reviewDialog] : "确认"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  )
}
