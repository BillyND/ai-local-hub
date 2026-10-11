import { memo } from 'react'
import { cn } from '@/lib/utils'
import type { ParsedLog } from '@/lib/parse-log-line'

const LEVEL_TEXT: Record<string, string> = {
  ERROR: 'text-destructive',
  WARN: 'text-amber-600 dark:text-amber-400',
  INFO: 'text-sky-600 dark:text-sky-400',
  DEBUG: 'text-muted-foreground',
}
const ROW_TINT: Record<string, string> = {
  ERROR: 'bg-destructive/10',
  WARN: 'bg-amber-500/10',
}
const WRAP = 'whitespace-pre-wrap [overflow-wrap:anywhere]'

/** One log record: structured records get time, a colored level and dimmed key=value fields. */
export const LogLine = memo(function LogLine({ view }: { view: ParsedLog }) {
  if (!view.structured) return <div className={cn('rounded-sm px-1', WRAP)}>{view.message}</div>
  const level = view.level ?? ''
  return (
    <div className={cn('flex gap-2 rounded-sm px-1', ROW_TINT[level])}>
      {view.time && <span className="shrink-0 text-muted-foreground tabular-nums">{view.time}</span>}
      <span className={cn('w-[5ch] shrink-0 font-semibold', LEVEL_TEXT[level] ?? 'text-muted-foreground')}>{level}</span>
      <span className={cn('min-w-0', WRAP)}>
        <span className="text-foreground">{view.message}</span>
        {view.fields.map((field) => (
          <span key={field.key}>
            {/* a real space, not a margin: it is the soft wrap point between message and fields */}
            {' '}
            <span className="text-muted-foreground">{field.key}=</span>
            <span className="text-foreground/70">{field.value}</span>
          </span>
        ))}
      </span>
    </div>
  )
})
