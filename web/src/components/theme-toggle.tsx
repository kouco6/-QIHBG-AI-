import { Moon, Sun } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"

export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"))

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
    localStorage.setItem("theme", dark ? "dark" : "light")
  }, [dark])

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label={dark ? "切换到浅色" : "切换到深色"}
      onClick={() => setDark((value) => !value)}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  )
}
