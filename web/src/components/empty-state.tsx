import { PlusIcon, ServerOffIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

export function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <Card className="items-center gap-3 border-dashed py-12 text-center shadow-none">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <ServerOffIcon className="size-6" />
      </div>
      <h2 className="text-lg font-semibold">No instances yet</h2>
      <p className="max-w-sm px-4 text-sm text-muted-foreground">
        Each instance connects one ChatGPT account through one OpenAI tunnel to a workspace folder on this machine.
      </p>
      <Button onClick={onAdd}><PlusIcon />Add instance</Button>
    </Card>
  )
}
