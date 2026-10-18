import { CircleArrowUpIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useUpdateStore } from '@/stores/update-store'

/** Desktop app only: announces a newer version and shows download/install progress. */
export function UpdateBanner() {
  const view = useUpdateStore((s) => s.view)
  const install = useUpdateStore((s) => s.install)
  if (!view || view.phase === 'idle' || !view.version) return null
  const { phase, version, progress, error, autoInstall } = view
  const percent = progress === null ? null : Math.round(progress * 100)

  let icon = <CircleArrowUpIcon className="mt-0.5 size-4 shrink-0 text-primary" />
  let text = `AI Local Hub ${version} is available.`
  let action: string | null = 'Update and restart'
  if (phase === 'available' && autoInstall) text += ' It installs automatically.'
  if (phase === 'downloading') {
    icon = <LoaderCircleIcon className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
    text = `Downloading AI Local Hub ${version}${percent === null ? '…' : ` · ${percent}%`}`
    action = null
  } else if (phase === 'installing') {
    icon = <LoaderCircleIcon className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
    text = `Installing AI Local Hub ${version}. The app restarts in a moment and running instances start again.`
    action = null
  } else if (phase === 'error') {
    icon = <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
    text = `Could not update to ${version}: ${error ?? 'unknown error'}`
    action = 'Try again'
  }

  return (
    <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card px-3 py-2 text-sm">
      <p className="flex min-w-0 flex-1 items-start gap-2">
        {icon}
        <span className="min-w-0 break-words">{text}</span>
      </p>
      {action && <Button size="sm" onClick={() => void install()}>{action}</Button>}
      {phase === 'downloading' && percent !== null && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  )
}
