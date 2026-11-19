import {
  BarChart3,
  CalendarDays,
  ClipboardCheck,
  FolderKanban,
  LayoutDashboard,
  LayoutTemplate,
  ListChecks,
  Package,
  Search,
  Sparkles,
  Table2,
  Type,
  Bot, Workflow, Users, Monitor, Settings2,
  type LucideIcon,
} from "lucide-react"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { UserMenu } from "@/components/user-menu"
import type { PlatformAccount } from "@/lib/platform-api"

const planningItems = [
  { id: "overview", title: "总览", icon: LayoutDashboard },
  { id: "research", title: "调研项目", icon: Search },
  { id: "projects", title: "企划项目", icon: FolderKanban },
  { id: "reviews", title: "评审项目", icon: ClipboardCheck },
  { id: "progress", title: "企划进度", icon: ListChecks },
  { id: "exhibitions", title: "展会情况", icon: CalendarDays },
  { id: "templates", title: "模版管理", icon: LayoutTemplate },
  { id: "dashboard", title: "数据看板", icon: BarChart3 },
  { id: "outputs", title: "产出管理", icon: Package },
]

const capabilityItems = [
  { id: "table", title: "表格组件", icon: Table2 },
  { id: "interaction", title: "交互组件", icon: Sparkles },
  { id: "type", title: "文字", icon: Type },
]

const aiItems = [
  { id: "ai-worksite", title: "任务执行", icon: Workflow },
  { id: "ai-collab", title: "协作", icon: Users },
  { id: "ai-artifacts", title: "产出库", icon: Package },
  { id: "ai-templates", title: "工作方法", icon: LayoutTemplate },
  { id: "ai-runner", title: "执行器", icon: Monitor },
  { id: "ai-stats", title: "统计", icon: BarChart3 },
  { id: "ai-settings", title: "设置", icon: Settings2 },
]

export function AppSidebar({
  moduleId,
  activeId,
  onSelect,
  aiAdmin = false,
  account,
}: {
  moduleId: "planning" | "capabilities" | "ai"
  aiAdmin?: boolean
  account: PlatformAccount | null
  activeId: string
  onSelect: (id: string) => void
}) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="pointer-events-none">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground">
                {moduleId === "ai" ? <Bot className="size-5" /> : "企"}
              </span>
              <span className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">企划设计BG平台</span>
                <span className="truncate text-xs text-sidebar-foreground/80">{moduleId === "ai" ? "AI 调度中心" : moduleId === "planning" ? "产品企划中心" : "底层能力"}</span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarMenuList
          label={moduleId === "ai" ? "AI 调度中心" : moduleId === "planning" ? "业务菜单" : "底层能力"}
          items={moduleId === "ai" ? aiItems.filter(item => item.id !== "ai-stats" || aiAdmin) : moduleId === "planning" ? planningItems : capabilityItems}
          activeId={activeId}
          onSelect={onSelect}
        />
        {account?.role === "admin" && <SidebarMenuList label="工作空间管理" items={[{ id: "people", title: "人员管理", icon: Users }]} activeId={activeId} onSelect={onSelect} />}
      </SidebarContent>
      <SidebarFooter>
        <UserMenu compact account={account} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

function SidebarMenuList({
  label,
  items,
  activeId,
  onSelect,
}: {
  label: string
  items: { id: string; title: string; icon: LucideIcon }[]
  activeId: string
  onSelect: (id: string) => void
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel className="mb-1">{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu className="gap-2">
          {items.map((item) => (
            <SidebarMenuItem key={item.id}>
              <SidebarMenuButton
                className="h-9"
                isActive={item.id === activeId}
                tooltip={item.title}
                onClick={item.id.startsWith("ai-") || item.id === "overview" || item.id === "templates" || item.id === "people" || label === "底层能力" ? () => onSelect(item.id) : undefined}
              >
                <item.icon />
                <span>{item.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
