import * as RTabs from "@radix-ui/react-tabs";
import { forwardRef } from "react";
import { cn } from "../../lib/cn";

export const Tabs = RTabs.Root;
export const TabsContent = RTabs.Content;

export const TabsList = forwardRef<
  React.ElementRef<typeof RTabs.List>,
  React.ComponentPropsWithoutRef<typeof RTabs.List>
>(({ className, ...props }, ref) => (
  <RTabs.List
    ref={ref}
    className={cn("inline-flex items-center gap-1 rounded-lg border border-border bg-surface p-1", className)}
    {...props}
  />
));
TabsList.displayName = "TabsList";

export const TabsTrigger = forwardRef<
  React.ElementRef<typeof RTabs.Trigger>,
  React.ComponentPropsWithoutRef<typeof RTabs.Trigger>
>(({ className, ...props }, ref) => (
  <RTabs.Trigger
    ref={ref}
    className={cn(
      "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-muted transition-colors",
      "hover:text-fg data-[state=active]:bg-elevated data-[state=active]:text-fg",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = "TabsTrigger";
