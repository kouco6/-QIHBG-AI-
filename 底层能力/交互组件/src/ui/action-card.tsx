import type { ComponentProps } from "react"
import { Button } from "./button"
import { cn } from "cn"

/** A multiline action, sized by its content rather than a single-line control height. */
export function ActionCard({ title, description, className, ...props }: Omit<ComponentProps<typeof Button>, "title" | "children" | "size"> & { title: string; description: string }) {
  return <Button {...props} size="content" className={cn("flex min-w-0 max-w-full flex-col items-start justify-start gap-1 px-3 py-3 text-left", className)} data-slot="action-card">
    <span data-slot="action-card-title" className="block w-full text-sm leading-6 font-medium whitespace-normal [overflow-wrap:anywhere]">{title}</span>
    <span data-slot="action-card-description" className="block w-full text-[13px] leading-5 font-normal whitespace-normal text-muted-foreground [overflow-wrap:anywhere]">{description}</span>
  </Button>
}
