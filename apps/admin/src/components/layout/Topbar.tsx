import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, LogOut, User as UserIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { cn } from "../../lib/cn";

export function Topbar() {
  const { user, session, signOut } = useAuth();
  const navigate = useNavigate();
  const label = user?.name || user?.username || user?.email || "Account";

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface/60 px-6 backdrop-blur">
      <div className="flex items-center gap-3 text-xs text-faint">
        <span>
          project <code className="rounded bg-surface-2 px-1.5 py-0.5 text-muted">{session?.projectId}</code>
        </span>
        <code className="rounded bg-surface-2 px-1.5 py-0.5 text-muted" title="Admin app version">
          v{__APP_VERSION__}
        </code>
      </div>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          className={cn(
            "flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-fg outline-none",
            "hover:bg-surface-2 data-[state=open]:bg-surface-2",
          )}
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-primary/20 text-primary">
            <UserIcon className="size-4" />
          </span>
          <span className="max-w-[12rem] truncate">{label}</span>
          <ChevronDown className="size-4 text-faint" />
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="z-50 w-56 rounded-lg border border-border bg-elevated p-1 shadow-xl"
          >
            <div className="px-2 py-2">
              <p className="truncate text-sm font-medium text-fg">{label}</p>
              {user?.email ? <p className="truncate text-xs text-muted">{user.email}</p> : null}
            </div>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <DropdownMenu.Item
              onSelect={async () => {
                await signOut();
                navigate("/login", { replace: true });
              }}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg outline-none data-[highlighted]:bg-danger/15 data-[highlighted]:text-danger"
            >
              <LogOut className="size-4" />
              Sign out
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </header>
  );
}
