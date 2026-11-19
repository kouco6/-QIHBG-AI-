import type { ComponentProps } from "react"
import { cn } from "cn"

export function Badge({ className, variant = "outline", ...props }: ComponentProps<"span"> & { variant?: "outline" | "secondary" | "default" | "destructive" }) {
  return <span data-slot="badge" className={cn("inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs leading-4 font-medium whitespace-nowrap", variant === "outline" && "border-border text-foreground", variant === "secondary" && "border-transparent bg-muted text-muted-foreground", variant === "default" && "border-primary/20 bg-primary/10 text-primary", variant === "destructive" && "border-destructive/20 bg-destructive/10 text-destructive", className)} {...props} />
}
