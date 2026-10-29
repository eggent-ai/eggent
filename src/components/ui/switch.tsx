"use client";

import type { ComponentProps } from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex h-6 min-h-6 w-10 min-w-10 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input p-0.5 transition-colors data-[state=checked]:bg-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 after:absolute after:-inset-y-2.5 after:-inset-x-0.5",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-[18px] rounded-full bg-primary-foreground shadow-xs transition-transform duration-160 ease-out data-[state=checked]:translate-x-4" />
    </SwitchPrimitive.Root>
  );
}
