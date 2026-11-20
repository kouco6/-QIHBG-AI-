import { createRoot, type Root } from "react-dom/client"
import { DataTable } from "./data-table"

type NativeRow = { id: string; [key: string]: unknown }
type NativeColumn = { id: string; title: string; className?: string; value?: (row: NativeRow) => string | number; cell: (row: NativeRow) => string | HTMLElement }
const roots = new WeakMap<HTMLElement, Root>()
/** Retained controllers supply cell nodes and callbacks; DataTable owns table behavior and layout. */
export function renderNativeDataTable(container: HTMLElement, options: { rows: NativeRow[]; columns: NativeColumn[]; label: string; empty?: string; filterKey?: string }) {
  let root = roots.get(container)
  if (!root) { container.replaceChildren(); root = createRoot(container); roots.set(container, root) }
  root.render(<DataTable<NativeRow> rows={options.rows} rowId={row => row.id} label={options.label} rowLabel={row => String(row.name || row.id)} empty={options.empty} filterKey={options.filterKey} minWidth={760}
    columns={options.columns.map(column => ({ ...column, cell: row => {
      const value = column.cell(row)
      return typeof value === "string" ? value : <div className="native-table-cell" ref={node => { if (node) node.replaceChildren(value) }} />
    } }))} />)
}
