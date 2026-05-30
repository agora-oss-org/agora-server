import { NavLink } from "react-router-dom";
import { Hexagon } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { Badge } from "../ui/Badge";
import { cn } from "../../lib/cn";
import { NAV_ITEMS } from "./nav";

export function Sidebar() {
  const { isOperator } = useAuth();

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex h-14 items-center gap-2 border-b border-border px-5">
        <Hexagon className="size-5 text-primary" />
        <span className="font-semibold tracking-tight text-fg">Agora</span>
        <span className="text-xs text-faint">admin</span>
      </div>

      <nav className="flex-1 space-y-1 p-3">
        {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive ? "bg-primary/15 text-primary" : "text-muted hover:bg-surface-2 hover:text-fg",
              )
            }
          >
            <Icon className="size-4 shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-border p-3">
        <Badge variant={isOperator ? "primary" : "muted"} className="w-full justify-center py-1">
          {isOperator ? "Operator" : "Moderator"}
        </Badge>
      </div>
    </aside>
  );
}
