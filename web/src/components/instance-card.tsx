import { memo } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { InstanceActions } from '@/components/instance-actions'
import { InstanceCardTitle } from '@/components/instance-card-title'
import { InstanceMeta } from '@/components/instance-meta'
import { InstanceStatusDetail } from '@/components/instance-status-detail'
import { cn } from '@/lib/utils'
import { useUiStore } from '@/stores/ui-store'

/** Shell only: every part below subscribes to its own slice of the stores. */
export const InstanceCard = memo(function InstanceCard({ id }: { id: string }) {
  const selected = useUiStore((s) => s.selectedId === id)
  const select = useUiStore((s) => s.select)
  return (
    <Card
      onClick={() => select(id)}
      data-selected={selected}
      className={cn('cursor-pointer gap-3 transition-shadow hover:shadow-md', selected && 'ring-2 ring-ring ring-offset-2 ring-offset-background')}
    >
      <InstanceCardTitle id={id} />
      <CardContent className="space-y-2 text-sm">
        <InstanceMeta id={id} />
        <InstanceStatusDetail id={id} />
      </CardContent>
      <InstanceActions id={id} />
    </Card>
  )
})
