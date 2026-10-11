import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDownIcon, EraserIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { useInstanceLogs } from '@/hooks/use-instance-logs'

interface Props {
  instanceId: string | null
  instanceName: string | null
  subscribeLogs: (l: (id: string, line: string) => void) => () => void
}

const NEAR_BOTTOM_PX = 24

export function LogPanel({ instanceId, instanceName, subscribeLogs }: Props) {
  const { lines, clear } = useInstanceLogs(instanceId, subscribeLogs)
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
    setShowJump(!near)
  }

  useLayoutEffect(() => {
    if (following.current) {
      const el = viewport.current
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [lines])

  useEffect(() => {
    scrollToBottom()
  }, [instanceId, scrollToBottom])

  return (
    <Card className="h-[28rem] gap-0 overflow-hidden py-0 lg:sticky lg:top-6 lg:h-[calc(100dvh-8rem)]">
      <CardHeader className="flex-row items-center justify-between gap-2 px-4 py-3">
        <CardTitle className="min-w-0 truncate text-sm">
          Logs{instanceName && <span className="font-normal text-muted-foreground"> · {instanceName}</span>}
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={clear} disabled={lines.length === 0}>
          <EraserIcon />Clear view
        </Button>
      </CardHeader>
      <Separator />
      <div className="relative min-h-0 flex-1 bg-muted/30">
        <ScrollArea className="h-full" viewportRef={viewport} onViewportScroll={onScroll}>
          {lines.length === 0 ? (
            <p className="p-4 font-mono text-xs text-muted-foreground">{instanceId ? 'No output yet.' : 'Select an instance to see its output.'}</p>
          ) : (
            <pre aria-live="off" className="p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
              {lines.join('\n')}
            </pre>
          )}
        </ScrollArea>
        {showJump && (
          <Button size="sm" variant="secondary" className="absolute right-4 bottom-3 shadow-md" onClick={scrollToBottom}>
            <ArrowDownIcon />Jump to latest
          </Button>
        )}
      </div>
    </Card>
  )
}
