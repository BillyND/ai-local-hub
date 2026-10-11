import { memo } from 'react'
import { LoaderCircleIcon, PencilIcon, PlayIcon, SquareIcon, Trash2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CardContent } from '@/components/ui/card'
import { startInstance, stopInstance } from '@/stores/actions'
import { useManagerStore } from '@/stores/manager-store'
import { useUiStore } from '@/stores/ui-store'

const stop = (fn: () => void) => (e: React.MouseEvent) => {
  e.stopPropagation()
  fn()
}

export const InstanceActions = memo(function InstanceActions({ id }: { id: string }) {
  const state = useManagerStore((s) => s.byId[id]?.status.state ?? 'stopped')
  const openEdit = useUiStore((s) => s.openEdit)
  const setDeleteId = useUiStore((s) => s.setDeleteId)
  const running = state === 'running' || state === 'starting' || state === 'stopping'
  return (
    <CardContent className="flex flex-wrap gap-2 pt-1">
      {running ? (
        <Button size="sm" variant="outline" onClick={stop(() => stopInstance(id))} disabled={state === 'stopping'}>
          {state === 'stopping' ? <LoaderCircleIcon className="animate-spin" /> : <SquareIcon />}
          Stop
        </Button>
      ) : (
        <Button size="sm" onClick={stop(() => startInstance(id))}><PlayIcon />Start</Button>
      )}
      <Button size="sm" variant="ghost" onClick={stop(() => openEdit(id))}><PencilIcon />Edit</Button>
      <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={stop(() => setDeleteId(id))}>
        <Trash2Icon />Delete
      </Button>
    </CardContent>
  )
})
