import { useEffect, useState } from 'react'
import { ArrowUpIcon, FolderIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import type { FsListing } from '@/lib/types'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialPath: string
  onSelect: (path: string) => void
}

function baseName(p: string) {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

export function FolderBrowserDialog({ open, onOpenChange, initialPath, onSelect }: Props) {
  const [target, setTarget] = useState<string | undefined>(undefined)
  const [listing, setListing] = useState<FsListing | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) setTarget(initialPath.trim() || undefined)
  }, [open, initialPath])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setError(null)
    api
      .listDir(target)
      .then((l) => !cancelled && setListing(l))
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Could not read folder')
        // fall back to the default folder when the typed path is invalid
        if (target !== undefined) setTarget(undefined)
      })
    return () => {
      cancelled = true
    }
  }, [open, target])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Choose workspace folder</DialogTitle>
          <DialogDescription className="font-mono text-xs break-all">{listing?.path ?? 'Loading…'}</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <ScrollArea className="h-64 rounded-md border">
          <ul className="p-1">
            {!listing && Array.from({ length: 5 }, (_, i) => <li key={i} className="p-1"><Skeleton className="h-7" /></li>)}
            {listing?.parent && (
              <li>
                <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => setTarget(listing.parent ?? undefined)}>
                  <ArrowUpIcon />Up
                </Button>
              </li>
            )}
            {listing?.dirs.map((d) => (
              <li key={d}>
                <Button variant="ghost" size="sm" className="w-full justify-start font-normal" onClick={() => setTarget(d)}>
                  <FolderIcon className="text-muted-foreground" /><span className="truncate">{baseName(d)}</span>
                </Button>
              </li>
            ))}
            {listing && listing.dirs.length === 0 && <li className="p-3 text-sm text-muted-foreground">No subfolders.</li>}
          </ul>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!listing} onClick={() => listing && onSelect(listing.path)}>Select this folder</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
