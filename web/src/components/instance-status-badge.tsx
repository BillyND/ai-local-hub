import { memo } from 'react'
import { LoaderCircleIcon } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Badge } from '@/components/ui/badge'
import { describeStatus } from '@/lib/status-view'
import { useManagerStore } from '@/stores/manager-store'

export const InstanceStatusBadge = memo(function InstanceStatusBadge({ id }: { id: string }) {
  const { state, tunnelReady, localOnly } = useManagerStore(
    useShallow((s) => ({ state: s.byId[id]?.status.state ?? 'stopped', tunnelReady: s.byId[id]?.status.tunnelReady ?? false, localOnly: s.localOnly })),
  )
  const view = describeStatus(state, tunnelReady, localOnly)
  return (
    <Badge variant={view.tone}>
      {view.busy && <LoaderCircleIcon className="animate-spin" />}
      {view.label}
    </Badge>
  )
})
