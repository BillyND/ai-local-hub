import { Card } from '@/components/ui/card'
import { LogPanelHeader } from '@/components/log-panel-header'
import { LogViewport } from '@/components/log-viewport'
import { Separator } from '@/components/ui/separator'

export function LogPanel() {
  return (
    <Card className="h-[min(28rem,60dvh)] min-h-0 min-w-0 gap-0 overflow-hidden py-0 lg:h-full">
      <LogPanelHeader />
      <Separator />
      <LogViewport />
    </Card>
  )
}
