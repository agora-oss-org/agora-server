// Spaces admin section — project-admin/operator surface for managing spaces and read-receipt tracking.
// Basic settings (PATCH /spaces/:id) are project-admin-accessible because requireSpaceRole folds in
// project admins/operators (routes/spaces.ts). Read receipts are operator-only + corporate-tier:
// the toggle calls PATCH /admin/social/read-receipts/spaces/:id; coverage is GET /admin/social/read-receipts.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Layers, Users } from "lucide-react";
import type { PaginatedResponse } from "@agora-server/contract";
import { useAuth } from "../auth/AuthContext";
import { PageHeader } from "../components/ui/PageHeader";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Input, Label } from "../components/ui/Input";
import { LoadingPanel } from "../components/ui/Spinner";
import { Table, THead, TBody, Tr, Th, Td } from "../components/ui/Table";
import { useToast } from "../components/ui/Toast";
import { ApiError } from "../lib/api";
import { listSpaces, updateSpace, spacesKey, type Space, type SpacePatch } from "../lib/spaces";
import { getReadReceipts, toggleSpaceReceipts, readReceiptsKey } from "../lib/read-receipts";

const selectCls =
  "h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm text-fg outline-none transition-colors " +
  "hover:border-border-strong focus:border-primary focus:ring-2 focus:ring-primary/30";

// ── Page ──────────────────────────────────────────────────────────────────────

export function SpacesPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: spacesKey,
    queryFn: ({ signal }) => listSpaces(signal),
    staleTime: 30_000,
  });

  const spaces = data?.data ?? [];
  const selected = spaces.find((s) => s.id === selectedId) ?? null;

  const header = (
    <PageHeader
      title="Spaces"
      description="Manage space settings and per-space read-receipt tracking."
    />
  );

  if (isLoading) return <>{header}<LoadingPanel label="Loading spaces…" /></>;

  if (isError) {
    return (
      <>
        {header}
        <Card className="p-5">
          <p className="text-sm text-danger">
            Couldn't load spaces: {(error as Error)?.message ?? "unknown error"}
          </p>
        </Card>
      </>
    );
  }

  if (spaces.length === 0) {
    return (
      <>
        {header}
        <EmptyState
          icon={Layers}
          title="No spaces yet"
          description="Create spaces from the member-facing app — they'll appear here once created."
        />
      </>
    );
  }

  return (
    <>
      {header}
      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <SpaceList spaces={spaces} selectedId={selectedId} onSelect={setSelectedId} />
        {selected ? (
          <SpaceDetail space={selected} />
        ) : (
          <Card className="flex items-center justify-center p-10">
            <p className="text-sm text-faint">Select a space to view and edit its settings.</p>
          </Card>
        )}
      </div>
    </>
  );
}

// ── Space list (master column) ─────────────────────────────────────────────────

function SpaceList({
  spaces, selectedId, onSelect,
}: {
  spaces: Space[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>All spaces</CardTitle>
        <CardDescription>{spaces.length} space{spaces.length === 1 ? "" : "s"}</CardDescription>
      </CardHeader>
      <ul className="divide-y divide-border">
        {spaces.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className={`w-full px-5 py-3 text-left transition-colors hover:bg-surface-2 ${selectedId === s.id ? "bg-surface-2" : ""}`}
              onClick={() => onSelect(s.id)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-fg">{s.name}</span>
                {s.readReceiptsEnabled ? (
                  <Badge variant="info" className="shrink-0">Receipts on</Badge>
                ) : null}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-faint">
                <Users className="size-3" />
                <span>{s.membersCount}</span>
                {s.slug ? <span className="truncate">· /{s.slug}</span> : null}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ── Space detail (two stacked panels) ────────────────────────────────────────

function SpaceDetail({ space }: { space: Space }) {
  const { isOperator } = useAuth();
  return (
    <div className="space-y-4">
      <BasicSettingsCard space={space} />
      {isOperator ? <ReadReceiptsCard space={space} /> : null}
    </div>
  );
}

// ── Basic settings card (project-admin) ──────────────────────────────────────

function BasicSettingsCard({ space }: { space: Space }) {
  const qc = useQueryClient();
  const toast = useToast();

  const [form, setForm] = useState<SpacePatch>({
    name: space.name,
    description: space.description ?? "",
    readingPermission: space.readingPermission,
    postingPermission: space.postingPermission,
    requireJoinApproval: space.requireJoinApproval,
  });

  // Reset when a different space is selected.
  useEffect(() => {
    setForm({
      name: space.name,
      description: space.description ?? "",
      readingPermission: space.readingPermission,
      postingPermission: space.postingPermission,
      requireJoinApproval: space.requireJoinApproval,
    });
  }, [space.id]);

  const m = useMutation({
    mutationFn: () =>
      updateSpace(space.id, {
        name: form.name?.trim() || undefined,
        description: (form.description as string)?.trim() || null,
        readingPermission: form.readingPermission,
        postingPermission: form.postingPermission,
        requireJoinApproval: form.requireJoinApproval,
      }),
    onSuccess: (updated) => {
      qc.setQueryData(spacesKey, (old: PaginatedResponse<Space> | undefined) =>
        old ? { ...old, data: old.data.map((s) => (s.id === updated.id ? updated : s)) } : old,
      );
      toast({ title: "Space updated", variant: "success" });
    },
    onError: (e) =>
      toast({
        title: "Update failed",
        description: e instanceof ApiError || e instanceof Error ? e.message : undefined,
        variant: "danger",
      }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Basic settings</CardTitle>
        <CardDescription>Name, permissions, and join approval for this space.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="space-name">Name</Label>
          <Input
            id="space-name"
            value={form.name ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="space-desc">Description</Label>
          <Input
            id="space-desc"
            value={(form.description as string) ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="Optional"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="reading-perm">Reading</Label>
            <select
              id="reading-perm"
              className={selectCls}
              value={form.readingPermission}
              onChange={(e) =>
                setForm((f) => ({ ...f, readingPermission: e.target.value as Space["readingPermission"] }))
              }
            >
              <option value="anyone">Anyone</option>
              <option value="members">Members only</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="posting-perm">Posting</Label>
            <select
              id="posting-perm"
              className={selectCls}
              value={form.postingPermission}
              onChange={(e) =>
                setForm((f) => ({ ...f, postingPermission: e.target.value as Space["postingPermission"] }))
              }
            >
              <option value="anyone">Anyone</option>
              <option value="members">Members only</option>
              <option value="admins">Admins only</option>
            </select>
          </div>
        </div>
        <label className="flex cursor-pointer items-center gap-2.5 text-sm text-fg">
          <input
            type="checkbox"
            className="size-4 rounded border-border accent-primary"
            checked={form.requireJoinApproval ?? false}
            onChange={(e) => setForm((f) => ({ ...f, requireJoinApproval: e.target.checked }))}
          />
          Require join approval
        </label>
        <div className="flex justify-end">
          <Button size="sm" disabled={m.isPending} onClick={() => m.mutate()}>
            {m.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Read receipts card (operator-only, corporate-tier gate) ───────────────────

function ReadReceiptsCard({ space }: { space: Space }) {
  const qc = useQueryClient();
  const toast = useToast();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: readReceiptsKey,
    queryFn: ({ signal }) => getReadReceipts(signal),
    staleTime: 60_000,
    retry: false,
  });

  const toggleM = useMutation({
    mutationFn: (enabled: boolean) => toggleSpaceReceipts(space.id, enabled),
    onSuccess: (res) => {
      qc.setQueryData(spacesKey, (old: PaginatedResponse<Space> | undefined) =>
        old
          ? {
              ...old,
              data: old.data.map((s) =>
                s.id === res.spaceId ? { ...s, readReceiptsEnabled: res.readReceiptsEnabled } : s,
              ),
            }
          : old,
      );
      void qc.invalidateQueries({ queryKey: readReceiptsKey });
      toast({
        title: res.readReceiptsEnabled ? "Read receipts enabled" : "Read receipts disabled",
        variant: "success",
      });
    },
    onError: (e) =>
      toast({
        title: "Toggle failed",
        description: e instanceof ApiError || e instanceof Error ? e.message : undefined,
        variant: "danger",
      }),
  });

  // Corporate-tier gate: 400 social/read-receipts-disabled → friendly upgrade prompt.
  if (isError) {
    const code = error instanceof ApiError ? error.code : "";
    if (code === "social/read-receipts-disabled") {
      return (
        <Card className="p-5">
          <div className="flex flex-col items-start gap-3">
            <Badge variant="warning">Corporate tier required</Badge>
            <p className="max-w-prose text-sm text-muted">
              Read receipts are a corporate-tier compliance feature. Enable{" "}
              <span className="text-fg">read receipts</span> in Settings → Social graph to activate
              per-space tracking.
            </p>
            <Button asChild variant="outline" size="sm">
              <Link to="/settings">Open Settings → Social graph</Link>
            </Button>
          </div>
        </Card>
      );
    }
    return (
      <Card className="p-5">
        <p className="text-sm text-danger">
          Couldn't load read receipts: {(error as Error)?.message ?? "unknown error"}
        </p>
      </Card>
    );
  }

  const receiptSpace = data?.spaces.find((s) => s.spaceId === space.id);

  return (
    <Card className="p-5">
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-fg">Read receipts</h3>
            <p className="mt-0.5 text-sm text-muted">
              Track whether members have read announcement posts. Disclosed to members via the
              transparency endpoint.
            </p>
          </div>
          <Button
            variant={space.readReceiptsEnabled ? "danger-outline" : "outline"}
            size="sm"
            disabled={toggleM.isPending}
            onClick={() => toggleM.mutate(!space.readReceiptsEnabled)}
          >
            {space.readReceiptsEnabled ? <EyeOff /> : <Eye />}
            {toggleM.isPending ? "Saving…" : space.readReceiptsEnabled ? "Disable" : "Enable"}
          </Button>
        </div>

        {isLoading ? (
          <LoadingPanel label="Loading coverage…" />
        ) : !space.readReceiptsEnabled ? (
          <p className="text-sm text-faint">
            Enable read receipts to start tracking announcement reads in this space.
          </p>
        ) : !receiptSpace || receiptSpace.announcements.length === 0 ? (
          <p className="text-sm text-faint">
            No reads recorded yet — coverage will appear here as members read announcement posts.
          </p>
        ) : (
          <>
            {data?.asOf ? (
              <p className="text-xs text-faint">Live · as of {fmtDateTime(data.asOf)}</p>
            ) : null}
            <Table>
              <THead>
                <Tr>
                  <Th>Post</Th>
                  <Th className="text-right">Readers</Th>
                  <Th className="text-right">Members</Th>
                  <Th>Coverage</Th>
                </Tr>
              </THead>
              <TBody>
                {receiptSpace.announcements.map((a) => (
                  <Tr key={a.entityId}>
                    <Td className="max-w-[200px]">
                      <span className="block truncate">
                        {a.title ?? <span className="text-faint">Untitled</span>}
                      </span>
                    </Td>
                    <Td className="text-right tabular-nums">{a.readerCount}</Td>
                    <Td className="text-right tabular-nums">{receiptSpace.memberCount}</Td>
                    <Td><CoverageBar coverage={a.coverage} /></Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </>
        )}
      </div>
    </Card>
  );
}

function CoverageBar({ coverage }: { coverage: number }) {
  const pct = Math.round(coverage * 100);
  const barCls = pct >= 80 ? "bg-success" : pct >= 40 ? "bg-warning" : "bg-danger";
  return (
    <span className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2">
        <div className={`h-full rounded-full ${barCls}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums text-xs text-muted">{pct}%</span>
    </span>
  );
}

function fmtDateTime(iso: string): string {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : t.toLocaleString();
}
