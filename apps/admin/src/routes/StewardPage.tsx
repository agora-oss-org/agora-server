// Steward — conflict-resolution caseload. A case records a dyadic conflict (complainant vs
// respondent) over some content and closes with a transformative-leaning outcome. The tab is visible
// to stewards (a DB-granted trust tier) and operators. Operators also get the grant-management card.
// Mirrors ModerationPage's list + detail-dialog shape.
import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2, ChevronLeft, ChevronRight, Crosshair, Handshake, Inbox, Plus, Scale, UserPlus, X,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import {
  caseloadKey, listCases, openCase, listStewards, grantStewardByUserId, revokeStewardByUserId,
  stewardsKey, caseUserLabel, STATE_LABEL, OUTCOME_LABEL, type Case, type CaseState,
} from "../lib/steward";
import { ApiError } from "../lib/api";
import { relativeTime, shortId } from "../lib/time";
import { PageHeader } from "../components/ui/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/Tabs";
import { Table, TBody, THead, Th, Td, Tr } from "../components/ui/Table";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { EmptyState } from "../components/ui/EmptyState";
import { LoadingPanel } from "../components/ui/Spinner";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/Dialog";
import { useToast } from "../components/ui/Toast";
import { CaseDialog } from "./steward/CaseDialog";

const STATE_BADGE: Record<CaseState, "warning" | "info" | "muted"> = {
  open: "warning",
  in_mediation: "info",
  closed: "muted",
};

export function StewardPage() {
  const { isOperator, isSteward } = useAuth();
  const [tab, setTab] = useState<CaseState>("open");
  const [openCaseId, setOpenCaseId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  if (!isSteward && !isOperator) {
    return (
      <>
        <PageHeader title="Steward" description="Conflict resolution between members." />
        <EmptyState
          icon={Scale}
          title="Steward access required"
          description="Ask a deployment operator to grant you steward access to handle conflict-resolution cases."
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Steward"
        description="Resolve conflicts between members — repair and protection first, removal as a last resort."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus /> New case
          </Button>
        }
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as CaseState)}>
        <TabsList>
          <TabsTrigger value="open">
            <Inbox className="size-4" /> Open
          </TabsTrigger>
          <TabsTrigger value="in_mediation">
            <Handshake className="size-4" /> In mediation
          </TabsTrigger>
          <TabsTrigger value="closed">
            <CheckCircle2 className="size-4" /> Closed
          </TabsTrigger>
        </TabsList>

        {(["open", "in_mediation", "closed"] as CaseState[]).map((s) => (
          <TabsContent key={s} value={s} className="mt-4 focus:outline-none">
            <Caseload state={s} onOpen={setOpenCaseId} />
          </TabsContent>
        ))}
      </Tabs>

      {isOperator ? <StewardsCard /> : null}

      <CaseDialog caseId={openCaseId} onClose={() => setOpenCaseId(null)} />
      <NewCaseDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          setOpenCaseId(id);
        }}
      />
    </>
  );
}

function Caseload({ state, onOpen }: { state: CaseState; onOpen: (id: string) => void }) {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: caseloadKey(state, page),
    queryFn: () => listCases(state, page),
    placeholderData: keepPreviousData,
  });

  if (query.isLoading) return <LoadingPanel />;
  if (query.isError) {
    const msg = query.error instanceof ApiError ? query.error.message : "Failed to load cases.";
    return <EmptyState icon={Inbox} title="Couldn't load cases" description={msg} />;
  }

  const cases = query.data?.data ?? [];
  const meta = query.data?.pagination;

  if (cases.length === 0) {
    return (
      <EmptyState
        icon={state === "closed" ? CheckCircle2 : Inbox}
        title={state === "closed" ? "Nothing closed yet" : "No cases here"}
        description={
          state === "open"
            ? "Open a case from a report (Moderation → Review) or with “New case”."
            : state === "in_mediation"
              ? "Cases you move into mediation will appear here."
              : "Resolved and escalated cases will appear here."
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      <Table>
        <THead>
          <Tr className="hover:bg-transparent">
            <Th>Case</Th>
            <Th>Complainant</Th>
            <Th>Respondent</Th>
            <Th>State</Th>
            <Th>Assigned</Th>
            <Th>{state === "closed" ? "Closed" : "Opened"}</Th>
            <Th className="text-right">Action</Th>
          </Tr>
        </THead>
        <TBody>
          {cases.map((c) => (
            <Tr key={c.id} className="cursor-pointer" onClick={() => onOpen(c.id)}>
              <Td>
                <div className="flex items-center gap-2">
                  {c.asymmetry ? (
                    <span title="Targeting — not a symmetric dispute">
                      <Crosshair className="size-4 shrink-0 text-danger" />
                    </span>
                  ) : null}
                  {c.subjectType ? <Badge variant="outline">{c.subjectType}</Badge> : null}
                  <span className="max-w-[18rem] truncate text-fg">{c.summary || <span className="text-faint">(no summary)</span>}</span>
                </div>
              </Td>
              <Td className="text-muted">{caseUserLabel(c.complainant)}</Td>
              <Td className="text-muted">{caseUserLabel(c.respondent)}</Td>
              <Td>
                {c.state === "closed" && c.outcome ? (
                  <Badge variant={c.outcome === "escalated" ? "danger" : "muted"}>{OUTCOME_LABEL[c.outcome]}</Badge>
                ) : (
                  <Badge variant={STATE_BADGE[c.state]}>{STATE_LABEL[c.state]}</Badge>
                )}
              </Td>
              <Td className="text-muted">{caseUserLabel(c.assignedTo)}</Td>
              <Td className="text-muted">{relativeTime(state === "closed" ? c.closedAt : c.createdAt)}</Td>
              <Td className="text-right">
                <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); onOpen(c.id); }}>
                  Open
                </Button>
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>

      {meta && meta.totalPages > 1 ? (
        <div className="flex items-center justify-between text-sm text-muted">
          <span>Page {meta.page} of {meta.totalPages} · {meta.totalItems} total</span>
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

// Open a cold case (not tied to a report). v1 captures the conflict narrative + an optional respondent
// id; the rich path (parties + subject prefilled) is opening a case from a report in the Moderation tab.
function NewCaseDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [summary, setSummary] = useState("");
  const [respondentId, setRespondentId] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      openCase({ summary: summary.trim() || undefined, respondentId: respondentId.trim() || undefined }),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["steward"] });
      setSummary("");
      setRespondentId("");
      onCreated(created.id);
    },
    onError: (e) => toast({ title: "Couldn't open case", description: e instanceof Error ? e.message : undefined, variant: "danger" }),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New case</DialogTitle>
          <DialogDescription>Log a conflict to steward. You can assign and mediate it after it opens.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted">What's the conflict?</label>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={4}
              placeholder="Describe what's happening between the members involved…"
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-faint focus:border-primary focus:outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted">Respondent user id (optional)</label>
            <Input value={respondentId} onChange={(e) => setRespondentId(e.target.value)} placeholder="profile uuid" />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || !summary.trim()}>
            <Plus /> Open case
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Operator-only: grant / revoke the steward role for community members.
function StewardsCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const [userId, setUserId] = useState("");
  const query = useQuery({ queryKey: stewardsKey(), queryFn: listStewards, staleTime: 30_000 });

  const grant = useMutation({
    mutationFn: () => grantStewardByUserId(userId.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: stewardsKey() });
      setUserId("");
      toast({ title: "Steward granted", description: "Takes effect on their next sign-in / token refresh.", variant: "success" });
    },
    onError: (e) => toast({ title: "Couldn't grant", description: e instanceof Error ? e.message : undefined, variant: "danger" }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeStewardByUserId(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: stewardsKey() });
      toast({ title: "Steward revoked", variant: "success" });
    },
    onError: (e) => toast({ title: "Couldn't revoke", description: e instanceof Error ? e.message : undefined, variant: "danger" }),
  });

  const stewards = query.data?.stewards ?? [];

  return (
    <Card className="mt-6 p-5">
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
          <UserPlus className="size-4 text-primary" /> Stewards
        </h2>
        <p className="text-sm text-muted">Grant trusted members the steward role. It takes effect on their next token refresh.</p>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="Profile user id (uuid) to grant" />
        <Button onClick={() => grant.mutate()} disabled={grant.isPending || !userId.trim()}>
          <UserPlus /> Grant
        </Button>
      </div>

      <div className="mt-4">
        {query.isLoading ? (
          <LoadingPanel />
        ) : stewards.length === 0 ? (
          <p className="text-sm text-faint">No stewards yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {stewards.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
                <span className="text-fg">
                  {u.username ? `@${u.username}` : u.name || shortId(u.id)}
                  <span className="ml-2 font-mono text-xs text-faint">{shortId(u.id)}</span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => revoke.mutate(u.id)} disabled={revoke.isPending}>
                  <X className="size-3.5" /> Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
