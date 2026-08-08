import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Solid brand-gradient clay button -the app's primary call-to-action look.
        default:
          "clay-btn border-0 bg-gradient-to-br from-[#006496] to-[#0080bf] text-white hover:brightness-105",
        // Pale red clay tint -same tactile weight as default, danger color.
        destructive:
          "clay-btn border-0 bg-red-50 text-red-700 hover:bg-red-100",
        // Pale, bordered clay tint -secondary actions that need a visible edge.
        outline:
          "clay-btn border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100",
        // Pale, borderless clay tint -secondary actions on a plain surface.
        secondary:
          "clay-btn border-0 bg-slate-100 text-slate-700 hover:bg-slate-200",
        // Deliberately left plain -used for dense/inline icon actions (table
        // rows, toolbars) where a heavy clay shadow would be visual noise.
        ghost: "border border-transparent hover:bg-muted/20 hover-elevate active-elevate-2",
        link: "text-primary underline-offset-4 hover:underline hover:bg-primary/10 hover-elevate active-elevate-2",
      },
      size: {
        // changed sizes
        default: "min-h-9 px-4 py-2",
        sm: "min-h-8 rounded-xl px-3 text-xs",
        lg: "min-h-10 rounded-xl px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
