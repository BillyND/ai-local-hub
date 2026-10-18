import { CircleArrowUpIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useUpdateStore } from '@/stores/update-store'

/** Desktop app only: current version and the automatic-install switch. */
export function UpdateMenu() {
  const view = useUpdateStore((s) => s.view)
  const setAutoInstall = useUpdateStore((s) => s.setAutoInstall)
  if (!view) return null
  const pending = view.phase !== 'idle'
  const label = pending ? `Updates: ${view.version} available` : 'Updates'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" className="relative" aria-label={label} title={label}>
          <CircleArrowUpIcon className="size-4" />
          {pending && <span className="absolute top-1 right-1 size-2 rounded-full bg-primary" aria-hidden />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Version {view.currentVersion}</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={view.autoInstall}
          onCheckedChange={(checked) => void setAutoInstall(checked)}
        >
          Install updates automatically
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
