import { useState } from "react"
import { CirclePlus, X } from "lucide-react"
import { Button } from "./button"
import { Badge } from "./badge"
import { Checkbox } from "./checkbox"
import { Input } from "./input"
import { Popover, PopoverContent, PopoverTrigger } from "./popover"

export type FacetOption = { value: string; label: string; count?: number }
export function FacetedFilter({ title, options, selected, onChange }: { title: string; options: FacetOption[]; selected: string[]; onChange: (values: string[]) => void }) {
  const [query, setQuery] = useState("")
  return <Popover onOpenChange={open => { if (!open) setQuery("") }}>
    <PopoverTrigger asChild><Button variant="outline" className="border-dashed" aria-label={`${title}筛选`}><CirclePlus />{title}{selected.length > 0 && <><span className="mx-1 h-4 border-l" /><Badge variant="secondary" className="sm:hidden">{selected.length}</Badge><span className="hidden gap-1 sm:inline-flex">{selected.length > 2 ? <Badge variant="secondary">已选 {selected.length} 项</Badge> : selected.map(value => <Badge variant="secondary" key={value}>{options.find(option => option.value === value)?.label}</Badge>)}</span></>}</Button></PopoverTrigger>
    <PopoverContent align="start" className="w-56 p-1" aria-label={`${title}筛选选项`}>
      <Input aria-label={`搜索${title}`} placeholder={title} value={query} onChange={event => setQuery(event.target.value)} className="mb-1 border-0 shadow-none" />
      <div className="max-h-60 overflow-auto">{options.filter(option => option.label.toLowerCase().includes(query.trim().toLowerCase())).map(option => <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded-md p-2 text-sm hover:bg-muted"><Checkbox aria-label={`${title}：${option.label}`} checked={selected.includes(option.value)} onCheckedChange={checked => onChange(checked ? [...selected, option.value] : selected.filter(value => value !== option.value))} /><span className="flex-1">{option.label}</span><span className="text-xs tabular-nums text-muted-foreground">{option.count}</span></label>)}</div>
      {options.every(option => !option.label.toLowerCase().includes(query.trim().toLowerCase())) && <p className="p-3 text-sm text-muted-foreground">没有匹配项</p>}
      {selected.length > 0 && <div className="mt-1 border-t pt-1"><Button variant="ghost" className="w-full" onClick={() => onChange([])}><X />清除此筛选</Button></div>}
    </PopoverContent>
  </Popover>
}
