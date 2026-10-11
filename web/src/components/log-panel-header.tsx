import { EraserIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CardHeader, CardTitle } from '@/components/ui/card'
import { CopyButton } from '@/components/copy-button'
import { useLogStore } from '@/stores/log-store'
import { useManagerStore } from '@/stores/manager-store'
import { useUiStore } from '@/stores/ui-store'

const allLogs = () => useLogStore.getState().entries.map((e) => e.raw).join('\n')

export function LogPanelHeader() {
  const selectedId = useUiStore((s) => s.selectedId)
  const name = useManagerStore((s) => (selectedId ? s.byId[selectedId]?.name : undefined))
  const hasEntries = useLogStore((s) => s.entries.length > 0)
  const clear = useLogStore((s) => s.clear)
  return (
    <CardHeader className="shrink-0 flex-row items-center justify-between gap-2 px-4 py-3">
      <CardTitle className="min-w-0 truncate text-sm">
        Logs{name && <span className="font-normal text-muted-foreground"> · {name}</span>}
      </CardTitle>
      <div className="flex items-center gap-1">
        {hasEntries && <CopyButton value={allLogs} label="Copy logs" />}
        <Button variant="ghost" size="sm" onClick={clear} disabled={!hasEntries}>
          <EraserIcon />Clear view
        </Button>
      </div>
    </CardHeader>
  )
}
