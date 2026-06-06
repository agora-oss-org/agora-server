// Steward (conflict-resolution) data access. Cases are admin-only — these shapes mirror the server's
// routes/steward.ts JSON, not an SDK-contract type. Lists use the standard { data, pagination }
// envelope; mutations return the shaped case. Steward grant management is operator-only.
import type { Comment, Entity, PaginatedResponse, User } from "@agora/contract";
import { api } from "./api";

export type CaseState = "open" | "in_mediation" | "closed";
export type CaseOutcome = "repaired" | "separated" | "protective_action" | "escalated" | "dismissed";
export type SubjectType = "entity" | "comment" | "message";
export type CaseEventKind = "opened" | "note" | "state_change" | "assignment" | "asymmetry" | "outcome" | "escalation" | "mediation_opened" | "mediation_closed";

export type MediationRole = "caucus" | "joint";

// A mediation channel = a chat conversation linked to the case (steward.ts shapeChannel). Messaging
// flows through the normal /chat routes; we just list + open from the steward surface.
export interface MediationChannel {
  id: string;
  type: "direct" | "group";
  name: string | null;
  mediationRole: MediationRole | null;
  mediationParty: string | null; // for caucus: the party's profile id (steward ↔ this party)
  postingPermission: "members" | "admins" | null;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  userId: string | null;
  content: string | null;
  createdAt: string;
  metadata?: Record<string, unknown> | null;
}

export interface CaseUser {
  id: string;
  username: string | null;
  name: string | null;
  reputation: number;
}

export interface Case {
  id: string;
  projectId: string;
  reportId: string | null;
  complainantId: string | null;
  respondentId: string | null;
  subjectType: SubjectType | null;
  subjectId: string | null;
  spaceId: string | null;
  summary: string;
  state: CaseState;
  outcome: CaseOutcome | null;
  asymmetry: boolean;
  resolutionNote: string | null;
  openedById: string | null;
  assignedToId: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  complainant: CaseUser | null;
  respondent: CaseUser | null;
  assignedTo: CaseUser | null;
  openedBy: CaseUser | null;
}

export interface CaseEvent {
  id: string;
  caseId: string;
  actorId: string | null;
  actor: CaseUser | null;
  kind: CaseEventKind;
  body: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface CaseMessage {
  id: string;
  content: string | null;
  user?: CaseUser | null;
  createdAt: string;
}

export interface CaseSubject {
  type: SubjectType;
  id: string;
  entity?: Entity | null;
  comment?: Comment | null;
  message?: CaseMessage | null;
}

export interface CaseDetail extends Case {
  subject: CaseSubject | null;
  events: CaseEvent[];
}

export interface OpenCaseBody {
  reportId?: string;
  respondentId?: string;
  complainantId?: string;
  subjectType?: SubjectType;
  subjectId?: string;
  spaceId?: string;
  summary?: string;
}

export interface PatchCaseBody {
  state?: CaseState;
  assignedToId?: string | null;
  asymmetry?: boolean;
  outcome?: Exclude<CaseOutcome, "escalated">; // escalation goes through escalateCase (it removes content)
  resolutionNote?: string;
}

// ── display helpers ──────────────────────────────────────────────────────────
export const STATE_LABEL: Record<CaseState, string> = {
  open: "Open",
  in_mediation: "In mediation",
  closed: "Closed",
};

export const OUTCOME_LABEL: Record<CaseOutcome, string> = {
  repaired: "Repaired",
  separated: "Separated",
  protective_action: "Protective action",
  escalated: "Escalated · removed",
  dismissed: "Dismissed",
};

// The closing outcomes a steward picks directly, in transformative order (repair → separation →
// protection → dismissal). `escalated` is intentionally absent: it removes content, so it's reached
// only via the dedicated Escalate button.
export const CLOSE_OUTCOMES: Exclude<CaseOutcome, "escalated">[] = [
  "repaired",
  "separated",
  "protective_action",
  "dismissed",
];

export function caseUserLabel(u: CaseUser | null | undefined): string {
  if (!u) return "—";
  if (u.username) return `@${u.username}`;
  return u.name || "—";
}

// ── query keys ────────────────────────────────────────────────────────────────
export const caseloadKey = (state: CaseState, page: number) => ["steward", "cases", state, page] as const;
export const caseKey = (id: string) => ["steward", "case", id] as const;
export const stewardsKey = () => ["steward", "stewards"] as const;
export const channelsKey = (caseId: string) => ["steward", "case", caseId, "channels"] as const;
export const channelMessagesKey = (conversationId: string) => ["steward", "channel", conversationId, "messages"] as const;

// ── fetchers / mutations ───────────────────────────────────────────────────────
export function listCases(state: CaseState, page: number) {
  return api<PaginatedResponse<Case>>("/steward/cases", { query: { state, page } });
}

export function getCase(id: string) {
  return api<CaseDetail>(`/steward/cases/${id}`);
}

export function openCase(body: OpenCaseBody) {
  return api<Case>("/steward/cases", { method: "POST", body });
}

export function patchCase(id: string, body: PatchCaseBody) {
  return api<Case>(`/steward/cases/${id}`, { method: "PATCH", body });
}

export function addCaseNote(id: string, text: string) {
  return api(`/steward/cases/${id}/notes`, { method: "POST", body: { body: text } });
}

export function escalateCase(id: string, reason?: string) {
  return api<Case>(`/steward/cases/${id}/escalate`, { method: "POST", body: reason ? { reason } : {} });
}

// ── mediation channels ─────────────────────────────────────────────────────────
export function listCaseChannels(id: string) {
  return api<{ channels: MediationChannel[] }>(`/steward/cases/${id}/channels`);
}

export function openCaseChannels(id: string, kind: MediationRole) {
  return api<{ channels: MediationChannel[] }>(`/steward/cases/${id}/channels`, { method: "POST", body: { kind } });
}

// Channel messaging reuses the normal chat routes (the steward is a member of the channel).
export function listChannelMessages(conversationId: string) {
  return api<{ messages: ChatMessage[]; hasMore: boolean }>(`/chat/conversations/${conversationId}/messages`, { query: { sort: "asc", limit: 100 } });
}

export function sendChannelMessage(conversationId: string, content: string) {
  return api<ChatMessage>(`/chat/conversations/${conversationId}/messages`, { method: "POST", body: { content } });
}

// ── steward grant management (operator-only) ───────────────────────────────────
export function listStewards() {
  return api<{ stewards: User[] }>("/steward/stewards");
}

export function grantStewardByUserId(userId: string) {
  return api("/steward/stewards", { method: "POST", body: { userId } });
}

export function revokeStewardByUserId(userId: string) {
  return api(`/steward/stewards/${userId}`, { method: "DELETE" });
}
