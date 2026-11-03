import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-12 w-full min-w-0 rounded-xl border border-transparent bg-[#f5f5f7] px-4 py-3 text-base text-[#1d1d1f] shadow-none font-normal transition-all duration-300 ease-[cubic-bezier(0.25,0.1,0.25,1)] selection:bg-[#0071e3] selection:text-white file:mr-3 file:inline-flex file:h-8 file:rounded-full file:border-0 file:bg-white file:px-3 file:text-sm file:font-medium file:text-[#1d1d1f] placeholder:text-[#6e6e73] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus:outline-none focus:ring-2 focus:ring-[#0071e3]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071e3]/30",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className
      )}
      {...props}
    />
  )
}

export { Input }
