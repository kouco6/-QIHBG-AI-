import { Bar, BarChart, CartesianGrid, XAxis } from "recharts"
import { CircleCheck, FolderKanban, Layers, ListTodo } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"

const metrics = [
  { title: "在用项目", value: "12", note: "较上月 +2", icon: FolderKanban },
  { title: "已应用维度", value: "86", note: "分布在 12 个项目", icon: Layers },
  { title: "待确认研究", value: "5", note: "等待确认后写入", icon: ListTodo },
  { title: "本期完成", value: "3", note: "本月首次归档", icon: CircleCheck },
]

const months = [
  { month: "1月", archived: 18 },
  { month: "2月", archived: 22 },
  { month: "3月", archived: 19 },
  { month: "4月", archived: 28 },
  { month: "5月", archived: 24 },
  { month: "6月", archived: 32 },
  { month: "7月", archived: 30 },
  { month: "8月", archived: 36 },
  { month: "9月", archived: 29 },
  { month: "10月", archived: 34 },
  { month: "11月", archived: 40 },
  { month: "12月", archived: 38 },
]

const chartConfig = {
  archived: { label: "首次归档", color: "var(--chart-1)" },
} satisfies ChartConfig

const projects = [
  { name: "高清矩阵系统", type: "系统", time: "今天 10:20", mark: "矩" },
  { name: "会议音频处理器", type: "单品", time: "昨天 16:05", mark: "会" },
  { name: "无线会议终端", type: "单品", time: "11月17日", mark: "无" },
  { name: "分布式坐席", type: "系统", time: "11月15日", mark: "分" },
  { name: "中控主机", type: "单品", time: "11月12日", mark: "中" },
]

export function Overview() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">总览</h1>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((item) => (
          <Card key={item.title}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{item.title}</CardTitle>
              <item.icon className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{item.value}</div>
              <p className="text-xs text-muted-foreground">{item.note}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-7">
        <Card className="lg:col-span-4">
          <CardHeader>
            <CardTitle>首次归档</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={chartConfig} className="aspect-auto h-[320px] w-full">
              <BarChart data={months}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="archived" fill="var(--color-archived)" radius={4} />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>最近企划项目</CardTitle>
            <CardDescription>最近更新的 5 个项目。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            {projects.map((project) => (
              <div key={project.name} className="flex items-center gap-4">
                <Avatar className="size-9">
                  <AvatarFallback>{project.mark}</AvatarFallback>
                </Avatar>
                <div className="grid flex-1 leading-tight">
                  <span className="text-sm font-medium">{project.name}</span>
                  <span className="text-xs text-muted-foreground">{project.type}</span>
                </div>
                <span className="text-xs text-muted-foreground">{project.time}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
