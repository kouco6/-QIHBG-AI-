import * as React from "react"
import { Checkbox as Primitive } from "radix-ui"
import { Check, Minus } from "lucide-react"
import { cn } from "cn"

export function Checkbox({ className, ...props }: React.ComponentProps<typeof Primitive.Root>) {
  return <Primitive.Root data-slot="checkbox" className={cn("peer inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-input bg-background text-primary-foreground shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary", className)} {...props}>
    <Primitive.Indicator>{props.checked === "indeterminate" ? <Minus className="size-3.5" /> : <Check className="size-3.5" />}</Primitive.Indicator>
  </Primitive.Root>
}
