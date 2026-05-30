import * as RDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export const Dialog = RDialog.Root;
export const DialogTrigger = RDialog.Trigger;
export const DialogClose = RDialog.Close;

export const DialogContent = forwardRef<
  React.ElementRef<typeof RDialog.Content>,
  React.ComponentPropsWithoutRef<typeof RDialog.Content>
>(({ className, children, ...props }, ref) => (
  <RDialog.Portal>
    <RDialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out" />
    <RDialog.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-card)]",
        "border border-border bg-surface shadow-2xl focus:outline-none",
        className,
      )}
      {...props}
    >
      {children}
      <RDialog.Close className="absolute right-4 top-4 text-faint transition-colors hover:text-fg" aria-label="Close">
        <X className="size-4" />
      </RDialog.Close>
    </RDialog.Content>
  </RDialog.Portal>
));
DialogContent.displayName = "DialogContent";

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 border-b border-border p-5", className)} {...props} />;
}

export function DialogTitle({ className, ...props }: React.ComponentPropsWithoutRef<typeof RDialog.Title>) {
  return <RDialog.Title className={cn("text-base font-semibold text-fg", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: React.ComponentPropsWithoutRef<typeof RDialog.Description>) {
  return <RDialog.Description className={cn("text-sm text-muted", className)} {...props} />;
}

export function DialogBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("space-y-4 p-5", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-wrap items-center justify-end gap-2 border-t border-border p-5", className)} {...props} />;
}
