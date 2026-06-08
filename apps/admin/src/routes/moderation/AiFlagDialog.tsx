// Review dialog for an AI flag (a services/scorer verdict awaiting human disposition) — the AI-tab
// counterpart to the report ReviewDialog. Loads + shows the flagged content (shared ContentPreview),
// the AI verdict (with on-demand re-analysis), and lets the human Remove (write-back to the API, with
// an optional reason) or Dismiss (false positive — clear the flag, leave the content).
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Bot, Sparkles } from "lucide-react";
import type { Comment, Entity, ModerationAnalysis, ModerationVerdict } from "@agora-server/contract";
import { contentDeepLink, getTargetContent } from "../../lib/moderation";
import { analyzeTarget, dismissAnalysis, removeFlagged, targetText } from "../../lib/moderation-ai";
import { ApiError } from "../../lib/api";
import { track } from "../../lib/analytics";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Input } from "../../components/ui/Input";
import { LoadingPanel } from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { shortId } from "../../lib/time";
import { ContentPreview } from "./ContentPreview";
import { Poster } from "./Poster";

const VERDICT_BADGE: Record<ModerationVerdict, "success" | "danger" | "warning"> = {
  allow: "success",
  block: "danger",
  review: "warning",
};

function targetTitle(analysis: ModerationAnalysis, target: Entity | Comment | null): string {
  if (analysis.targetType === "entity") return (target as Entity | null)?.title || "(untitled entity)";
  if (analysis.targetType === "comment") return "Comment";
  return `${analysis.targetType} ${shortId(analysis.targetId)}`;
}

export function AiFlagDialog({ analysis, onClose }: { analysis: ModerationAnalysis | null; onClose: () => void }) {
  const open = !!analysis;
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState("");
  // The displayed verdict — seeded from the row, replaced when the operator re-analyzes.
  const [current, setCurrent] = useState<ModerationAnalysis | null>(analysis);

  useEffect(() => {
    setCurrent(analysis);
    setReason("");
  }, [analysis?.id]);

  const targetQuery = useQuery({
    queryKey: ["flag-target", analysis?.targetType, analysis?.targetId],
    queryFn: () => getTargetContent(analysis!.targetType, analysis!.targetId),
    enabled: open,
  });
  const target = targetQuery.data ?? null;

  const removable = analysis?.targetType === "entity" || analysis?.targetType === "comment";
  const deepLink = analysis ? contentDeepLink(analysis.targetType, analysis.targetId, target) : null;

  const invalidateQueue = () => qc.invalidateQueries({ queryKey: ["ai-queue"] });

  const remove = useMutation({
    mutationFn: () => removeFlagged(analysis!.id, reason.trim() || undefined),
    onSuccess: () => { track("admin-moderation-action", { surface: "ai-flag", action: "removed", targetType: analysis!.targetType }); toast({ title: "Content removed", variant: "danger" }); invalidateQueue(); onClose(); },
    onError: (e) => toast({ title: "Couldn't remove", description: e instanceof ApiError || e instanceof Error ? e.message : undefined, variant: "danger" }),
  });
  const dismiss = useMutation({
    mutationFn: () => dismissAnalysis(analysis!.id),
    onSuccess: () => { track("admin-moderation-action", { surface: "ai-flag", action: "dismiss", targetType: analysis!.targetType }); toast({ title: "Flag dismissed", variant: "success" }); invalidateQueue(); onClose(); },
    onError: (e) => toast({ title: "Couldn't dismiss", description: e instanceof ApiError || e instanceof Error ? e.message : undefined, variant: "danger" }),
  });

  const text = analysis ? targetText(analysis.targetType, target) : "";
  const reanalyze = useMutation({
    mutationFn: () => analyzeTarget({ targetType: analysis!.targetType, targetId: analysis!.targetId, spaceId: analysis!.spaceId, text }),
    onSuccess: (a) => { track("admin-reanalyze", { surface: "ai-flag", targetType: analysis!.targetType }); setCurrent(a); },
    onError: (e) => toast({ title: "Analysis failed", description: e instanceof Error ? e.message : undefined, variant: "danger" }),
  });

  const busy = remove.isPending || dismiss.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Bot className="size-4 text-primary" />
            Review AI flag · {analysis?.targetType}
          </DialogTitle>
          <DialogDescription>
            Flagged by the moderator{current ? ` — ${current.verdict} (${Math.round(current.confidence * 100)}%)` : ""}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="min-h-0 flex-1 overflow-y-auto">
          {analysis ? (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border border-border bg-bg px-4 py-2.5 text-sm">
              <span className="text-muted">Posted by <Poster user={analysis.author} bold /></span>
              <span className="text-muted">Flagged by <span className="font-medium text-fg">the moderator (AI)</span></span>
            </div>
          ) : null}
          {targetQuery.isLoading ? (
            <LoadingPanel label="Loading content…" />
          ) : (
            <>
              {analysis ? (
                <ContentPreview
                  targetType={analysis.targetType}
                  target={target}
                  isError={targetQuery.isError}
                  title={targetTitle(analysis, target)}
                  deepLink={deepLink}
                />
              ) : null}

              {/* AI verdict — what the moderator decided, with an on-demand re-run. */}
              <div className="space-y-2 rounded-lg border border-border bg-bg p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-fg">
                    <Bot className="size-4 text-primary" /> AI assessment
                  </p>
                  <Button variant="ghost" onClick={() => reanalyze.mutate()} disabled={reanalyze.isPending || !removable || !text}>
                    <Sparkles className="size-3.5" /> {reanalyze.isPending ? "Analyzing…" : "Re-analyze"}
                  </Button>
                </div>
                {current ? (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={VERDICT_BADGE[current.verdict]}>{current.verdict}</Badge>
                      <span className="text-xs text-muted">{Math.round(current.confidence * 100)}% confidence</span>
                      {current.autoActioned ? <Badge variant="danger">auto-removed</Badge> : null}
                      {current.categories.map((cat) => (
                        <Badge key={cat} variant="default">{cat}</Badge>
                      ))}
                    </div>
                    {current.reason ? <p className="whitespace-pre-wrap break-words text-sm text-muted">{current.reason}</p> : null}
                    <p className="text-xs text-faint">{current.model}</p>
                  </div>
                ) : null}
              </div>

              <dl className="grid grid-cols-2 gap-3 text-sm">
                <Meta label="Target type" value={analysis?.targetType} />
                <Meta label="Space" value={analysis?.spaceId ? shortId(analysis.spaceId) : "project-level"} />
                <Meta label="Target id" value={shortId(analysis?.targetId)} mono />
                <Meta label="Flagged" value={current ? new Date(current.createdAt).toLocaleString() : undefined} />
              </dl>

              {removable ? (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted">Removal reason (optional)</label>
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Overrides the AI's reason on the removal" />
                </div>
              ) : (
                <p className="text-xs text-faint">
                  {analysis?.targetType} content can't be removed from here — dismiss the flag or action it in chat.
                </p>
              )}
            </>
          )}
        </DialogBody>

        <DialogFooter className="shrink-0">
          <Button variant="ghost" onClick={() => dismiss.mutate()} disabled={busy}>
            Dismiss
          </Button>
          <Button variant="danger" onClick={() => remove.mutate()} disabled={busy || !removable}>
            <Ban /> Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Meta({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-faint">{label}</dt>
      <dd className={mono ? "font-mono text-xs text-fg" : "text-fg"}>{value || "—"}</dd>
    </div>
  );
}
