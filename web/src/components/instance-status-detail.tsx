import { memo } from 'react'
import { AlertCircleIcon } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { CopyButton } from '@/components/copy-button'
import { useManagerStore } from '@/stores/manager-store'

export const InstanceStatusDetail = memo(function InstanceStatusDetail({ id }: { id: string }) {
  const { state, url, phase, error } = useManagerStore(
    useShallow((s) => {
      const status = s.byId[id]?.status
      return { state: status?.state, url: status?.url, phase: status?.phase, error: status?.error }
    }),
  )
  const transitioning = state === 'starting' || state === 'stopping'
  return (
    <>
      {state === 'running' && url && (
        <div className="flex items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-2.5">
          <code className="min-w-0 flex-1 truncate font-mono text-xs" title={url}>{url}</code>
          <CopyButton value={url} label="Copy MCP URL" />
        </div>
      )}
      {transitioning && phase && <p className="text-xs text-warning">{phase}</p>}
      {state === 'error' && (
        <p role="alert" className="flex items-start gap-1.5 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
          <AlertCircleIcon className="mt-px size-3.5 shrink-0" />
          <span className="break-words">{error ?? 'Instance failed'}</span>
        </p>
      )}
    </>
  )
})
