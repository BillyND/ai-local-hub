import { useEffect, useState } from 'react'
import { EyeIcon, EyeOffIcon, FolderOpenIcon, LoaderCircleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FolderBrowserDialog } from '@/components/folder-browser-dialog'
import type { InstanceInput, InstanceView } from '@/lib/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Instance being edited, or null when adding. */
  instance: InstanceView | null
  homeDir: string
  onSubmit: (input: InstanceInput) => Promise<void>
}

export function InstanceFormDialog({ open, onOpenChange, instance, homeDir, onSubmit }: Props) {
  const editing = instance !== null
  const [name, setName] = useState('')
  const [workspaceRoot, setWorkspaceRoot] = useState('')
  const [tunnelId, setTunnelId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [browsing, setBrowsing] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(instance?.name ?? '')
    setWorkspaceRoot(instance?.workspaceRoot ?? homeDir)
    setTunnelId(instance?.tunnelId ?? '')
    setApiKey('')
    setShowKey(false)
    setError(null)
    setPending(false)
  }, [open, instance, homeDir])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await onSubmit({ name: name.trim(), workspaceRoot: workspaceRoot.trim(), tunnelId: tunnelId.trim(), apiKey })
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit instance' : 'Add instance'}</DialogTitle>
            <DialogDescription>One instance serves one ChatGPT account through its own OpenAI tunnel.</DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="inst-name">Name</Label>
              <Input id="inst-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Personal" autoComplete="off" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="inst-workspace">Workspace folder</Label>
              <div className="flex gap-2">
                <Input id="inst-workspace" value={workspaceRoot} onChange={(e) => setWorkspaceRoot(e.target.value)} className="font-mono text-xs" autoComplete="off" required />
                <Button type="button" variant="outline" onClick={() => setBrowsing(true)}><FolderOpenIcon />Browse…</Button>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="inst-tunnel">OpenAI Tunnel ID</Label>
              <Input id="inst-tunnel" value={tunnelId} onChange={(e) => setTunnelId(e.target.value)} className="font-mono text-xs" autoComplete="off" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="inst-key">OpenAI API key</Label>
              <div className="flex gap-2">
                <Input
                  id="inst-key"
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="font-mono text-xs"
                  autoComplete="off"
                  required={!editing}
                  aria-describedby="inst-key-help"
                />
                <Button type="button" variant="outline" size="icon" onClick={() => setShowKey((v) => !v)} aria-label={showKey ? 'Hide API key' : 'Show API key'}>
                  {showKey ? <EyeOffIcon /> : <EyeIcon />}
                </Button>
              </div>
              {editing && <p id="inst-key-help" className="text-xs text-muted-foreground">Leave empty to keep the current key</p>}
            </div>
            {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={pending}>
                {pending && <LoaderCircleIcon className="animate-spin" />}
                {editing ? 'Save changes' : 'Add instance'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <FolderBrowserDialog
        open={browsing}
        onOpenChange={setBrowsing}
        initialPath={workspaceRoot}
        onSelect={(p) => {
          setWorkspaceRoot(p)
          setBrowsing(false)
        }}
      />
    </>
  )
}
