import type { LucideIcon } from "lucide-react";
import { Card } from "./Card";

export function StatCard({
  label,
  value,
  description,
  icon: Icon,
}: {
  label: string;
  value: string;
  description: string;
  icon: LucideIcon;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
        <Icon className="size-4 shrink-0 text-faint" />
      </div>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-fg">{value}</p>
      <p className="mt-1 text-sm text-faint">{description}</p>
    </Card>
  );
}
