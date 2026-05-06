import { useTheme } from "next-themes"
import { MoonIcon, SunIcon } from "lucide-react"
import { Button } from "~/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip"

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const isDark = resolvedTheme === "dark"
  const next = isDark ? "light" : "dark"

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setTheme(next)}
          aria-label={`Switch to ${next} mode`}
        >
          {isDark ? <SunIcon /> : <MoonIcon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>Switch to {next} mode</TooltipContent>
    </Tooltip>
  )
}
