import { BarChart3, LayoutDashboard, ShieldAlert, Settings, type LucideIcon } from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** End-to-end exact match for the index route. */
  end?: boolean;
  /** Only shown to deployment operators (the route's data is operator-gated server-side). */
  operatorOnly?: boolean;
}

// Most sections show for both personas (operator + owner/moderator); the *content* adapts to role
// (operator god-view vs space-scoped). `operatorOnly` items are filtered out for non-operators.
export const NAV_ITEMS: NavItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/analytics", label: "Analytics", icon: BarChart3, operatorOnly: true },
  { to: "/moderation", label: "Moderation", icon: ShieldAlert },
  { to: "/settings", label: "Settings", icon: Settings },
];
