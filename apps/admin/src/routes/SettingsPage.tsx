import { PageHeader } from "../components/ui/PageHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { Settings } from "lucide-react";

// Placeholder — spaces/rules/members config lands here in a later slice.
export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="Project, spaces, rules, and member roles." />
      <EmptyState icon={Settings} title="Settings coming soon" description="This section will configure spaces, moderation rules, and member roles." />
    </>
  );
}
