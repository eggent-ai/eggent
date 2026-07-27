import { Search } from "lucide-react"

import { Label } from "@/components/ui/label"
import { SidebarInput } from "@/components/ui/sidebar"
import { useI18n } from "@/i18n/provider"

export function SearchForm({ ...props }: React.ComponentProps<"form">) {
  const { t } = useI18n()

  return (
    <form {...props}>
      <div className="relative">
        <Label htmlFor="search" className="sr-only">
          {t("nav.search")}
        </Label>
        <SidebarInput
          id="search"
          placeholder={t("nav.searchPlaceholder")}
          className="h-8 pl-7"
        />
        <Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 opacity-50 select-none" />
      </div>
    </form>
  )
}
