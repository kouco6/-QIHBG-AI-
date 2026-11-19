# 平台交互能力

`src/bits` 保留既有动画与微交互组件。`src/ui` 为统一 shadcn/Radix 基础组件实现，包含按钮、弹窗、抽屉、选择器、操作菜单、滚动区及列表筛选等能力。完整组件清单维护在 `src/ui/catalog.ts`，平台「底层能力 → 交互组件」同步展示。

业务页面使用统一入口：

```tsx
import { Button } from "@capability-ui/button"
import { Select } from "@capability-ui/select"

<Select label="选择维度" value={value} onValueChange={setValue}
  options={[{ value: "DIM-01", label: "01 产品线齐全" }]} />
```

当前宿主 `web/vite.config.ts`、`tsconfig.app.json` 已配置别名与宿主依赖解析；`web/src/index.css` 使用 `@source` 扫描共享目录，避免迁移后缺失 Tailwind 样式。复用到其他宿主时需配置同等入口、依赖和样式扫描。组件使用宿主 CSS 主题变量，不携带业务颜色。

优先选用已有组件；缺失时使用现有 shadcn/Radix 依赖补齐，并更新清单、说明及能力中心。`web/src/components/ui` 只转导出共享实现，保持旧页面兼容。

模版管理已复用 `SquishSwitch` 及共享 Button、Dialog、Sheet、Select、DropdownMenu、ScrollArea。十二维正文保持原表格布局及数据协议；复杂表格不做无条件替换。

人员管理补齐 Checkbox、Popover、Badge、Table、FacetedFilter，继续使用项目现有 Radix 依赖和 shadcn 组件约定。`FacetedFilter` 接收 `title`、`options: {value, label, count?}[]`、`selected: string[]` 和 `onChange`，支持搜索、多选、计数摘要及清除。通用管理列表使用 [共享 DataTable](../表格组件/README.md)，业务接口仍由页面负责。

AI 调度等保留原生业务控制器的迁移页使用统一适配入口：

```ts
import { enhanceNativeControls } from "@capability-ui/native-controls"
const dispose = enhanceNativeControls(document.body)
// 页面卸载时调用 dispose()
```

该适配器直接调用共享 `buttonVariants`、`inputClasses`、`textareaClasses`，不复制组件实现；监听动态插入或重新赋 class 的控件，保留原节点、输入值、事件及业务控制器。复杂页签和业务布局继续由页面负责。React 页面继续直接使用 Button、Input、Textarea 和 Dialog；不得用适配器替代新建 React 页面的组件复用。

原生表单需要弹窗时使用 `@capability-ui/native-dialog` 的 `openNativeDialog({title, subtitle, body, footer, onMount, width})`，返回 `{promise, close}`；表单 DOM 回调通过 `onMount({panel, close, onEnter})` 绑定。外观、遮罩、焦点与 Esc 使用共享 Radix Dialog，调用方继续处理数据与业务事件。HTML 只接收既有应用已转义的模板，不接收远程原始标记。
