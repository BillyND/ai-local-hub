import { useCallback, useEffect, useRef, useState } from 'react'
import { api, setUnauthorizedHandler } from '@/lib/api'
import type { ManagerState, ServerEvent } from '@/lib/types'

type LogListener = (id: string, line: string) => void

export function useManagerState() {
  const [state, setState] = useState<ManagerState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [expired, setExpired] = useState(false)
  const logListeners = useRef(new Set<LogListener>())

  const refresh = useCallback(async () => {
    try {
      setState(await api.getState())
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load state')
    }
  }, [])

  const subscribeLogs = useCallback((listener: LogListener) => {
    logListeners.current.add(listener)
    return () => {
      logListeners.current.delete(listener)
    }
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(() => setExpired(true))
    return () => setUnauthorizedHandler(null)
  }, [])

  useEffect(() => {
    let source: EventSource | null = null
    let timer: number | undefined
    let attempt = 0
    let disposed = false
    let opened = false

    const apply = (event: ServerEvent) => {
      if (event.type === 'log') {
        logListeners.current.forEach((l) => l(event.id, event.line))
      } else if (event.type === 'instances') {
        setState((s) => (s ? { ...s, instances: event.instances } : s))
      } else if (event.type === 'status') {
        setState((s) =>
          s ? { ...s, instances: s.instances.map((i) => (i.id === event.id ? { ...i, status: event.status } : i)) } : s,
        )
      }
    }

    const connect = () => {
      if (disposed) return
      source = new EventSource('/api/events')
      source.onopen = () => {
        attempt = 0
        setReconnecting(false)
        if (opened) void refresh()
        opened = true
      }
      source.onmessage = (msg) => {
        try {
          apply(JSON.parse(msg.data) as ServerEvent)
        } catch {
          /* ignore malformed event */
        }
      }
      source.onerror = () => {
        source?.close()
        if (disposed) return
        setReconnecting(true)
        const delay = Math.min(1000 * 2 ** attempt, 15000)
        attempt += 1
        timer = window.setTimeout(connect, delay)
      }
    }

    void refresh().then(connect)
    return () => {
      disposed = true
      window.clearTimeout(timer)
      source?.close()
    }
  }, [refresh])

  return { state, loadError, reconnecting, expired, refresh, subscribeLogs }
}
