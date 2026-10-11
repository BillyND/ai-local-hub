import { PlayIcon, PlusIcon, PowerIcon, SquareIcon } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/theme-toggle'
import { startAll, stopAll } from '@/stores/actions'
import { useManagerStore } from '@/stores/manager-store'
import { useUiStore } from '@/stores/ui-store'

export function HeaderActions() {
  const none = useManagerStore((s) => s.ids.length === 0)
  const { bulkBusy, openAdd, setQuitOpen } = useUiStore(
    useShallow((s) => ({ bulkBusy: s.bulkBusy, openAdd: s.openAdd, setQuitOpen: s.setQuitOpen })),
  )
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button onClick={openAdd}><PlusIcon />Add instance</Button>
      <Button variant="outline" onClick={startAll} disabled={none || bulkBusy}><PlayIcon />Start all</Button>
      <Button variant="outline" onClick={stopAll} disabled={none || bulkBusy}><SquareIcon />Stop all</Button>
      <ThemeToggle />
      <Button variant="ghost" onClick={() => setQuitOpen(true)} className="text-destructive hover:text-destructive">
        <PowerIcon />Quit
      </Button>
    </div>
  )
}
