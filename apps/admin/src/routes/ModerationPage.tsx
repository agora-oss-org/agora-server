import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, ChevronLeft, ChevronRight, Inbox, ShieldCheck } from "lucide-react";
import type { ModerationAnalysis, ModerationVerdict, Report } from "@agora/contract";
import { useAuth } from "../auth/AuthContext";
import { listReports, reportsKey, type ReportStatus } from "../lib/moderation";
import { aiQueueKey, dismissAnalysis, listAiQueue, removeFlagged } from "../lib/moderation-ai";
import { relativeTime, shortId } from "../lib/time";
import { PageHeader } from "../components/ui/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/Tabs";
import { Table, TBody, THead, Th, Td, Tr } from "../components/ui/Table";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { LoadingPanel } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { ApiError } from "../lib/api";
import { ReviewDialog } from "./moderation/ReviewDialog";

const VERDICT_BADGE: Record<ModerationVerdict, "success" | "danger" | "warning"> = {
  allow: "success",
  block: "danger",
  review: "warning",
};

type ModTab = ReportStatus | "ai";

export function ModerationPage() {
  const { isOperator } = useAuth();
  const [tab, setTab] = useState<ModTab>("pending");
  const [reviewing, setReviewing] = useState<Report | null>(null);

  return (
    <>
      <PageHeader
        title="Moderation"
        description={
          isOperator
            ? "Every reported item across the project."
            : "Reports filed against spaces you own or moderate."
        }
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as ModTab)}>
        <TabsList>
          <TabsTrigger value="pending">
            <Inbox className="size-4" /> Open
          </TabsTrigger>
          <TabsTrigger value="moderated">
            <ShieldCheck className="size-4" /> Resolved
          </TabsTrigger>
          <TabsTrigger value="ai">
            <Bot className="size-4" /> AI flags
          </TabsTrigger>
        </TabsList>

        <TabsContent value="pending" className="mt-4 focus:outline-none">
          <ReportsTable status="pending" onReview={setReviewing} />
        </TabsContent>
        <TabsContent value="moderated" className="mt-4 focus:outline-none">
          <ReportsTable status="moderated" />
        </TabsContent>
        <TabsContent value="ai" className="mt-4 focus:outline-none">
          <AiFlagsTable />
        </TabsContent>
      </Tabs>

      <ReviewDialog report={reviewing} onClose={() => setReviewing(null)} />
    </>
  );
}

function ReportsTable({ status, onReview }: { status: ReportStatus; onReview?: (r: Report) => void }) {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: reportsKey(status, page),
    queryFn: () => listReports(status, page),
    placeholderData: keepPreviousData,
  });

  if (query.isLoading) return <LoadingPanel />;
  if (query.isError) {
    const msg = query.error instanceof ApiError ? query.error.message : "Failed to load reports.";
    return <EmptyState icon={Inbox} title="Couldn't load reports" description={msg} />;
  }

  const reports = query.data?.data ?? [];
  const meta = query.data?.pagination;

  if (reports.length === 0) {
    return (
      <EmptyState
        icon={status === "pending" ? Inbox : ShieldCheck}
        title={status === "pending" ? "Inbox zero" : "Nothing resolved yet"}
        description={
          status === "pending"
            ? "There are no open reports to review."
            : "Resolved reports will appear here."
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      <Table>
        <THead>
          <Tr className="hover:bg-transparent">
            <Th>Target</Th>
            <Th>Reason</Th>
            <Th>Space</Th>
            <Th>{status === "pending" ? "Reported" : "Resolved"}</Th>
            <Th className="text-right">{status === "pending" ? "Action" : "By"}</Th>
          </Tr>
        </THead>
        <TBody>
          {reports.map((r) => (
            <Tr key={r.id}>
              <Td>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{r.targetType}</Badge>
                  <span className="font-mono text-xs text-muted">{shortId(r.targetId)}</span>
                </div>
              </Td>
              <Td className="max-w-[16rem] truncate text-muted">{r.reason}</Td>
              <Td className="text-muted">{r.spaceId ? shortId(r.spaceId) : <span className="text-faint">project</span>}</Td>
              <Td className="text-muted">{relativeTime(status === "pending" ? r.createdAt : r.resolvedAt)}</Td>
              <Td className="text-right">
                {status === "pending" ? (
                  <Button size="sm" variant="outline" onClick={() => onReview?.(r)}>
                    Review
                  </Button>
                ) : (
                  <span className="font-mono text-xs text-faint">{shortId(r.resolvedById)}</span>
                )}
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>

      {meta && meta.totalPages > 1 ? (
        <div className="flex items-center justify-between text-sm text-muted">
          <span>
            Page {meta.page} of {meta.totalPages} · {meta.totalItems} total
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft /> Prev
            </Button>
            <Button size="sm" variant="outline" disabled={!meta.hasMore} onClick={() => setPage((p) => p + 1)}>
              Next <ChevronRight />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// The AI-flag queue: content the @agora/moderator service flagged (block/review) that no human has
// dispositioned yet. Each row can be confirmed (remove the content) or dismissed (false positive).
function AiFlagsTable() {
  const [page, setPage] = useState(1);
  const qc = useQueryClient();
  const toast = useToast();
  const query = useQuery({
    queryKey: aiQueueKey(page),
    queryFn: () => listAiQueue(page),
    placeholderData: keepPreviousData,
    retry: false,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["ai-queue"] });
  const remove = useMutation({
    mutationFn: (id: string) => removeFlagged(id),
    onSuccess: () => { toast({ title: "Content removed", variant: "danger" }); invalidate(); },
    onError: (e) => toast({ title: "Couldn't remove", description: e instanceof Error ? e.message : undefined, variant: "danger" }),
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => dismissAnalysis(id),
    onSuccess: () => { toast({ title: "Flag dismissed", variant: "success" }); invalidate(); },
    onError: (e) => toast({ title: "Couldn't dismiss", description: e instanceof Error ? e.message : undefined, variant: "danger" }),
  });
  const busy = remove.isPending || dismiss.isPending;

  if (query.isLoading) return <LoadingPanel />;
  if (query.isError) {
    const msg = query.error instanceof ApiError ? query.error.message : "The moderator service is unavailable.";
    return <EmptyState icon={Bot} title="Couldn't load AI flags" description={msg} />;
  }

  const items = query.data?.data ?? [];
  const meta = query.data?.pagination;

  if (items.length === 0) {
    return <EmptyState icon={Bot} title="No AI flags" description="The moderator hasn't flagged anything for review." />;
  }

  return (
    <div className="space-y-3">
      <Table>
        <THead>
          <Tr className="hover:bg-transparent">
            <Th>Target</Th>
            <Th>Verdict</Th>
            <Th>Reason</Th>
            <Th>Flagged</Th>
            <Th className="text-right">Action</Th>
          </Tr>
        </THead>
        <TBody>
          {items.map((a: ModerationAnalysis) => (
            <Tr key={a.id}>
              <Td>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{a.targetType}</Badge>
                  <span className="font-mono text-xs text-muted">{shortId(a.targetId)}</span>
                </div>
              </Td>
              <Td>
                <div className="flex items-center gap-1.5">
                  <Badge variant={VERDICT_BADGE[a.verdict]}>{a.verdict}</Badge>
                  <span className="text-xs text-faint">{Math.round(a.confidence * 100)}%</span>
                </div>
              </Td>
              <Td className="max-w-[18rem] truncate text-muted">{a.reason}</Td>
              <Td className="text-muted">{relativeTime(a.createdAt)}</Td>
              <Td className="text-right">
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => dismiss.mutate(a.id)}>
                    Dismiss
                  </Button>
                  <Button size="sm" variant="danger" disabled={busy} onClick={() => remove.mutate(a.id)}>
                    Remove
                  </Button>
                </div>
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>

      {meta && meta.totalPages > 1 ? (
        <div className="flex items-center justify-between text-sm text-muted">
          <span>
            Page {meta.page} of {meta.totalPages} · {meta.totalItems} total
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft /> Prev
            </Button>
            <Button size="sm" variant="outline" disabled={!meta.hasMore} onClick={() => setPage((p) => p + 1)}>
              Next <ChevronRight />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
