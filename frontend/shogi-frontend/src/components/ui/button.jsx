// src/components/ui/button.jsx
import * as React from "react";
import { cn } from "@/lib/utils";

// かんたん実装の buttonVariants（依存なし）
export function buttonVariants({ variant = "default", size = "default", className = "" } = {}) {
  const base =
    "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium " +
    "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
    "focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 ring-offset-background";

  const variants = {
    default:   "bg-primary text-primary-foreground hover:bg-primary/90",
    secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
    destructive:"bg-destructive text-destructive-foreground hover:bg-destructive/90",
    outline:   "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
    ghost:     "hover:bg-accent hover:text-accent-foreground",
    link:      "text-primary underline-offset-4 hover:underline",
  };

  const sizes = {
    default: "h-10 px-4 py-2",
    sm:      "h-9 rounded-md px-3",
    lg:      "h-11 rounded-md px-8",
    icon:    "h-10 w-10",
  };

  return cn(base, variants[variant] || variants.default, sizes[size] || sizes.default, className);
}

// ふつうの Button もいっしょに出すね
export function Button({ className, variant, size, ...props }) {
  return <button className={buttonVariants({ variant, size, className })} {...props} />;
}
