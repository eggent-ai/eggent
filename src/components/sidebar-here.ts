import { cn } from "@/lib/utils";

/**
 * Where the person is, one look for every row of the sidebar: a fill deeper
 * than a hovered row's and a short bar at the left edge in the sidebar's
 * primary colour, which hover never gets. The stock active row used the hover
 * tint, which in light mode is barely darker than the sidebar itself, so
 * "here" read like "under the pointer".
 *
 * Keyed on both ways a row says it is the current one: `data-active` (a
 * SidebarMenuButton's `isActive`) and `aria-current="page"` (a plain link).
 */
export const SIDEBAR_HERE_ROW = cn(
  "relative",
  "data-[active=true]:bg-sidebar-foreground/[0.08]",
  "aria-[current=page]:bg-sidebar-foreground/[0.08] aria-[current=page]:font-medium aria-[current=page]:text-sidebar-accent-foreground",
  "before:pointer-events-none before:absolute before:inset-y-2 before:left-0.5 before:w-[3px] before:rounded-full before:bg-sidebar-primary before:opacity-0",
  "data-[active=true]:before:opacity-100 aria-[current=page]:before:opacity-100"
);
