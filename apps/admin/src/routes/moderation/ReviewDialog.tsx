import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Ban, Check, Flag, Paperclip } from "lucide-react";
import type { Comment, Entity, Report } from "@agora/contract";
import { actOnReport, getReportTarget, type ModerationDecision } from "../../lib/moderation";
import { ApiError } from "../../lib/api";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Input } from "../../components/ui/Input";
import { LoadingPanel } from "../../components/ui/Spinner";
import { useToast } from "../../components/ui/Toast";
import { useAuth } from "../../auth/AuthContext";
import { shortId } from "../../lib/time";

type Action = ModerationDecision | "dismiss";

function targetTitle(target: Entity | Comment | null, report: Report): string {
  if (!target) return `${report.targetType} ${shortId(report.targetId)}`;
  if (report.targetType === "entity") return (target as Entity).title || "(untitled entity)";
  return "Comment";
}

export function ReviewDialog({ report, onClose }: { report: Report | null; onClose: () => void }) {
  const open = !!report;
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (report) setReason("");
  }, [report?.id]);

  const targetQuery = useQuery({
    queryKey: ["report-target", report?.targetType, report?.targetId],
    queryFn: () => getReportTarget(report!),
    enabled: open,
  });

  const mutation = useMutation({
    mutationFn: (action: Action) => actOnReport(report!, action, reason.trim() || undefined),
    onSuccess: (_d, action) => {
      toast({
        title: action === "removed" ? "Content removed" : action === "approved" ? "Content kept" : "Report dismissed",
        variant: action === "removed" ? "danger" : "success",
      });
      qc.invalidateQueries({ queryKey: ["reports"] });
      onClose();
    },
    onError: (e) =>
      toast({ title: "Action failed", description: e instanceof ApiError || e instanceof Error ? e.message : undefined, variant: "danger" }),
  });

  const target = targetQuery.data ?? null;
  const content = report && (report.targetType === "entity" ? (target as Entity | null)?.content : (target as Comment | null)?.content);
  const author = (target as Entity | Comment | null)?.user;
  const media = collectMedia(target);
  const hasMedia = media.images.length > 0 || media.files.length > 0 || !!media.gif;
  const { isOperator } = useAuth();
  const scoped = !!report?.spaceId;
  // Space reports are actioned via the space flow; project-level reports (no space) only by operators.
  const canAct = scoped || isOperator;
  const busy = mutation.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Flag className="size-4 text-warning" />
            Review {report?.targetType}
          </DialogTitle>
          <DialogDescription>Reported {report ? `for "${report.reason}"` : ""}</DialogDescription>
        </DialogHeader>

        <DialogBody className="min-h-0 flex-1 overflow-y-auto">
          {targetQuery.isLoading ? (
            <LoadingPanel label="Loading content…" />
          ) : (
            <>
              <div className="space-y-2 rounded-lg border border-border bg-bg p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-fg">{report ? targetTitle(target, report) : ""}</p>
                  {(target as Entity | Comment | null)?.moderationStatus ? (
                    <Badge variant={(target as Entity).moderationStatus === "removed" ? "danger" : "success"}>
                      {(target as Entity).moderationStatus}
                    </Badge>
                  ) : null}
                </div>
                {content ? (
                  <p className="whitespace-pre-wrap break-words text-sm text-muted">{content}</p>
                ) : targetQuery.isError ? (
                  <p className="text-sm text-muted">Couldn't load the content (it may have been deleted).</p>
                ) : !hasMedia ? (
                  <p className="text-sm text-muted">(no text content)</p>
                ) : null}
                {hasMedia ? (
                  <div className="space-y-2">
                    {media.images.map((src, i) => (
                      <img key={`img-${i}`} src={src} alt="" loading="lazy"
                        className="max-h-80 w-auto max-w-full rounded-lg border border-border" />
                    ))}
                    {media.gif ? (
                      <img src={media.gif} alt="" loading="lazy"
                        className="max-h-80 w-auto max-w-full rounded-lg border border-border" />
                    ) : null}
                    {media.files.map((f, i) => (
                      <a key={`file-${i}`} href={f.url} target="_blank" rel="noreferrer"
                        className="flex items-center gap-1.5 text-sm text-primary hover:underline">
                        <Paperclip className="size-3.5 shrink-0" /> {f.name}
                      </a>
                    ))}
                  </div>
                ) : null}
                {author ? <p className="text-xs text-faint">by @{author.username ?? shortId(author.id)}</p> : null}
              </div>

              <dl className="grid grid-cols-2 gap-3 text-sm">
                <Meta label="Reason" value={report?.reason} />
                <Meta label="Reporter" value={shortId(report?.reporterId)} />
                <Meta label="Space" value={report?.spaceId ? shortId(report.spaceId) : "project-level"} />
                <Meta label="Target id" value={shortId(report?.targetId)} mono />
              </dl>

              {report?.details ? (
                <div className="rounded-lg border border-border bg-bg p-3 text-sm text-muted">{report.details}</div>
              ) : null}

              {canAct ? (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted">Moderation reason (optional)</label>
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this being removed/kept?" />
                  {!scoped ? (
                    <p className="text-xs text-faint">Project-level report — actioning it uses your operator god-view.</p>
                  ) : null}
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  This report isn't tied to a space, and your role can't action it — only a deployment operator can resolve project-level reports.
                </div>
              )}
            </>
          )}
        </DialogBody>

        <DialogFooter className="shrink-0">
          <Button variant="ghost" onClick={() => mutation.mutate("dismiss")} disabled={!canAct || busy}>
            Dismiss
          </Button>
          <Button variant="secondary" onClick={() => mutation.mutate("approved")} disabled={!canAct || busy}>
            <Check /> Keep
          </Button>
          <Button variant="danger" onClick={() => mutation.mutate("removed")} disabled={!canAct || busy}>
            <Ban /> Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Resolve a renderable image URL from an uploaded file record (medium variant → original).
// Mirrors agora-demo's fileImageSrc so the admin shows exactly what users see.
function fileImageSrc(file: any): string | null {
  if (!file || file.type !== "image") return null;
  const v = file.image?.variants ?? {};
  return v.medium?.publicPath || v.small?.publicPath || v.thumbnail?.publicPath || file.originalPath || null;
}

function gifSrc(gif: any): string | null {
  if (!gif) return null;
  if (typeof gif === "string") return gif;
  return gif.url || gif.gifUrl || gif.images?.original?.url || gif.media?.[0]?.gif?.url || null;
}

// Pull every reviewable attachment off the target: inline images, a gif (comments), and any
// non-image files (shown as openable links). Entities carry `files`; comments carry `gif`.
function collectMedia(target: Entity | Comment | null): {
  images: string[];
  gif: string | null;
  files: { name: string; url: string }[];
} {
  const files = ((target as Entity | null)?.files ?? []) as any[];
  const images = files.map(fileImageSrc).filter((s): s is string => !!s);
  const other = files
    .filter((f) => f && f.type !== "image" && typeof f.originalPath === "string")
    .map((f) => ({ name: (f.originalPath as string).split("/").pop() || "attachment", url: f.originalPath as string }));
  return { images, gif: gifSrc((target as Comment | null)?.gif), files: other };
}

function Meta({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-faint">{label}</dt>
      <dd className={mono ? "font-mono text-xs text-fg" : "text-fg"}>{value || "—"}</dd>
    </div>
  );
}
