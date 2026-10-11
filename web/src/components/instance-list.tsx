import { EmptyState } from '@/components/empty-state'
import { InstanceCard } from '@/components/instance-card'
import type { InstanceView } from '@/lib/types'

interface Props {
  instances: InstanceView[]
  localOnly: boolean
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  onStart: (i: InstanceView) => void
  onStop: (i: InstanceView) => void
  onEdit: (i: InstanceView) => void
  onDelete: (i: InstanceView) => void
}

export function InstanceList({ instances, localOnly, selectedId, onSelect, onAdd, onStart, onStop, onEdit, onDelete }: Props) {
  if (instances.length === 0) return <EmptyState onAdd={onAdd} />
  return (
    <div className="flex flex-col gap-4 p-1">
      {instances.map((i) => (
        <InstanceCard
          key={i.id}
          instance={i}
          localOnly={localOnly}
          selected={i.id === selectedId}
          onSelect={() => onSelect(i.id)}
          onStart={() => onStart(i)}
          onStop={() => onStop(i)}
          onEdit={() => onEdit(i)}
          onDelete={() => onDelete(i)}
        />
      ))}
    </div>
  )
}
