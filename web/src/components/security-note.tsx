import { ShieldAlertIcon } from 'lucide-react'

export function SecurityNote() {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-foreground/80">
      <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
      <span>
        Each instance gives the connected ChatGPT account full shell and filesystem access on this machine. Only add accounts you trust.
      </span>
    </p>
  )
}
