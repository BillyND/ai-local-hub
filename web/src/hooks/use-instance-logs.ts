import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { sanitizeLogLine } from "@/lib/sanitize-log-line";

const MAX_LINES = 1000;

/** Log buffer for the selected instance: initial fetch, then live lines. */
export function useInstanceLogs(
  id: string | null,
  subscribeLogs: (l: (id: string, line: string) => void) => () => void,
) {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    setLines([]);
    if (!id) return;
    let cancelled = false;
    const pending: string[] = [];
    let loaded = false;

    const unsubscribe = subscribeLogs((eventId, line) => {
      if (eventId !== id) return;
      const clean = sanitizeLogLine(line);
      if (!loaded) pending.push(clean);
      else setLines((prev) => [...prev, clean].slice(-MAX_LINES));
    });

    api
      .getLogs(id)
      .then(({ lines: initial }) => {
        if (cancelled) return;
        loaded = true;
        setLines(
          [...initial.map(sanitizeLogLine), ...pending].slice(-MAX_LINES),
        );
      })
      .catch(() => {
        if (cancelled) return;
        loaded = true;
        setLines(pending.slice(-MAX_LINES));
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [id, subscribeLogs]);

  const clear = useCallback(() => setLines([]), []);
  return { lines, clear };
}
