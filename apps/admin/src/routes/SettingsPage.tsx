import { PageHeader } from "../components/ui/PageHeader";
import { FeedRankingPanel } from "./settings/FeedRankingPanel";

// Settings sections. Feed ranking is the first live slice; project webhooks, spaces/rules, and
// member roles land here next.
export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="Configure how your project ranks and runs." />
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-fg">Feed ranking</h2>
        <FeedRankingPanel />
      </section>
    </>
  );
}
