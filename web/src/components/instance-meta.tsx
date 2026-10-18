import { memo } from 'react'
import { FolderIcon, PlugIcon } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useManagerStore } from '@/stores/manager-store'

/** Static fields only: re-renders when the instance is edited, not on status changes. */
export const InstanceMeta = memo(function InstanceMeta({ id }: { id: string }) {
  const { workspaceRoot, tunnelId, mcpServers } = useManagerStore(
    useShallow((s) => ({
      workspaceRoot: s.byId[id]?.workspaceRoot ?? '',
      tunnelId: s.byId[id]?.tunnelId ?? '',
      mcpServers: s.byId[id]?.mcpServers,
    })),
  )
  const servers = Object.entries(mcpServers ?? {}).map(([name, server]) => (server.enabled === false ? `${name} (off)` : name))
  return (
    <>
      <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
        <FolderIcon className="size-4 shrink-0" />
        <span className="truncate font-mono text-xs" title={workspaceRoot}>{workspaceRoot}</span>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="shrink-0">Tunnel ID</span>
        <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{tunnelId}</code>
      </div>
      {servers.length > 0 && (
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <PlugIcon className="size-4 shrink-0" />
          <span className="truncate" title={servers.join(', ')}>MCP: {servers.join(', ')}</span>
        </div>
      )}
    </>
  )
})
