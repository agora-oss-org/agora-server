import { LayoutDashboard, ShieldAlert, Settings, type LucideIcon } from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** End-to-end exact match for the index route. */
  end?: boolean;
}

// Both personas (operator + owner/moderator) see the same sections; the *content* of each adapts to
// role (operator god-view vs space-scoped). Add new sections here.
export const NAV_ITEMS: NavItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/moderation", label: "Moderation", icon: ShieldAlert },
  { to: "/settings", label: "Settings", icon: Settings },
];
