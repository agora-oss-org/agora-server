import { PageHeader } from "../components/ui/PageHeader";
import { FeedRankingPanel } from "./settings/FeedRankingPanel";
import { WebhooksPanel } from "./settings/WebhooksPanel";
import { ModeratorPanel } from "./settings/ModeratorPanel";

// Settings sections. Feed ranking, the automated moderator, and project webhooks are live.
export function SettingsPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Settings" description="Configure how your project ranks and runs." />
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-fg">Feed ranking</h2>
        <FeedRankingPanel />
      </section>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-fg">Moderator (automated)</h2>
        <ModeratorPanel />
      </section>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-fg">Project webhooks</h2>
        <WebhooksPanel />
      </section>
    </div>
  );
}
