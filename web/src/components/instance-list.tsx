import { useShallow } from 'zustand/react/shallow'
import { EmptyState } from '@/components/empty-state'
import { InstanceCard } from '@/components/instance-card'
import { useManagerStore } from '@/stores/manager-store'

export function InstanceList() {
  const ids = useManagerStore(useShallow((s) => s.ids))
  if (ids.length === 0) return <EmptyState />
  return (
    <div className="flex flex-col gap-4 p-1">
      {ids.map((id) => (
        <InstanceCard key={id} id={id} />
      ))}
    </div>
  )
}
