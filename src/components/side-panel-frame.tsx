"use client";

import type { ComponentPropsWithoutRef } from "react";
import { useRef } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

/** Dock when the workspace has room; overlay tools on phones and tablets. */
export function SidePanelFrame({
  open,
  onOpenChange,
  label,
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"aside"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
}) {
  const mobile = useIsMobile(1280);
  const returnFocus = useRef<HTMLElement | null>(null);

  if (mobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          showCloseButton={false}
          aria-describedby={undefined}
          onOpenAutoFocus={() => { returnFocus.current = document.activeElement as HTMLElement | null; }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnFocus.current?.isConnected) returnFocus.current.focus();
          }}
          className={`${className ?? ""} gap-0 p-0 sm:max-w-none`}
          {...props}
        >
          <SheetTitle className="sr-only">{label}</SheetTitle>
          {children}
        </SheetContent>
      </Sheet>
    );
  }

  return <aside aria-label={label} className={className} {...props}>{children}</aside>;
}
