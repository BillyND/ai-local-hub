import { useEffect } from 'react'
import { LockKeyholeIcon, PowerOffIcon, TriangleAlertIcon } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { AppHeader } from '@/components/app-header'
import { DeleteInstanceDialog } from '@/components/delete-instance-dialog'
import { FullPageState } from '@/components/full-page-state'
import { InstanceFormDialog } from '@/components/instance-form-dialog'
import { InstanceList } from '@/components/instance-list'
import { LogPanel } from '@/components/log-panel'
import { QuitDialog } from '@/components/quit-dialog'
import { SecurityNote } from '@/components/security-note'
import { Skeleton } from '@/components/ui/skeleton'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { UpdateBanner } from '@/components/update-banner'
import { useManagerStore } from '@/stores/manager-store'
import { useUpdateStore } from '@/stores/update-store'

function Loading() {
  return (
    <main className="mx-auto max-w-6xl space-y-4 p-6">
      <Skeleton className="h-12" />
      <Skeleton className="h-40" />
      <Skeleton className="h-40" />
    </main>
  )
}

function Dashboard() {
  return (
    <TooltipProvider>
      <div className="mx-auto flex min-h-dvh min-w-0 max-w-6xl flex-col gap-4 px-4 py-5 sm:px-6 lg:h-dvh lg:overflow-hidden">
        <AppHeader />
        <UpdateBanner />
        <SecurityNote />
        <main className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-6 lg:min-h-0 lg:flex-1 lg:grid-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-stretch">
          <section aria-label="Instances" className="min-w-0 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain">
            <InstanceList />
          </section>
          <section aria-label="Logs" className="min-w-0 min-h-0 lg:overflow-hidden">
            <LogPanel />
          </section>
        </main>
      </div>
      <InstanceFormDialog />
      <DeleteInstanceDialog />
      <QuitDialog />
      <Toaster />
    </TooltipProvider>
  )
}

/** Only decides which screen to show; everything inside reads its own state. */
export default function App() {
  const { expired, stopped, loaded, loadError } = useManagerStore(
    useShallow((s) => ({ expired: s.expired, stopped: s.stopped, loaded: s.loaded, loadError: s.loadError })),
  )
  useEffect(() => useManagerStore.getState().connect(), [])
  useEffect(() => useUpdateStore.getState().connect(), [])

  if (expired) {
    return <FullPageState icon={<LockKeyholeIcon />} title="Session expired">Session expired — reopen the link printed in the terminal.</FullPageState>
  }
  if (stopped) {
    return <FullPageState icon={<PowerOffIcon />} title="Manager stopped">Manager stopped. You can close this tab.</FullPageState>
  }
  if (!loaded) {
    return loadError ? <FullPageState icon={<TriangleAlertIcon />} title="Cannot reach the manager">{loadError}</FullPageState> : <Loading />
  }
  return <Dashboard />
}
