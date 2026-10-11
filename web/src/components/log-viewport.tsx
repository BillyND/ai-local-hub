import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDownIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { LogLine } from '@/components/log-line'
import { useLogStore } from '@/stores/log-store'
import { useUiStore } from '@/stores/ui-store'

const NEAR_BOTTOM_PX = 24

export function LogViewport() {
  const entries = useLogStore((s) => s.entries)
  const selectedId = useUiStore((s) => s.selectedId)
  const viewport = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [showJump, setShowJump] = useState(false)

  const scrollToBottom = useCallback(() => {
    const el = viewport.current
    if (el) el.scrollTop = el.scrollHeight
    following.current = true
    setShowJump(false)
  }, [])

  const onScroll = () => {
    const el = viewport.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
    following.current = near
    // Bail-out on equal state keeps scrolling from re-rendering the list.
    setShowJump(!near)
  }

  useLayoutEffect(() => {
    const el = viewport.current
    if (following.current && el) el.scrollTop = el.scrollHeight
  }, [entries])

  useEffect(scrollToBottom, [selectedId, scrollToBottom])

  return (
    <div className="relative min-h-0 flex-1 bg-muted/30">
      <ScrollArea className="h-full min-h-0 w-full" viewportRef={viewport} onViewportScroll={onScroll}>
        {entries.length === 0 ? (
          <p className="p-4 font-mono text-xs text-muted-foreground">{selectedId ? 'No output yet.' : 'Select an instance to see its output.'}</p>
        ) : (
          <div aria-live="off" className="p-3 font-mono text-xs leading-relaxed">
            {entries.map((entry) => (
              <LogLine key={entry.id} view={entry.view} />
            ))}
          </div>
        )}
      </ScrollArea>
      {showJump && (
        <Button size="sm" variant="secondary" className="absolute right-4 bottom-3 shadow-md" onClick={scrollToBottom}>
          <ArrowDownIcon />Jump to latest
        </Button>
      )}
    </div>
  )
}
