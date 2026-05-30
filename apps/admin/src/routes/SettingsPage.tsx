import { PageHeader } from "../components/ui/PageHeader";
import { FeedRankingPanel } from "./settings/FeedRankingPanel";
import { WebhooksPanel } from "./settings/WebhooksPanel";
import { ModerationPanel } from "./settings/ModerationPanel";

// Settings sections. Feed ranking, project webhooks, and moderation are live; spaces/rules next.
export function SettingsPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Settings" description="Configure how your project ranks and runs." />
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-fg">Feed ranking</h2>
        <FeedRankingPanel />
      </section>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-fg">Moderation</h2>
        <ModerationPanel />
      </section>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-fg">Project webhooks</h2>
        <WebhooksPanel />
      </section>
    </div>
  );
}
