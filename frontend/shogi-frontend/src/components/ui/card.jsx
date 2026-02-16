import * as React from "react";

import { cn } from "@/lib/utils";

export const Card = ({ className, children, ...props }) => (
  <div className={cn("rounded-xl border shadow-sm p-4", className)} {...props}>
    {children}
  </div>
);

export const CardHeader = ({ className, children, ...props }) => (
  <div className={cn("mb-2", className)} {...props}>
    {children}
  </div>
);

export const CardTitle = ({ className, children, ...props }) => (
  <h3 className={cn("font-semibold text-lg", className)} {...props}>
    {children}
  </h3>
);

export const CardDescription = ({ className, children, ...props }) => (
  <p className={cn("text-sm opacity-80", className)} {...props}>
    {children}
  </p>
);

export const CardContent = ({ className, children, ...props }) => (
  <div className={cn("py-2", className)} {...props}>
    {children}
  </div>
);

export const CardFooter = ({ className, children, ...props }) => (
  <div className={cn("mt-2", className)} {...props}>
    {children}
  </div>
);

export default Card;
