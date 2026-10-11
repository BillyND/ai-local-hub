import { useCallback, useEffect, useState } from 'react'
import { LockKeyholeIcon, PowerOffIcon, TriangleAlertIcon } from 'lucide-react'
import { toast } from 'sonner'
import { AppHeader } from '@/components/app-header'
import { FullPageState } from '@/components/full-page-state'
import { InstanceFormDialog } from '@/components/instance-form-dialog'
import { InstanceList } from '@/components/instance-list'
import { LogPanel } from '@/components/log-panel'
import { SecurityNote } from '@/components/security-note'
import { Skeleton } from '@/components/ui/skeleton'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useManagerState } from '@/hooks/use-manager-state'
import { api } from '@/lib/api'
import type { InstanceInput, InstanceView } from '@/lib/types'

type FormTarget = { mode: 'add' } | { mode: 'edit'; instance: InstanceView } | null

export default function App() {
  const { state, loadError, reconnecting, expired, refresh, subscribeLogs } = useManagerState()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState<FormTarget>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [stopped, setStopped] = useState(false)

  const instances = state?.instances
  useEffect(() => {
    if (!instances) return
    if (!selectedId || !instances.some((i) => i.id === selectedId)) setSelectedId(instances[0]?.id ?? null)
  }, [instances, selectedId])

  const run = useCallback(async (fn: () => Promise<unknown>, success?: string) => {
    try {
      await fn()
      if (success) toast.success(success)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Request failed')
    }
  }, [])

  const bulk = async (fn: () => Promise<unknown>, success: string) => {
    setBulkBusy(true)
    await run(fn, success)
    setBulkBusy(false)
  }

  const submitForm = async (input: InstanceInput) => {
    if (form?.mode === 'edit') {
      await api.updateInstance(form.instance.id, input)
      toast.success(`Saved "${input.name}"`)
    } else {
      const created = await api.createInstance(input)
      setSelectedId(created.id)
      toast.success(`Added "${input.name}"`)
    }
    void refresh()
  }

  if (expired) {
    return (
      <FullPageState icon={<LockKeyholeIcon />} title="Session expired">
        Session expired — reopen the link printed in the terminal.
      </FullPageState>
    )
  }
  if (stopped) {
    return (
      <FullPageState icon={<PowerOffIcon />} title="Manager stopped">
        Manager stopped. You can close this tab.
      </FullPageState>
    )
  }
  if (!state) {
    return loadError ? (
      <FullPageState icon={<TriangleAlertIcon />} title="Cannot reach the manager">{loadError}</FullPageState>
    ) : (
      <main className="mx-auto max-w-6xl space-y-4 p-6">
        <Skeleton className="h-12" />
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </main>
    )
  }

  const selected = state.instances.find((i) => i.id === selectedId) ?? null
  return (
    <TooltipProvider>
      <div className="mx-auto flex min-h-dvh min-w-0 max-w-6xl flex-col gap-4 px-4 py-5 sm:px-6">
        <AppHeader
          instances={state.instances}
          localOnly={state.localOnly}
          reconnecting={reconnecting}
          busy={bulkBusy}
          onAdd={() => setForm({ mode: 'add' })}
          onStartAll={() => bulk(api.startAll, 'Starting all instances')}
          onStopAll={() => bulk(api.stopAll, 'Stopping all instances')}
          onQuit={() => run(async () => { await api.shutdown(); setStopped(true) })}
        />
        <SecurityNote />
        <main className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <section aria-label="Instances">
            <InstanceList
              instances={state.instances}
              localOnly={state.localOnly}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onAdd={() => setForm({ mode: 'add' })}
              onStart={(i) => run(() => api.startInstance(i.id))}
              onStop={(i) => run(() => api.stopInstance(i.id))}
              onEdit={(instance) => setForm({ mode: 'edit', instance })}
              onDelete={(i) => run(() => api.deleteInstance(i.id), `Deleted "${i.name}"`).then(refresh)}
            />
          </section>
          <section aria-label="Logs">
            <LogPanel instanceId={selected?.id ?? null} instanceName={selected?.name ?? null} subscribeLogs={subscribeLogs} />
          </section>
        </main>
      </div>
      <InstanceFormDialog
        open={form !== null}
        onOpenChange={(o) => !o && setForm(null)}
        instance={form?.mode === 'edit' ? form.instance : null}
        homeDir={state.homeDir}
        onSubmit={submitForm}
      />
      <Toaster />
    </TooltipProvider>
  )
}
