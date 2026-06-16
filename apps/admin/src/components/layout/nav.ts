import { Activity, BarChart3, LayoutDashboard, Scale, ShieldAlert, Settings, HelpCircle, type LucideIcon } from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** End-to-end exact match for the index route. */
  end?: boolean;
  /** Only shown to deployment operators (the route's data is operator-gated server-side). */
  operatorOnly?: boolean;
  /** Shown to project admins (and owners/operators) — the route's data is project-admin-gated server-side. */
  projectAdminOnly?: boolean;
  /** Shown to project owners (and operators) — the route mutates grants, owner-gated server-side. */
  projectOwnerOnly?: boolean;
  /** Shown to stewards (and operators) — the route is steward||operator-gated server-side. */
  stewardOnly?: boolean;
}

// Most sections show for both personas (operator + owner/moderator); the *content* adapts to role
// (operator god-view vs space-scoped). `operatorOnly` items are filtered out for non-operators.
export const NAV_ITEMS: NavItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/community", label: "Community", icon: Activity, projectAdminOnly: true },
  { to: "/analytics", label: "Analytics", icon: BarChart3, operatorOnly: true },
  { to: "/moderation", label: "Moderation", icon: ShieldAlert },
  { to: "/steward", label: "Steward", icon: Scale, stewardOnly: true },
  { to: "/settings", label: "Settings", icon: Settings },
  { to: "/help", label: "Help", icon: HelpCircle },
];
