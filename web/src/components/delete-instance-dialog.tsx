import { ConfirmDialog } from '@/components/confirm-dialog'
import { deleteInstance } from '@/stores/actions'
import { useManagerStore } from '@/stores/manager-store'
import { useUiStore } from '@/stores/ui-store'

export function DeleteInstanceDialog() {
  const deleteId = useUiStore((s) => s.deleteId)
  const setDeleteId = useUiStore((s) => s.setDeleteId)
  const name = useManagerStore((s) => (deleteId ? s.byId[deleteId]?.name : undefined))
  return (
    <ConfirmDialog
      open={deleteId !== null}
      onOpenChange={(open) => !open && setDeleteId(null)}
      title={`Delete "${name ?? ''}"?`}
      description="This stops the instance if it is running and removes its saved API key. This cannot be undone."
      confirmLabel="Delete instance"
      onConfirm={() => deleteId && deleteInstance(deleteId)}
    />
  )
}
