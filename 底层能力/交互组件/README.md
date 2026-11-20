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


任务执行迁移补充：`@capability-ui/native-forms` 的 `enhanceNativeForms(root, selector)` 在限定范围内挂载共享 Select / Checkbox；保留原 select/input 节点、value/checked、FormData 和 input/change，监听动态选项、禁用和重绘，并在原节点移除后卸载 React root。显式属性赋值且没有 DOM 变更/事件时可调用返回值的 `refresh()`；卸载时调用 `dispose()`。桥接保留原生单选下拉，不处理 multiple 或 radio；选择值允许空串，内部编码仅供共享控件使用，不进入业务协议。

`@capability-ui/native-surfaces` 的 `mountNativeSheet(content, onClose)` 复用 Sheet 的遮罩和焦点管理，保留业务正文 DOM 与监听；返回 `setOpen` / `dispose`。触发元素会重绘时使用稳定的 `data-native-focus-key`，关闭后可回到同一记录的新节点。`createNativeMenu(label, buttons)` 复用 DropdownMenu，并继续调用原操作按钮的点击处理；宿主移除时自动清理。

原生按钮可以声明 `data-native-size="content"` 以保留任务摘要、多行记录和小图标的业务尺寸。适配器正确区分 primary / danger / ghost / text-btn / icon-btn，不再把共享 React 按钮、复选框或选择器触发器二次改成 outline。共享 Button 新增 `content` 尺寸，不携带固定高度和水平内边距。

### 原生控制器的舒适密度

`@capability-ui/native-layout.css` 配合 `data-native-layout="comfortable"`，统一14px正文、13px辅助文字、40px输入/选择/操作控件；多行内容按钮自适应高度。旧布局字号通过 `--native-caption-size` 接受宿主值，独立资源保留原fallback。Checkbox为20px，勾选图标加粗并使用主题primary-foreground。

`openNativeDialog` 内置此密度与Select/Checkbox适配，使用同一Dialog的标题区、可滚动正文和固定操作区；关闭时释放表单桥接。业务保留分组、网格与事件。

### 多行操作卡片

`@capability-ui/action-card` 的 ActionCard 直接组合共享 Button（content尺寸），统一两行标题/说明、内容高度与长文本换行。`@capability-ui/native-action-cards` 为保留控制器提供整组React渲染，控制器只提供文案、状态、点击和拖拽回调。流程员工栏已使用此组件；不再叠加flow-agent-chip旧规则。

`@capability-ui/native-collections` 提供真实 Card / Badge / Button 的记录卡、统计卡和单选筛选组，以及保留原节点的内容卡容器。业务只传递文本、状态和回调；动态卡片移除时释放 React root。`@capability-ui/native-retained-dialog` 用共享 Dialog 承载已有表单与预览节点，保留 ID、事件、草稿与 close 事件，支持关闭后恢复到重绘后的同一操作。协作和工作方法已使用这些入口。

`native-layout` 舒适密度同时作用于真实共享 Button 与原生样式桥接按钮；内容卡/长文本按钮明确使用 content 尺寸，图标按钮保留专用尺寸。迁移页面的旧全局规则不得覆盖共享组件的颜色、字号或尺寸。

执行器/设置补充：记录Card支持`avatar: {src?, fallback}`，标签和统计值支持`tone: "success" | "danger"`语义装饰；未指定标签变体时使用outline。统计Card随动态容器销毁释放root。ActionCard提供稳定回焦标识；原生Dialog关闭可通过`data-native-focus-key`或触发ID定位重绘后的节点，业务保存应先完成列表更新再关闭。设置折叠保留原生details/open协议，共享Card承载其表面。
