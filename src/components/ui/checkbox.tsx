"use client"

import * as React from "react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"
import { CheckIcon, MinusIcon } from "lucide-react"

import { cn } from "@/lib/utils"

const boxClass =
  "peer relative flex size-4 shrink-0 items-center justify-center rounded-[5px] border border-input transition-colors outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-white data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-white dark:data-[state=checked]:bg-primary dark:data-[state=indeterminate]:bg-primary"

function Checkbox({
  className,
  checked,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      checked={checked}
      className={cn(boxClass, className)}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none [&>svg]:size-3.5"
      >
        {checked === "indeterminate" ? <MinusIcon /> : <CheckIcon />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

/** Purely visual checkbox, for rows that are themselves the interactive control
    (a real checkbox is a <button> and can't be nested inside another one). */
function CheckboxVisual({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      data-state={checked ? "checked" : "unchecked"}
      className={cn(boxClass, "after:hidden", className)}
    >
      {checked && <CheckIcon className="size-3.5" />}
    </span>
  )
}

export { Checkbox, CheckboxVisual }
