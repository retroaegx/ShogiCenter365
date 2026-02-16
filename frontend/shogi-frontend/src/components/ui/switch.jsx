"use client"

import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

const Switch = React.forwardRef(function Switch(
  { className, ...props },
  ref
) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      data-slot="switch"
      className={cn(
        // Use explicit colors so the toggle remains visible even if theme variables are white-on-white.
        "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors " +
          "border-slate-300 bg-slate-200 data-[state=checked]:bg-slate-800 " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 " +
          "disabled:cursor-not-allowed disabled:opacity-50 " +
          "dark:border-slate-600 dark:bg-slate-700 dark:data-[state=checked]:bg-slate-200 dark:focus-visible:ring-slate-300",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block h-5 w-5 rounded-full bg-white border border-slate-300 shadow transition-transform " +
            "data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0 " +
            "dark:bg-slate-900 dark:border-slate-600"
        )}
      />
    </SwitchPrimitive.Root>
  )
})

Switch.displayName = "Switch"

export { Switch }
