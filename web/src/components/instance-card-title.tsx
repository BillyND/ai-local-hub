import { memo } from 'react'
import { CardHeader, CardTitle } from '@/components/ui/card'
import { InstanceStatusBadge } from '@/components/instance-status-badge'
import { useManagerStore } from '@/stores/manager-store'
import { useUiStore } from '@/stores/ui-store'

export const InstanceCardTitle = memo(function InstanceCardTitle({ id }: { id: string }) {
  const name = useManagerStore((s) => s.byId[id]?.name)
  const selected = useUiStore((s) => s.selectedId === id)
  const select = useUiStore((s) => s.select)
  return (
    <CardHeader className="flex-row items-center justify-between gap-3">
      <CardTitle className="min-w-0 truncate text-base">
        <button type="button" onClick={() => select(id)} className="max-w-full cursor-pointer truncate rounded-sm text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" aria-pressed={selected}>
          {name}
        </button>
      </CardTitle>
      <InstanceStatusBadge id={id} />
    </CardHeader>
  )
})
