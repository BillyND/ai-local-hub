import { parseLogLine, type ParsedLog } from "@/lib/parse-log-line";
import { sanitizeLogLine } from "@/lib/sanitize-log-line";

export interface LogEntry {
  /** Stable React key; survives the buffer dropping its oldest lines. */
  id: number;
  raw: string;
  view: ParsedLog;
}

let nextId = 0;

/** Sanitizes and parses a line; blank lines (the tunnel client prints many) are dropped. */
export function toLogEntry(line: string): LogEntry | null {
  const raw = sanitizeLogLine(line);
  return raw.trim() === ""
    ? null
    : { id: nextId++, raw, view: parseLogLine(raw) };
}
