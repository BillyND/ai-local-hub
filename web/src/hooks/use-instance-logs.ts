import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { parseLogLine, type ParsedLog } from "@/lib/parse-log-line";
import { sanitizeLogLine } from "@/lib/sanitize-log-line";

const MAX_LINES = 1000;

export interface LogEntry {
  /** Stable React key; survives the buffer dropping its oldest lines. */
  id: number;
  raw: string;
  view: ParsedLog;
}

let nextId = 0;
/** Sanitizes and parses a line; blank lines (the tunnel client prints many) are dropped. */
function toEntry(line: string): LogEntry | null {
  const raw = sanitizeLogLine(line);
  return raw.trim() === "" ? null : { id: nextId++, raw, view: parseLogLine(raw) };
}
const toEntries = (lines: string[]): LogEntry[] =>
  lines.flatMap((line) => toEntry(line) ?? []);

/** Log buffer for the selected instance: initial fetch, then live lines. */
export function useInstanceLogs(
  id: string | null,
  subscribeLogs: (l: (id: string, line: string) => void) => () => void,
) {
  const [entries, setEntries] = useState<LogEntry[]>([]);

  useEffect(() => {
    setEntries([]);
    if (!id) return;
    let cancelled = false;
    const pending: LogEntry[] = [];
    let loaded = false;

    const unsubscribe = subscribeLogs((eventId, line) => {
      if (eventId !== id) return;
      const entry = toEntry(line);
      if (!entry) return;
      if (!loaded) pending.push(entry);
      else setEntries((prev) => [...prev, entry].slice(-MAX_LINES));
    });

    api
      .getLogs(id)
      .then(({ lines: initial }) => {
        if (cancelled) return;
        loaded = true;
        setEntries([...toEntries(initial), ...pending].slice(-MAX_LINES));
      })
      .catch(() => {
        if (cancelled) return;
        loaded = true;
        setEntries(pending.slice(-MAX_LINES));
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [id, subscribeLogs]);

  const clear = useCallback(() => setEntries([]), []);
  return { entries, clear };
}
