// Steward conflict-resolution. Two concerns:
//   • project_stewards — the grant for a new trust tier BETWEEN member and operator. Operators grant
//     steward status to trusted community members; isSteward() (lib/stewards.ts) reads this table at
//     token mint/refresh and stamps a `steward` JWT claim (mirrors the operator flow, but DB-backed
//     + per-project). Steward privilege is scoped to routes/steward.ts — stewards do NOT inherit the
//     operator's global read bypass.
//   • steward_cases / steward_case_events — case management. A case records a dyadic conflict
//     (complainant vs respondent) over some content, moves through a lifecycle, and closes with a
//     transformative-leaning outcome. steward_case_events is the append-only timeline/audit trail.
import {
  pgTable, uuid, text, boolean, jsonb, timestamp, index, unique,
} from "drizzle-orm/pg-core";
import { reactionTarget, stewardCaseState, stewardCaseOutcome, stewardCaseEventKind } from "./_shared.js";
import { projects, profiles } from "./projects.js";
import { spaces } from "./spaces.js";
import { reports } from "./misc.js";

export const projectStewards = pgTable("project_stewards", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  profileId: uuid("profile_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  grantedById: uuid("granted_by_id").references(() => profiles.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("project_stewards_unique").on(t.projectId, t.profileId),
]);

export const stewardCases = pgTable("steward_cases", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  // A case may be seeded from a report or opened cold (report deletion just nulls the link).
  reportId: uuid("report_id").references(() => reports.id, { onDelete: "set null" }),
  complainantId: uuid("complainant_id").references(() => profiles.id, { onDelete: "set null" }),
  respondentId: uuid("respondent_id").references(() => profiles.id, { onDelete: "set null" }),
  subjectType: reactionTarget("subject_type"), // entity | comment | message — the content at issue
  subjectId: uuid("subject_id"),
  spaceId: uuid("space_id").references(() => spaces.id, { onDelete: "set null" }),
  summary: text("summary").notNull().default(""),
  state: stewardCaseState("state").notNull().default("open"),
  outcome: stewardCaseOutcome("outcome"), // set when the case closes
  // The anti-false-balance lever: "this is targeting, not a symmetric dispute."
  asymmetry: boolean("asymmetry").notNull().default(false),
  resolutionNote: text("resolution_note"),
  openedById: uuid("opened_by_id").references(() => profiles.id, { onDelete: "set null" }),
  assignedToId: uuid("assigned_to_id").references(() => profiles.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (t) => [
  index("steward_cases_queue_idx").on(t.projectId, t.state, t.createdAt),
]);

export const stewardCaseEvents = pgTable("steward_case_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  caseId: uuid("case_id").notNull().references(() => stewardCases.id, { onDelete: "cascade" }),
  actorId: uuid("actor_id").references(() => profiles.id, { onDelete: "set null" }),
  kind: stewardCaseEventKind("kind").notNull(),
  body: text("body"),
  meta: jsonb("meta"), // e.g. { from, to } for a state_change
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("steward_case_events_timeline_idx").on(t.caseId, t.createdAt),
]);
