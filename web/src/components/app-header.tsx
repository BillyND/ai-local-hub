import { HeaderActions } from '@/components/header-actions'
import { HeaderBrand } from '@/components/header-brand'

export function AppHeader() {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <HeaderBrand />
      <HeaderActions />
    </header>
  )
}
