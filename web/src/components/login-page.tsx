import { useState, type FormEvent } from "react"

import DotGrid from "../../../底层能力/交互组件/src/bits/Backgrounds/DotGrid/DotGrid.jsx"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ThemeToggle } from "@/components/theme-toggle"
import { platformApi, type PlatformAccount } from "@/lib/platform-api"

export function LoginPage({ onSuccess }: { onSuccess: (account: PlatformAccount) => void }) {
  const [account, setAccount] = useState("")
  const [password, setPassword] = useState("")
  const [keep, setKeep] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [changePassword, setChangePassword] = useState(false)
  const [newPassword, setNewPassword] = useState("")

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const nextAccount = String(data.get("account") ?? account)
    const nextPassword = String(data.get("password") ?? password)
    if (!nextAccount.trim() || !nextPassword) return
    setBusy(true)
    setError("")
    try {
      if (changePassword) await platformApi('/platform/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ old_password: nextPassword, password: newPassword }) })
      await platformApi('/platform/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: nextAccount, password: changePassword ? newPassword : nextPassword, remember: keep }) })
      const session = await platformApi<PlatformAccount>('/platform/session')
      if (session.must_change_password) { setChangePassword(true); return }
      onSuccess(session)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败，请重试') }
    finally { setBusy(false) }
  }

  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      <section className="login-brand relative hidden overflow-hidden bg-background text-primary-foreground lg:flex lg:flex-col dark:text-foreground">
        <DotGrid
          className="pointer-events-none"
          dotSize={4}
          gap={22}
          baseColor="#9ec4ef"
          activeColor="#ffffff"
          opacity={0.9}
          dpr={undefined}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        />
        <img
          src="/login-brand-logo-light.png"
          alt="企划设计BG平台品牌标志"
          className="pointer-events-none absolute left-1/2 top-1/2 z-0 h-auto max-h-[68svh] w-[min(92%,38rem)] -translate-x-1/2 -translate-y-1/2 object-contain dark:hidden"
        />
        <img
          src="/login-brand-logo-dark.png"
          alt="企划设计BG平台品牌标志"
          className="pointer-events-none absolute left-1/2 top-1/2 z-0 hidden h-auto max-h-[68svh] w-[min(92%,38rem)] -translate-x-1/2 -translate-y-1/2 object-contain dark:block"
        />
        <div className="relative z-10 flex w-full flex-1 flex-col justify-between p-10">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary-foreground text-sm font-semibold text-primary">
              企
            </span>
            <span className="text-xl font-bold tracking-wide">企划设计BG平台</span>
          </div>
          <blockquote className="max-w-md">
            <p className="text-xl font-semibold leading-relaxed">挖掘、创造每一个产品的无穷可能性</p>
            
          </blockquote>
        </div>
      </section>
      <section className="relative flex items-center justify-center px-6 py-12">
        <div className="absolute top-4 right-4">
          <ThemeToggle />
        </div>
        <form
          className="grid w-full max-w-sm gap-6 rounded-xl bg-card p-8 shadow-xl ring-1 ring-foreground/10"
          onSubmit={submit}
        >
          <div className="grid gap-2">
            <h1 className="text-2xl font-bold tracking-tight">登录</h1>
            <p className="text-sm text-muted-foreground">进入产品企划中心</p>
          </div>
          <label className="grid gap-2 text-sm font-medium">
            账号
            <Input
              name="account"
              autoComplete="username"
              value={account}
              onChange={(event) => setAccount(event.target.value)}
              placeholder="请输入账号"
            />
          </label>
          {changePassword ? <label className="grid gap-2 text-sm font-medium">设置新密码<Input type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={newPassword} onChange={event => setNewPassword(event.target.value)} placeholder="首次登录请设置至少8位新密码" /></label> : null}
          <label className="grid gap-2 text-sm font-medium">
            密码
            <Input
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="请输入密码"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={keep}
              onChange={(event) => setKeep(event.target.checked)}
            />
            保持登录
          </label>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "正在验证…" : changePassword ? "修改密码并登录" : "登录"}
          </Button>
        </form>
      </section>
    </div>
  )
}
