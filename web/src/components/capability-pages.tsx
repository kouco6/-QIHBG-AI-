import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

import { foundationComponents } from "@capability-ui/catalog"
import { DataTable, type DataColumn } from "@capability-table/data-table"

const sample = "产品企划中心　底层能力　0123456789　The quick brown fox"

const fonts = [
  {
    name: "Noto Sans SC",
    tag: "离线内置 · 当前正文",
    meta: "SIL Open Font License 1.1 · 字重 400 / 500 / 700 · 简体中文与拉丁字母",
    family: '"Noto Sans SC", sans-serif',
  },
  {
    name: "MiSans",
    tag: "离线内置 · 后备",
    meta: "小米 MiSans 可变字体子集 · 平台已随包安装",
    family: '"MiSans", sans-serif',
  },
  {
    name: "PingFang SC",
    tag: "系统字体 · 后备",
    meta: "苹方。只使用本机已安装的字体，不把字体文件放进平台。",
    family: '"PingFang SC", sans-serif',
  },
  {
    name: "Microsoft YaHei",
    tag: "系统字体 · 后备",
    meta: "微软雅黑。Windows 上没有前三种字体时使用。",
    family: '"Microsoft YaHei", sans-serif',
  },
]

export function TypePage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">文字</h1>
        <p className="text-sm text-muted-foreground">平台当前支持的字体</p>
      </div>
      <p className="text-sm text-muted-foreground">
        正文优先使用离线安装的 Noto Sans SC。后面的字体只在缺字时接上。
      </p>
      <div className="grid gap-4">
        {fonts.map((font) => (
          <Card key={font.name}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-3">
                {font.name}
                <span className="text-xs font-normal text-muted-foreground">{font.tag}</span>
              </CardTitle>
              <CardDescription>{font.meta}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-base" style={{ fontFamily: font.family }}>
                {sample}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

const columns = ["勾选", "名称", "说明", "金额", "占比", "日期", "等级", "链接", "测算"]
const rows = [
  ["", "建筑资质甲", "可原位修改的短说明。", "1,280.50", "12.5%", "2026-06-30", "高", "https://example.com/a", "36"],
  ["", "安全生产许可", "长文本在格内换行。", "860.00", "8%", "2027-01-15", "中", "https://example.com/b", "21"],
  ["", "行业认证", "测算列由调用方传入，表内不能改。", "240.00", "3%", "2026-12-01", "待核实", "https://example.com/c", "9"],
  ["", "检测报告", "", "", "", "", "低", "", ""],
]
const listDemo = [{ id: "one", name: "基础组件复用", category: "组件规范" }, { id: "two", name: "旧平台字段保留", category: "迁移规范" }, { id: "three", name: "浅深主题一致", category: "视觉规范" }]
const listColumns: DataColumn<typeof listDemo[number]>[] = [
  { id: "name", title: "名称", hideable: false, value: row => row.name, cell: row => row.name },
  { id: "category", title: "分类", value: row => row.category, cell: row => row.category },
]

export function TablePage() {
  const [focused, setFocused] = useState(false)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">表格组件</h1>
          <p className="text-sm text-muted-foreground">临时演示 · 可导出保留结果</p>
        </div>
        <Button variant="outline" onClick={() => setFocused((value) => !value)}>
          {focused ? "退出专注" : "专注表格"}
        </Button>
      </div>
      <div className="flex flex-wrap gap-2" aria-label="表格操作">
        <Button variant="outline">导入 CSV</Button>
        <Button variant="outline">导入 Excel</Button>
        <Button variant="outline">导出 CSV</Button>
        <Button variant="outline">导出 Excel</Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>记录</CardTitle>
          <CardDescription>临时演示 · 刷新后重置，请导出保留结果。</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b text-muted-foreground">
                {columns.map((column) => (
                  <th key={column} className="px-2 py-2 font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row[1]} className="border-b last:border-0">
                  {row.map((cell, index) => (
                    <td key={columns[index]} className="px-2 py-2">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-4 text-xs text-muted-foreground">编辑单元格后可在这里查看提交的行数据。</p>
        </CardContent>
      </Card>
      <Card><CardHeader><CardTitle>通用列表表格 · DataTable</CardTitle><CardDescription>人员管理使用同一实现，支持排序、列显示、当前页选择及分页。</CardDescription></CardHeader><CardContent className="min-w-0 space-y-3"><code className="text-xs text-muted-foreground">@capability-table/data-table</code><DataTable rows={listDemo} columns={listColumns} rowId={row => row.id} rowLabel={row => row.name} label="共享表格示例" minWidth={420} /></CardContent></Card>
    </div>
  )
}

const groups = [
  {
    title: "文字动画",
    items: [
      ["ShinyText", "首页用于侧栏「产品企划中心」。底色改为品牌深色，扫光改为浅品牌蓝，循环播放。"],
      ["CountUp", "首页只用于「在用 N 个」，逐位滚动。项目概览和数据看板的统计数字也用它。表格里的进度数字保持静态。"],
    ],
  },
  {
    title: "动画",
    items: [
      ["FadeContent", "内容第一次出现时淡入。用于十二维空状态、数据看板趋势、模版画布、展会列表和登录卡片。"],
      ["GlareHover", "悬停时光泽扫过主按钮。用于新建、确认创建、进入工作模式、应用模板、保存展会、登录和修改密码。"],
    ],
  },
  {
    title: "组件",
    items: [
      ["SpotlightCard", "浅色聚光卡片。首页只在「还没有企划项目」时使用，项目概览里用于最多三张待办维度卡。"],
      ["Stepper", "创建企划项目的三步：产品名称、产品类型、确认创建。"],
      ["AnimatedList", "列表项进入时依次出现。用于研究任务，以及模版管理版本抽屉里新导入的版本。"],
    ],
  },
  {
    title: "微交互",
    items: [
      ["RubberSegment", "首页用小号尺寸，选项是「在用项目 / 已归档项目」。数据看板的时间范围、十二维的视图切换也用它。"],
      ["StatusMark", "行内状态静止显示。归档、恢复、维度状态变化和研究任务变化时再变形。"],
      ["WarmTooltip", "悬停说明。用于顶栏按钮、概览操作、工作区图标、看板口径和登录页的保持登录。"],
      ["SwipeToast", "企划项目、创建、概览、十二维、看板、模版和展会的提示都用这个组件。关闭图标是内联图形。"],
      ["SquishSwitch", "模版管理的「临时操作」开关。默认关闭，打开后才允许在预览里临时修改。"],
      ["SpringCheck", "登录页「保持登录 7 天」的勾选。"],
    ],
  },
  {
    title: "背景",
    items: [["DotGrid", "首页只铺在空项目卡片里，点的颜色改浅，仍跟随指针。"]],
  },
]

export function InteractionPage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">交互组件</h1>
        <p className="text-sm text-muted-foreground">按来源分类 · 默认演示</p>
      </div>
      <section className="grid gap-3">
        <h2 className="text-lg font-semibold">基础组件 · shadcn</h2>
        <p className="text-sm text-muted-foreground">已纳入平台底层交互能力，模版管理、人员管理和后续页面共用同一实现。</p>
        <div className="grid gap-3 md:grid-cols-2">{foundationComponents.map(([id, name, title, description]) => <Card key={id}><CardHeader><CardTitle>{title} · {name}</CardTitle><CardDescription>{description}</CardDescription></CardHeader><CardContent><code className="text-xs text-muted-foreground">@capability-ui/{id}</code></CardContent></Card>)}</div>
      </section>
      {groups.map((group) => (
        <section key={group.title} className="grid gap-3">
          <h2 className="text-lg font-semibold">{group.title}</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {group.items.map(([name, text]) => (
              <Card key={name}>
                <CardHeader>
                  <CardTitle>{name}</CardTitle>
                  <CardDescription>{text}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
