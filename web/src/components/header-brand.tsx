import { LoaderCircleIcon, TerminalSquareIcon } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Badge } from '@/components/ui/badge'
import { useManagerStore } from '@/stores/manager-store'

export function HeaderBrand() {
  const { count, running, localOnly, reconnecting } = useManagerStore(
    useShallow((s) => ({
      count: s.ids.length,
      running: s.ids.filter((id) => s.byId[id]?.status.state === 'running').length,
      localOnly: s.localOnly,
      reconnecting: s.reconnecting,
    })),
  )
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <TerminalSquareIcon className="size-5" />
      </div>
      <div className="min-w-0">
        <h1 className="truncate text-lg leading-tight font-semibold">AI Local Hub</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
          <span>{count} {count === 1 ? 'instance' : 'instances'} · {running} running</span>
          {localOnly && <Badge variant="outline">local-only</Badge>}
          {reconnecting && (
            <span className="inline-flex items-center gap-1 text-xs text-warning">
              <LoaderCircleIcon className="size-3 animate-spin" /> reconnecting…
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
