import { ConfirmDialog } from '@/components/confirm-dialog'
import { quitManager } from '@/stores/actions'
import { useUiStore } from '@/stores/ui-store'

export function QuitDialog() {
  const open = useUiStore((s) => s.quitOpen)
  const setQuitOpen = useUiStore((s) => s.setQuitOpen)
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setQuitOpen}
      title="Quit the manager?"
      description="This stops every running instance and shuts down the manager. You will need to run it again from the terminal."
      confirmLabel="Quit manager"
      onConfirm={quitManager}
    />
  )
}
