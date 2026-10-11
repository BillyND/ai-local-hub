import { useState } from 'react'
import { AlertCircleIcon, FolderIcon, LoaderCircleIcon, PencilIcon, PlayIcon, SquareIcon, Trash2Icon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyButton } from '@/components/copy-button'
import { describeStatus } from '@/lib/status-view'
import { cn } from '@/lib/utils'
import type { InstanceView } from '@/lib/types'

interface Props {
  instance: InstanceView
  localOnly: boolean
  selected: boolean
  onSelect: () => void
  onStart: () => void
  onStop: () => void
  onEdit: () => void
  onDelete: () => void
}

export function InstanceCard({ instance, localOnly, selected, onSelect, onStart, onStop, onEdit, onDelete }: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { status } = instance
  const view = describeStatus(instance, localOnly)
  const transitioning = status.state === 'starting' || status.state === 'stopping'
  const active = status.state === 'running' || status.state === 'starting'
  const act = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    fn()
  }

  return (
    <Card
      onClick={onSelect}
      data-selected={selected}
      className={cn('cursor-pointer gap-3 transition-shadow hover:shadow-md', selected && 'ring-2 ring-ring ring-offset-2 ring-offset-background')}
    >
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle className="min-w-0 truncate text-base">
          <button type="button" onClick={onSelect} className="max-w-full cursor-pointer truncate rounded-sm text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" aria-pressed={selected}>
            {instance.name}
          </button>
        </CardTitle>
        <Badge variant={view.tone}>
          {view.busy && <LoaderCircleIcon className="animate-spin" />}
          {view.label}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <FolderIcon className="size-4 shrink-0" />
          <span className="truncate font-mono text-xs" title={instance.workspaceRoot}>{instance.workspaceRoot}</span>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="shrink-0">Tunnel ID</span>
          <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{instance.tunnelId}</code>
        </div>
        {status.state === 'running' && status.url && (
          <div className="flex items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-2.5">
            <code className="min-w-0 flex-1 truncate font-mono text-xs" title={status.url}>{status.url}</code>
            <CopyButton value={status.url} label="Copy MCP URL" />
          </div>
        )}
        {transitioning && status.phase && <p className="text-xs text-warning">{status.phase}</p>}
        {status.state === 'error' && (
          <p role="alert" className="flex items-start gap-1.5 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            <AlertCircleIcon className="mt-px size-3.5 shrink-0" />
            <span className="break-words">{status.error ?? 'Instance failed'}</span>
          </p>
        )}
      </CardContent>
      <CardContent className="flex flex-wrap gap-2 pt-1">
        {active || status.state === 'stopping' ? (
          <Button size="sm" variant="outline" onClick={act(onStop)} disabled={status.state === 'stopping'}>
            {status.state === 'stopping' ? <LoaderCircleIcon className="animate-spin" /> : <SquareIcon />}
            Stop
          </Button>
        ) : (
          <Button size="sm" onClick={act(onStart)}><PlayIcon />Start</Button>
        )}
        <Button size="sm" variant="ghost" onClick={act(onEdit)}><PencilIcon />Edit</Button>
        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={act(() => setConfirmDelete(true))}>
          <Trash2Icon />Delete
        </Button>
      </CardContent>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete "${instance.name}"?`}
        description="This stops the instance if it is running and removes its saved API key. This cannot be undone."
        confirmLabel="Delete instance"
        onConfirm={onDelete}
      />
    </Card>
  )
}
