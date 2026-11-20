import * as React from "react"
import { Select as Primitive } from "radix-ui"
import { Check, ChevronDown } from "lucide-react"
import { cn } from "cn"

export function Select({ value, onValueChange, label, options, disabled, className }: {
  value: string; onValueChange: (value: string) => void; label: string
  options: { value: string; label: string; disabled?: boolean }[]; disabled?: boolean; className?: string
}) {
  return <Primitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
    <Primitive.Trigger data-slot="select-trigger" aria-label={label} className={cn("inline-flex h-9 max-w-[45vw] min-w-0 items-center justify-between gap-2 rounded-lg border border-input bg-card px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [&>span:first-child]:truncate", className)}><Primitive.Value placeholder={label} /><Primitive.Icon><ChevronDown className="size-4 shrink-0 text-muted-foreground" /></Primitive.Icon></Primitive.Trigger>
    <Primitive.Portal><Primitive.Content position="popper" sideOffset={4} className="z-50 max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md"><Primitive.ScrollUpButton className="py-1 text-center text-xs">向上滚动</Primitive.ScrollUpButton><Primitive.Viewport className="p-1">{options.map(option => <Primitive.Item key={option.value} value={option.value} disabled={option.disabled} className="relative flex cursor-pointer items-center rounded-md py-2 pr-8 pl-3 text-sm outline-none data-highlighted:bg-muted data-disabled:opacity-50 data-disabled:pointer-events-none"><Primitive.ItemText>{option.label}</Primitive.ItemText><Primitive.ItemIndicator className="absolute right-2"><Check className="size-4" /></Primitive.ItemIndicator></Primitive.Item>)}</Primitive.Viewport><Primitive.ScrollDownButton className="py-1 text-center text-xs">向下滚动</Primitive.ScrollDownButton></Primitive.Content></Primitive.Portal>
  </Primitive.Root>
}

export type SelectOption = React.ComponentProps<typeof Select>["options"][number]
