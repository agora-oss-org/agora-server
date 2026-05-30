// Minimal toast system on Radix Toast. Wrap the app in <ToastProvider>, then call `toast(...)`
// from the useToast() hook anywhere. Used for moderation action feedback (success/error).
import * as RToast from "@radix-ui/react-toast";
import { X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";

type ToastVariant = "default" | "success" | "danger";

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
}

interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
}

const ToastCtx = createContext<(t: ToastInput) => void>(() => {});

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const toast = useCallback((input: ToastInput) => {
    setItems((prev) => [...prev, { id: nextId++, variant: "default", ...input }]);
  }, []);

  const value = useMemo(() => toast, [toast]);

  return (
    <ToastCtx.Provider value={value}>
      <RToast.Provider swipeDirection="right" duration={4500}>
        {children}
        {items.map((t) => (
          <RToast.Root
            key={t.id}
            onOpenChange={(open) => {
              if (!open) setItems((prev) => prev.filter((x) => x.id !== t.id));
            }}
            className={cn(
              "flex items-start gap-3 rounded-lg border bg-elevated p-4 shadow-lg",
              "data-[state=open]:animate-in data-[state=closed]:animate-out data-[swipe=end]:animate-out",
              t.variant === "success" && "border-success/40",
              t.variant === "danger" && "border-danger/40",
              t.variant === "default" && "border-border",
            )}
          >
            <div className="flex-1 space-y-0.5">
              <RToast.Title className="text-sm font-medium text-fg">{t.title}</RToast.Title>
              {t.description ? (
                <RToast.Description className="text-xs text-muted">{t.description}</RToast.Description>
              ) : null}
            </div>
            <RToast.Close className="text-faint transition-colors hover:text-fg" aria-label="Dismiss">
              <X className="size-4" />
            </RToast.Close>
          </RToast.Root>
        ))}
        <RToast.Viewport className="fixed bottom-0 right-0 z-50 flex w-96 max-w-[100vw] flex-col gap-2 p-4 outline-none" />
      </RToast.Provider>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
