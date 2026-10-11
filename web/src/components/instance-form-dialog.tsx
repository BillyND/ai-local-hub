import { useEffect, useState } from 'react'
import { EyeIcon, EyeOffIcon, FolderOpenIcon, LoaderCircleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FolderBrowserDialog } from '@/components/folder-browser-dialog'
import { useShallow } from 'zustand/react/shallow'
import { submitInstance } from '@/stores/actions'
import { useManagerStore } from '@/stores/manager-store'
import { useUiStore } from '@/stores/ui-store'

export function InstanceFormDialog() {
  const { open, editId } = useUiStore(useShallow((s) => ({ open: s.form !== null, editId: s.form?.mode === 'edit' ? s.form.id : null })))
  const closeForm = useUiStore((s) => s.closeForm)
  const editing = editId !== null
  const [name, setName] = useState('')
  const [workspaceRoot, setWorkspaceRoot] = useState('')
  const [tunnelId, setTunnelId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [toolGroups, setToolGroups] = useState(['core', 'ast', 'lsp', 'ls'])
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [browsing, setBrowsing] = useState(false)

  // Seeds the fields once per open. Live status updates must not reset what the user is typing.
  useEffect(() => {
    if (!open) return
    const { byId, homeDir } = useManagerStore.getState()
    const instance = editId ? byId[editId] : undefined
    setName(instance?.name ?? '')
    setWorkspaceRoot(instance?.workspaceRoot ?? homeDir)
    setTunnelId(instance?.tunnelId ?? '')
    setApiKey('')
    setToolGroups(instance?.toolGroups?.length ? instance.toolGroups : ['core', 'ast', 'lsp', 'ls'])
    setShowKey(false)
    setError(null)
    setPending(false)
  }, [open, editId])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await submitInstance({ name: name.trim(), workspaceRoot: workspaceRoot.trim(), tunnelId: tunnelId.trim(), apiKey, toolGroups })
      closeForm()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && closeForm()}>
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
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Tool groups</legend>
              <p className="text-xs text-muted-foreground">Core tools are always enabled. Disable optional groups to reduce the tools shown to ChatGPT.</p>
              <div className="grid gap-2 sm:grid-cols-3">
                {[
                  ['ast', 'AST search and rewrites'],
                  ['lsp', 'Language server actions'],
                  ['ls', 'Directory listing'],
                ].map(([group, label]) => (
                  <label key={group} className="flex items-start gap-2 text-sm">
                    <input type="checkbox" checked={toolGroups.includes(group)} onChange={(e) => setToolGroups((current) => e.target.checked ? [...current, group] : current.filter((value) => value !== group))} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeForm}>Cancel</Button>
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
