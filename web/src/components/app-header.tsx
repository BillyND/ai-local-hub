import { useState } from 'react'
import { LoaderCircleIcon, PlayIcon, PlusIcon, PowerIcon, SquareIcon, TerminalSquareIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ThemeToggle } from '@/components/theme-toggle'
import type { InstanceView } from '@/lib/types'

interface Props {
  instances: InstanceView[]
  localOnly: boolean
  reconnecting: boolean
  busy: boolean
  onAdd: () => void
  onStartAll: () => void
  onStopAll: () => void
  onQuit: () => void
}

export function AppHeader({ instances, localOnly, reconnecting, busy, onAdd, onStartAll, onStopAll, onQuit }: Props) {
  const [confirmQuit, setConfirmQuit] = useState(false)
  const running = instances.filter((i) => i.status.state === 'running').length
  const none = instances.length === 0

  return (
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <TerminalSquareIcon className="size-5" />
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-lg leading-tight font-semibold">Workspace Tools Manager</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <span>
              {instances.length} {instances.length === 1 ? 'instance' : 'instances'} · {running} running
            </span>
            {localOnly && <Badge variant="outline">local-only</Badge>}
            {reconnecting && (
              <span className="inline-flex items-center gap-1 text-xs text-warning">
                <LoaderCircleIcon className="size-3 animate-spin" /> reconnecting…
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onAdd}><PlusIcon />Add instance</Button>
        <Button variant="outline" onClick={onStartAll} disabled={none || busy}><PlayIcon />Start all</Button>
        <Button variant="outline" onClick={onStopAll} disabled={none || busy}><SquareIcon />Stop all</Button>
        <ThemeToggle />
        <Button variant="ghost" onClick={() => setConfirmQuit(true)} className="text-destructive hover:text-destructive">
          <PowerIcon />Quit
        </Button>
      </div>
      <ConfirmDialog
        open={confirmQuit}
        onOpenChange={setConfirmQuit}
        title="Quit the manager?"
        description="This stops every running instance and shuts down the manager. You will need to run it again from the terminal."
        confirmLabel="Quit manager"
        onConfirm={onQuit}
      />
    </header>
  )
}
