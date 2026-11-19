import * as React from "react"
import { Popover as Primitive } from "radix-ui"
import { cn } from "cn"

export const Popover = Primitive.Root
export const PopoverTrigger = Primitive.Trigger
export const PopoverAnchor = Primitive.Anchor
export function PopoverContent({ className, align = "center", sideOffset = 4, ...props }: React.ComponentProps<typeof Primitive.Content>) {
  return <Primitive.Portal><Primitive.Content data-slot="popover-content" align={align} sideOffset={sideOffset} className={cn("z-50 w-72 rounded-lg border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0", className)} {...props} /></Primitive.Portal>
}
