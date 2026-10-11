import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useTheme } from '@/hooks/use-theme'

export function ThemeToggle() {
  const { choice, theme, setTheme } = useTheme()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label={`Theme: ${choice}`}>
          {theme === 'dark' ? <MoonIcon /> : <SunIcon />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => setTheme('light')}><SunIcon />Light</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setTheme('dark')}><MoonIcon />Dark</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setTheme('system')}><MonitorIcon />System</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
