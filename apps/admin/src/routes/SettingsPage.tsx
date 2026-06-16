import { PageHeader } from "../components/ui/PageHeader";
import { SETTINGS_READ_ONLY, SOCIAL_GRAPH_ENABLED } from "../config";
import { FeedRankingPanel } from "./settings/FeedRankingPanel";
import { WebhooksPanel } from "./settings/WebhooksPanel";
import { ModeratorPanel } from "./settings/ModeratorPanel";
import { StewardPanel } from "./settings/StewardPanel";
import { SocialGraphPanel } from "./settings/SocialGraphPanel";

// Settings sections. Feed ranking, the automated moderator, and project webhooks are live.
export function SettingsPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Settings" description="Configure how your project ranks and runs." />
      {SETTINGS_READ_ONLY && (
        <div className="rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm text-muted">
          View-only mode — settings changes are disabled on this deployment.
        </div>
      )}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-fg">Feed ranking</h2>
        <FeedRankingPanel />
      </section>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-fg">Moderator (automated)</h2>
        <ModeratorPanel />
      </section>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-fg">Stewardship</h2>
        <StewardPanel />
      </section>
      {SOCIAL_GRAPH_ENABLED && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-fg">Social graph</h2>
          <SocialGraphPanel />
        </section>
      )}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-fg">Project webhooks</h2>
        <WebhooksPanel />
      </section>
    </div>
  );
}
