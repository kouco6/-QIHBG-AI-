import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import type { PlatformAccount } from "@/lib/platform-api"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export function UserMenu({ compact = false, account }: { compact?: boolean; account: PlatformAccount | null }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <Button variant="ghost" className="h-12 w-full justify-start gap-2 px-2">
            <Avatar className="size-8">
              <AvatarFallback className="bg-primary text-xs text-primary-foreground">{account?.name.slice(0, 1) || '企'}</AvatarFallback>
            </Avatar>
            <span className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
              <span className="truncate font-medium">{account?.name || '平台账号'}</span>
              <span className="truncate text-xs text-sidebar-foreground/80">{account?.login}</span>
            </span>
          </Button>
        ) : (
          <Button variant="ghost" size="icon" className="rounded-full" aria-label="打开用户菜单">
            <Avatar className="size-8">
              <AvatarFallback className="bg-primary text-xs text-primary-foreground">{account?.name.slice(0, 1) || '企'}</AvatarFallback>
            </Avatar>
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>
          <span className="block">{account?.name}</span>
          <span className="block text-xs font-normal text-muted-foreground">{account?.login} · {account?.role === 'admin' ? '管理员' : '普通用户'}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => window.dispatchEvent(new Event('platform-logout-request'))}>退出</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
