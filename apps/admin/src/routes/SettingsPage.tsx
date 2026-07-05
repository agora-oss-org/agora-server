import { TriangleAlert } from "lucide-react";
import { PageHeader } from "../components/ui/PageHeader";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/Tabs";
import { SETTINGS_READ_ONLY, SOCIAL_GRAPH_ENABLED } from "../config";
import { FeedRankingPanel } from "./settings/FeedRankingPanel";
import { WebhooksPanel } from "./settings/WebhooksPanel";
import { ModeratorPanel } from "./settings/ModeratorPanel";
import { StewardPanel } from "./settings/StewardPanel";
import { SocialGraphPanel } from "./settings/SocialGraphPanel";

export function SettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Configure how your project ranks and runs." />
      {SETTINGS_READ_ONLY && (
        <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
          <TriangleAlert className="size-4 shrink-0" />
          View-only mode — settings changes are disabled on this deployment.
        </div>
      )}
      <Tabs defaultValue="feed">
        <TabsList>
          <TabsTrigger value="feed">Feed ranking</TabsTrigger>
          <TabsTrigger value="moderator">Moderator</TabsTrigger>
          <TabsTrigger value="steward">Stewardship</TabsTrigger>
          {SOCIAL_GRAPH_ENABLED && (
            <TabsTrigger value="social">Social graph</TabsTrigger>
          )}
          <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
        </TabsList>

        <TabsContent value="feed" className="mt-6">
          <FeedRankingPanel />
        </TabsContent>
        <TabsContent value="moderator" className="mt-6">
          <ModeratorPanel />
        </TabsContent>
        <TabsContent value="steward" className="mt-6">
          <StewardPanel />
        </TabsContent>
        {SOCIAL_GRAPH_ENABLED && (
          <TabsContent value="social" className="mt-6">
            <SocialGraphPanel />
          </TabsContent>
        )}
        <TabsContent value="webhooks" className="mt-6">
          <WebhooksPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
