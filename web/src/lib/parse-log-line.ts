export interface LogField {
  key: string
  value: string
}

export interface ParsedLog {
  /** True for structured (JSON) records such as the tunnel client's slog output. */
  structured: boolean
  time?: string
  level?: string
  message: string
  fields: LogField[]
}

const RESERVED = new Set(['time', 'level', 'msg', 'message'])

function formatTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function normalizeLevel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const level = value.toUpperCase()
  return level === 'WARNING' ? 'WARN' : level
}

/** Turns a JSON log record into time/level/message/fields; any other line stays plain text. */
export function parseLogLine(line: string): ParsedLog {
  const text = line.trim()
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const record: unknown = JSON.parse(text)
      if (typeof record === 'object' && record !== null && !Array.isArray(record)) {
        const fields = record as Record<string, unknown>
        const message = fields.msg ?? fields.message
        if (typeof message === 'string') {
          return {
            structured: true,
            time: formatTime(fields.time),
            level: normalizeLevel(fields.level),
            message,
            fields: Object.entries(fields)
              .filter(([key]) => !RESERVED.has(key))
              .map(([key, value]) => ({ key, value: formatValue(value) })),
          }
        }
      }
    } catch {
      /* not JSON: fall through to plain text */
    }
  }
  return { structured: false, message: line, fields: [] }
}
