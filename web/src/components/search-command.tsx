import { useEffect, useState } from "react"
import { SearchIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"

const entries = [
  "总览",
  "调研项目",
  "企划项目",
  "评审项目",
  "企划进度",
  "展会情况",
  "模版管理",
  "数据看板",
  "产出管理",
]

export function SearchCommand() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  return (
    <>
      <Button
        variant="outline"
        className="relative h-8 w-full justify-start bg-muted/40 px-3 text-sm font-normal text-muted-foreground shadow-none sm:w-40 lg:w-64"
        onClick={() => setOpen(true)}
      >
        <SearchIcon className="size-4" />
        <span className="ml-2">搜索</span>
        <kbd className="pointer-events-none absolute top-1.5 right-1.5 hidden h-5 items-center rounded border bg-background px-1.5 font-mono text-[10px] sm:flex">
          ⌘K
        </kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} title="搜索" description="在页面名称中查找">
        <Command>
          <CommandInput placeholder="搜索页面…" />
          <CommandList>
            <CommandEmpty>没有匹配结果</CommandEmpty>
            <CommandGroup heading="页面">
              {entries.map((entry) => (
                <CommandItem key={entry} value={entry} onSelect={() => setOpen(false)}>
                  {entry}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  )
}
