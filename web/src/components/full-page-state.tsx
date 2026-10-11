import type { ReactNode } from 'react'

export function FullPageState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-6">{icon}</div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {children && <p className="text-sm text-muted-foreground">{children}</p>}
      </div>
    </main>
  )
}
