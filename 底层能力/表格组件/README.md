# 平台表格能力

既有内核源码继续用于复杂表格、合并、导入导出和 Univer 挂载。标准管理列表使用共享 `src/data-table.tsx`，不改变原表格内核或业务数据协议。

```tsx
import { Input } from "@capability-ui/input"
import { DataTable, type DataColumn } from "@capability-table/data-table"

type RecordItem = { id: string; name: string }
const columns: DataColumn<RecordItem>[] = [
  { id: "name", title: "名称", hideable: false, value: row => row.name, cell: row => row.name },
]

<DataTable rows={records} columns={columns} rowId={row => row.id}
  rowLabel={row => row.name} label="记录列表" filterKey={searchText}
  toolbar={<Input value={searchText} onChange={event => setSearchText(event.target.value)} />}
/>
```

`rows` 由调用方提供，可先按业务规则筛选。`value` 开启升序 / 降序，`cell` 控制单元格；`hideable: false` 固定必需列。`filterKey` 变化后回到第一页，排序和列显示继续保留。默认每页 10 条，可选 20–50 条；当前页全选和部分选中使用共享 Checkbox。`selectionActions(selected, clear)` 可挂接业务操作，组件自身不请求业务接口。`minWidth` 默认 1000 像素，可按列数调整；宽表在容器内横向滚动。

宿主需提供 React、React DOM、`radix-ui`、`lucide-react`、`cn`、`class-variance-authority`，以及共享 shadcn UI 主题和 Tailwind 扫描；当前 V2.0 宿主已具备这些依赖。Vite / TypeScript 使用 `@capability-table/*` 路径，`index.css` 扫描此文件。人员管理与「底层能力 → 表格组件」实际示例复用同一实现。

## 原生控制器接入

`@capability-table/native-data-table` 的 `renderNativeDataTable` 让保留的控制器提供行、列、原生单元格节点与回调，实际分页、排序、选择、显示列与横向滚动仍由同一个 DataTable 实现。产出库已接入；文件预览、下载、复制路径、来源任务的处理仍归业务控制器。

执行统计已接入同一原生DataTable桥接，人员、数量、Tokens及累计时长保留业务聚合口径；支持`empty`文案，调用方可用空行集显示读取失败或无数据状态，恢复时继续使用原React root。

宽表空态提示使用独立换行容器，避免窄屏时文案随表格最小宽度居中到视口之外。
