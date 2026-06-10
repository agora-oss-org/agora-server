# Social Config (PR 1 — dual community/corporate tier foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `projects.social_config` (jsonb) with a zod-validated, tier-clamped configuration layer — the community↔corporate privacy switch from `docs/SOCIAL-GRAPH.md` §5 — plus admin GET/PATCH endpoints, a member-facing transparency endpoint, and an admin Settings → Social Graph panel.

**Architecture:** Pure schema + tier defaults + clamp/resolve functions live in `@agora-server/contract` (new `src/social.ts`, fully unit-tested — the clamp matrix IS the ethical guarantee). The API adds a cached resolver (`lib/social-config.ts`, mirroring `lib/steward-config.ts`), GET/PATCH `/settings/social` + GET `/social/transparency` in `routes/misc.ts` (mirroring the moderator settings), and a generated Drizzle migration. The admin app adds a `SocialGraphPanel` mirroring the existing settings panels. **Decisions locked by Jenova:** full slice incl. admin UI; gate = `requireProjectAdmin` (operator OR project admin); **reject forbidden flags on write AND clamp on read**; transparency = authenticated member endpoint.

**Tech Stack:** TypeScript, zod, Drizzle ORM, Hono, vitest, React + React Query (admin), pnpm workspaces.

**Conventions that apply to every task:** camelCase jsonb keys (matches `moderatorConfig`); commit style `✨ feat(social): …` / `🧪 test(social): …` / `📝 docs(social): …` ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; `pnpm --filter @agora-server/contract build` after contract edits (the api imports the built `dist/`).

---

## File structure

| File | Responsibility |
|---|---|
| Create `packages/contract/src/social.ts` | `SOCIAL_PRIVACY_TIERS`, `socialConfigSchema` (PATCH body), `ResolvedSocialConfig`, `SOCIAL_TIER_DEFAULTS`, `CORPORATE_ONLY_FLAGS`, pure `resolveSocialConfig()` (clamp-on-read) + `forbiddenSocialKeys()` (reject-on-write) |
| Create `packages/contract/src/social.test.ts` | The clamp matrix: tier defaults, forbidden-flag rejection, stale-flag clamping, k-floor, garbage-input fail-closed |
| Modify `packages/contract/src/index.ts` | `export * from "./social.js";` |
| Modify `apps/api/src/db/schema/projects.ts` | `socialConfig` jsonb column |
| Generate `apps/api/drizzle/0038_*.sql` | `ALTER TABLE projects ADD COLUMN social_config` |
| Create `apps/api/src/lib/social-config.ts` | Cached `getSocialConfig(projectId)` + `invalidateSocialConfig()` + `socialConfigView()` (mirrors `steward-config.ts`) |
| Modify `apps/api/src/routes/misc.ts` | GET/PATCH `/settings/social` (admin) + GET `/social/transparency` (member) |
| Create `apps/api/test/integration/social-config.test.ts` | Handler-level gates: 403 non-admin, 400 forbidden flag, tier switch, transparency shape |
| Modify `apps/admin/src/lib/settings.ts` | `SocialConfigView`/`SocialConfigPatch` types + `getSocialConfig()`/`updateSocialConfig()` |
| Create `apps/admin/src/routes/settings/SocialGraphPanel.tsx` | The Settings → Social Graph panel |
| Modify `apps/admin/src/routes/SettingsPage.tsx` | Mount the panel |
| Modify `CHANGELOG.md`, `docs/SOCIAL-GRAPH.md` | Keep-a-Changelog entry; mark §5 as in-progress + camelCase key note |

---

### Task 0: Branch

**Files:** none

- [ ] **Step 1: Verify clean tree and create the feature branch**

```bash
cd /Users/jenova/projects/jenova-marie/agora-server
git status --porcelain   # expect: only the 3 untracked docs/*.md files
git checkout -b feat/social-config
```

Expected: `Switched to a new branch 'feat/social-config'`. The three untracked design docs (`docs/SOCIAL-GRAPH.md`, `docs/AGORA-SOCIAL.md`, `docs/AGORA-CORP.md`) belong in this PR — they'll be committed in Task 8.

---

### Task 1: Contract — schema, tiers, defaults (TDD)

**Files:**
- Create: `packages/contract/src/social.ts`
- Create: `packages/contract/src/social.test.ts`
- Modify: `packages/contract/src/index.ts` (one line)

- [ ] **Step 1: Write the failing tests** — create `packages/contract/src/social.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  CORPORATE_ONLY_FLAGS,
  forbiddenSocialKeys,
  resolveSocialConfig,
  SOCIAL_PRIVACY_TIERS,
  SOCIAL_TIER_DEFAULTS,
  socialConfigSchema,
} from "./social.js";

describe("socialConfigSchema — PATCH body contract", () => {
  it("accepts an empty patch (all fields optional)", () => {
    expect(socialConfigSchema.safeParse({}).success).toBe(true);
  });
  it("accepts a full valid corporate patch", () => {
    expect(
      socialConfigSchema.safeParse({
        privacyTier: "corporate",
        readReceiptsAllowed: true,
        engagementScoresEnabled: true,
        constellationKFloor: 10,
        warmthHalfLifeDays: 60,
      }).success,
    ).toBe(true);
  });
  it("rejects an unknown tier", () => {
    expect(socialConfigSchema.safeParse({ privacyTier: "surveillance" }).success).toBe(false);
  });
  it("rejects constellationKFloor below 5 — the k-anonymity floor is not tier-relaxable", () => {
    expect(socialConfigSchema.safeParse({ constellationKFloor: 4 }).success).toBe(false);
    expect(socialConfigSchema.safeParse({ constellationKFloor: 5 }).success).toBe(true);
  });
  it("rejects non-positive half-lives", () => {
    expect(socialConfigSchema.safeParse({ warmthHalfLifeDays: 0 }).success).toBe(false);
    expect(socialConfigSchema.safeParse({ frictionHalfLifeDays: -3 }).success).toBe(false);
  });
});

describe("SOCIAL_TIER_DEFAULTS — the two postures", () => {
  it("community defaults: garden on, every corporate analytic off, receipts locked off", () => {
    const d = SOCIAL_TIER_DEFAULTS.community;
    expect(d.privacyTier).toBe("community");
    expect(d.weatherEnabled).toBe(true);
    expect(d.constellationEnabled).toBe(true);
    expect(d.neighborhoodEnabled).toBe(true);
    expect(d.frictionVisibleToStewards).toBe(true);
    expect(d.readAffinityEnabled).toBe(true);
    for (const k of CORPORATE_ONLY_FLAGS) expect(d[k]).toBe(false);
    expect(d.constellationKFloor).toBe(5);
    expect(d.warmthHalfLifeDays).toBe(30);
    expect(d.frictionHalfLifeDays).toBe(14);
  });
  it("corporate defaults: analytics on, k-floor still 5", () => {
    const d = SOCIAL_TIER_DEFAULTS.corporate;
    expect(d.privacyTier).toBe("corporate");
    for (const k of CORPORATE_ONLY_FLAGS) expect(d[k]).toBe(true);
    expect(d.constellationKFloor).toBe(5); // k-anonymity is not tier-relaxable
  });
});

describe("forbiddenSocialKeys — reject-on-write", () => {
  it("under community, flags every corporate-only key set to true", () => {
    for (const k of CORPORATE_ONLY_FLAGS) {
      expect(forbiddenSocialKeys("community", { [k]: true })).toEqual([k]);
    }
  });
  it("under community, allows corporate-only keys set to false or omitted", () => {
    expect(forbiddenSocialKeys("community", { readReceiptsAllowed: false })).toEqual([]);
    expect(forbiddenSocialKeys("community", { weatherEnabled: false })).toEqual([]);
  });
  it("under corporate, allows everything", () => {
    for (const k of CORPORATE_ONLY_FLAGS) {
      expect(forbiddenSocialKeys("corporate", { [k]: true })).toEqual([]);
    }
  });
});

describe("resolveSocialConfig — clamp-on-read (fail closed)", () => {
  it("garbage/missing input resolves to full community defaults", () => {
    for (const raw of [undefined, null, 42, "hi", []]) {
      expect(resolveSocialConfig(raw)).toEqual(SOCIAL_TIER_DEFAULTS.community);
    }
  });
  it("unknown stored tier falls back to community", () => {
    expect(resolveSocialConfig({ privacyTier: "corporate-plus" }).privacyTier).toBe("community");
  });
  it("stored overrides apply on top of tier defaults", () => {
    const cfg = resolveSocialConfig({ privacyTier: "corporate", weatherEnabled: false, warmthHalfLifeDays: 90 });
    expect(cfg.weatherEnabled).toBe(false);
    expect(cfg.warmthHalfLifeDays).toBe(90);
    expect(cfg.readReceiptsAllowed).toBe(true); // corporate default survives
  });
  it("CLAMP: stale corporate flags are neutralized after a corporate→community switch", () => {
    // What's left in jsonb after an operator flips the tier back without clearing flags:
    const cfg = resolveSocialConfig({
      privacyTier: "community",
      readReceiptsAllowed: true,
      engagementScoresEnabled: true,
      influenceScoresEnabled: true,
      siloDetectionEnabled: true,
      frictionAnalyticsEnabled: true,
    });
    for (const k of CORPORATE_ONLY_FLAGS) expect(cfg[k]).toBe(false);
  });
  it("CLAMP: a stored k-floor below 5 is raised to 5", () => {
    expect(resolveSocialConfig({ constellationKFloor: 2 }).constellationKFloor).toBe(5);
  });
  it("ignores non-boolean garbage in boolean fields (falls back to default)", () => {
    expect(resolveSocialConfig({ weatherEnabled: "yes" }).weatherEnabled).toBe(true);
  });
  it("tiers are exactly community and corporate", () => {
    expect(SOCIAL_PRIVACY_TIERS).toEqual(["community", "corporate"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/jenova/projects/jenova-marie/agora-server/packages/contract && pnpm test -- social
```

Expected: FAIL — `Cannot find module './social.js'`.

- [ ] **Step 3: Implement** — create `packages/contract/src/social.ts`:

```typescript
import { z } from "zod";

// ── Social graph config (projects.social_config jsonb) ──────────────────────────────────────────
// The community↔corporate privacy switch — see docs/SOCIAL-GRAPH.md §5 and docs/AGORA-CORP.md §4.
// The tier selects DEFAULTS; stored keys override within what the tier allows. Two enforcement
// points, both server-side: forbiddenSocialKeys() rejects disallowed writes (400), and
// resolveSocialConfig() clamps at read time (defense-in-depth for stale flags left behind by a
// corporate→community switch). Fail closed: garbage resolves to community defaults.

export const SOCIAL_PRIVACY_TIERS = ["community", "corporate"] as const;
export type SocialPrivacyTier = (typeof SOCIAL_PRIVACY_TIERS)[number];

// Flags that may only be true under the corporate tier. INVARIANT (docs/AGORA-CORP.md §4): the
// k-anonymity floor is NOT in this list — no tier relaxes it below 5.
export const CORPORATE_ONLY_FLAGS = [
  "influenceScoresEnabled",
  "siloDetectionEnabled",
  "engagementScoresEnabled",
  "frictionAnalyticsEnabled",
  "readReceiptsAllowed",
] as const;
export type CorporateOnlyFlag = (typeof CORPORATE_ONLY_FLAGS)[number];

export interface ResolvedSocialConfig {
  privacyTier: SocialPrivacyTier;
  graphEnabled: boolean;
  weatherEnabled: boolean;
  constellationEnabled: boolean;
  constellationKFloor: number;
  neighborhoodEnabled: boolean;
  influenceScoresEnabled: boolean;
  siloDetectionEnabled: boolean;
  engagementScoresEnabled: boolean;
  frictionVisibleToStewards: boolean;
  frictionAnalyticsEnabled: boolean;
  readAffinityEnabled: boolean;
  readReceiptsAllowed: boolean;
  warmthHalfLifeDays: number;
  frictionHalfLifeDays: number;
}

const COMMUNITY_DEFAULTS: ResolvedSocialConfig = {
  privacyTier: "community",
  graphEnabled: true,
  weatherEnabled: true,
  constellationEnabled: true,
  constellationKFloor: 5,
  neighborhoodEnabled: true,
  influenceScoresEnabled: false,
  siloDetectionEnabled: false,
  engagementScoresEnabled: false,
  frictionVisibleToStewards: true,
  frictionAnalyticsEnabled: false,
  readAffinityEnabled: true,
  readReceiptsAllowed: false,
  warmthHalfLifeDays: 30,
  frictionHalfLifeDays: 14,
};

export const SOCIAL_TIER_DEFAULTS: Record<SocialPrivacyTier, ResolvedSocialConfig> = {
  community: COMMUNITY_DEFAULTS,
  corporate: {
    ...COMMUNITY_DEFAULTS,
    privacyTier: "corporate",
    influenceScoresEnabled: true,
    siloDetectionEnabled: true,
    engagementScoresEnabled: true,
    frictionAnalyticsEnabled: true,
    readReceiptsAllowed: true,
  },
};

// PATCH body (admin Settings → Social Graph). Every field nullish: omit = leave unchanged,
// null = clear the override (→ tier default). Mirrors moderatorConfigSchema.
export const socialConfigSchema = z.object({
  privacyTier: z.enum(SOCIAL_PRIVACY_TIERS).nullish(),
  graphEnabled: z.boolean().nullish(),
  weatherEnabled: z.boolean().nullish(),
  constellationEnabled: z.boolean().nullish(),
  constellationKFloor: z.number().int().min(5).max(1000).nullish(),
  neighborhoodEnabled: z.boolean().nullish(),
  influenceScoresEnabled: z.boolean().nullish(),
  siloDetectionEnabled: z.boolean().nullish(),
  engagementScoresEnabled: z.boolean().nullish(),
  frictionVisibleToStewards: z.boolean().nullish(),
  frictionAnalyticsEnabled: z.boolean().nullish(),
  readAffinityEnabled: z.boolean().nullish(),
  readReceiptsAllowed: z.boolean().nullish(),
  warmthHalfLifeDays: z.number().int().min(1).max(365).nullish(),
  frictionHalfLifeDays: z.number().int().min(1).max(365).nullish(),
});
export type SocialConfigPatch = z.infer<typeof socialConfigSchema>;

/** Reject-on-write: keys in `patch` that the (resulting) tier forbids. Empty array = OK. */
export function forbiddenSocialKeys(
  tier: SocialPrivacyTier,
  patch: Partial<Record<string, unknown>>,
): string[] {
  if (tier === "corporate") return [];
  return CORPORATE_ONLY_FLAGS.filter((k) => patch[k] === true);
}

const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
const intIn = (v: unknown, d: number, min: number, max: number): number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : d;

/** Clamp-on-read: overlay stored jsonb onto tier defaults, neutralizing anything the tier forbids. */
export function resolveSocialConfig(raw: unknown): ResolvedSocialConfig {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const tier: SocialPrivacyTier = SOCIAL_PRIVACY_TIERS.includes(r.privacyTier as SocialPrivacyTier)
    ? (r.privacyTier as SocialPrivacyTier)
    : "community";
  const d = SOCIAL_TIER_DEFAULTS[tier];
  const cfg: ResolvedSocialConfig = {
    privacyTier: tier,
    graphEnabled: bool(r.graphEnabled, d.graphEnabled),
    weatherEnabled: bool(r.weatherEnabled, d.weatherEnabled),
    constellationEnabled: bool(r.constellationEnabled, d.constellationEnabled),
    // The k-floor clamps UP only — a stored value below 5 is raised, never honored.
    constellationKFloor: Math.max(5, intIn(r.constellationKFloor, d.constellationKFloor, 1, 1000)),
    neighborhoodEnabled: bool(r.neighborhoodEnabled, d.neighborhoodEnabled),
    influenceScoresEnabled: bool(r.influenceScoresEnabled, d.influenceScoresEnabled),
    siloDetectionEnabled: bool(r.siloDetectionEnabled, d.siloDetectionEnabled),
    engagementScoresEnabled: bool(r.engagementScoresEnabled, d.engagementScoresEnabled),
    frictionVisibleToStewards: bool(r.frictionVisibleToStewards, d.frictionVisibleToStewards),
    frictionAnalyticsEnabled: bool(r.frictionAnalyticsEnabled, d.frictionAnalyticsEnabled),
    readAffinityEnabled: bool(r.readAffinityEnabled, d.readAffinityEnabled),
    readReceiptsAllowed: bool(r.readReceiptsAllowed, d.readReceiptsAllowed),
    warmthHalfLifeDays: intIn(r.warmthHalfLifeDays, d.warmthHalfLifeDays, 1, 365),
    frictionHalfLifeDays: intIn(r.frictionHalfLifeDays, d.frictionHalfLifeDays, 1, 365),
  };
  if (tier === "community") {
    for (const k of CORPORATE_ONLY_FLAGS) cfg[k] = false;
  }
  return cfg;
}
```

- [ ] **Step 4: Export from the contract index** — in `packages/contract/src/index.ts`, after the `export * from "./schemas.js";` line add:

```typescript
export * from "./social.js";
```

- [ ] **Step 5: Run tests to verify pass**

```bash
cd /Users/jenova/projects/jenova-marie/agora-server/packages/contract && pnpm test -- social
```

Expected: PASS (all describe blocks green).

- [ ] **Step 6: Build the contract + typecheck** (the api consumes `dist/`)

```bash
cd /Users/jenova/projects/jenova-marie/agora-server && pnpm --filter @agora-server/contract build && pnpm -r typecheck
```

Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add packages/contract/src/social.ts packages/contract/src/social.test.ts packages/contract/src/index.ts
git commit -m "✨ feat(social): contract schema + tier defaults + clamp/resolve for social_config

The community↔corporate privacy switch (docs/SOCIAL-GRAPH.md §5): zod PATCH schema,
per-tier defaults, forbiddenSocialKeys (reject-on-write) and resolveSocialConfig
(clamp-on-read, fail-closed). The clamp matrix is fully unit-tested — it carries the
tier invariants (k-floor never below 5, corporate analytics never live under community).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: DB column + migration

**Files:**
- Modify: `apps/api/src/db/schema/projects.ts`
- Generate: `apps/api/drizzle/0038_*.sql`

- [ ] **Step 1: Add the column to the Drizzle schema** — in `apps/api/src/db/schema/projects.ts`, after the `stewardConfig` column definition add:

```typescript
  // Per-project social-graph config: the community↔corporate privacy tier + feature flags
  // (docs/SOCIAL-GRAPH.md §5, docs/AGORA-CORP.md §4). Resolved via lib/social-config.ts
  // (tier defaults + clamp, fail-closed); edited in admin Settings → Social Graph. Empty = community defaults.
  socialConfig: jsonb("social_config").notNull().default(sql`'{}'::jsonb`),
```

- [ ] **Step 2: Generate the migration**

```bash
cd /Users/jenova/projects/jenova-marie/agora-server/apps/api && pnpm db:generate
```

Expected: a new `drizzle/0038_<name>.sql` containing `ALTER TABLE "projects" ADD COLUMN "social_config" jsonb DEFAULT '{}'::jsonb NOT NULL;`. Inspect it; if drizzle emitted anything beyond that single ALTER, stop and investigate before committing.

- [ ] **Step 3: Apply (idempotent) and typecheck**

```bash
pnpm db:migrate && pnpm typecheck
```

Expected: migration applies cleanly; typecheck passes.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema/projects.ts drizzle/
git commit -m "✨ feat(social): projects.social_config jsonb column (migration 0038)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: API resolver lib (cached, mirrors steward-config)

**Files:**
- Create: `apps/api/src/lib/social-config.ts`
- Create: `apps/api/src/lib/social-config.test.ts`

- [ ] **Step 1: Write the failing test** — create `apps/api/src/lib/social-config.test.ts` (tests the pure view fn; the cached getter is DB-backed and covered by integration tests):

```typescript
import { describe, expect, it } from "vitest";
import { SOCIAL_TIER_DEFAULTS, resolveSocialConfig } from "@agora-server/contract";
import { socialConfigView, transparencyView } from "./social-config.js";

describe("socialConfigView", () => {
  it("returns stored overrides + effective config side by side", () => {
    const stored = { privacyTier: "corporate", weatherEnabled: false };
    const view = socialConfigView(stored, resolveSocialConfig(stored));
    expect(view.stored).toEqual(stored);
    expect(view.effective.privacyTier).toBe("corporate");
    expect(view.effective.weatherEnabled).toBe(false);
    expect(view.effective.readReceiptsAllowed).toBe(true);
  });
  it("treats garbage stored state as empty", () => {
    const view = socialConfigView("nonsense", resolveSocialConfig("nonsense"));
    expect(view.stored).toEqual({});
    expect(view.effective).toEqual(SOCIAL_TIER_DEFAULTS.community);
  });
});

describe("transparencyView — the member-facing invariant (docs/AGORA-CORP.md §4.5)", () => {
  it("exposes tier + analytics + garden surfaces, nothing else", () => {
    const t = transparencyView(SOCIAL_TIER_DEFAULTS.corporate);
    expect(t).toEqual({
      privacyTier: "corporate",
      analytics: {
        influenceScores: true,
        siloDetection: true,
        engagementScores: true,
        frictionAnalytics: true,
        readReceiptsAllowed: true,
      },
      garden: { graph: true, weather: true, constellation: true, neighborhood: true, readAffinity: true },
      decay: { warmthHalfLifeDays: 30, frictionHalfLifeDays: 14 },
    });
  });
  it("community tier reads all-analytics-off", () => {
    const t = transparencyView(SOCIAL_TIER_DEFAULTS.community);
    expect(Object.values(t.analytics).every((v) => v === false)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/jenova/projects/jenova-marie/agora-server/apps/api && pnpm test -- social-config
```

Expected: FAIL — `Cannot find module './social-config.js'`.

- [ ] **Step 3: Implement** — create `apps/api/src/lib/social-config.ts`:

```typescript
// Per-project social-graph config, resolved from projects.social_config JSONB with a 30s cache +
// invalidate — mirrors lib/steward-config.ts. Resolution/clamping is the contract's pure
// resolveSocialConfig (fail-closed → community defaults). See docs/SOCIAL-GRAPH.md §5.
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { projects } from "../db/schema/index.js";
import { resolveSocialConfig, type ResolvedSocialConfig } from "@agora-server/contract";

const CONFIG_TTL_MS = 30_000;
const cache = new Map<string, { cfg: ResolvedSocialConfig; at: number }>();

export async function getSocialConfig(projectId: string): Promise<ResolvedSocialConfig> {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.cfg;
  const [p] = await db
    .select({ socialConfig: projects.socialConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const cfg = resolveSocialConfig(p?.socialConfig);
  cache.set(projectId, { cfg, at: Date.now() });
  return cfg;
}

/** Drop the cached config (call after an admin PATCHes /settings/social). */
export function invalidateSocialConfig(projectId: string): void {
  cache.delete(projectId);
}

/** Admin GET view: the raw stored overrides + the effective (resolved, clamped) config. */
export function socialConfigView(stored: unknown, effective: ResolvedSocialConfig) {
  const s = (stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}) as Record<string, unknown>;
  return { stored: s, effective };
}

/** Member-facing transparency view (docs/AGORA-CORP.md §4.5): the active tier + every enabled
 *  analytic, readable by any authenticated member. Members always know which instrument their
 *  instance is. */
export function transparencyView(cfg: ResolvedSocialConfig) {
  return {
    privacyTier: cfg.privacyTier,
    analytics: {
      influenceScores: cfg.influenceScoresEnabled,
      siloDetection: cfg.siloDetectionEnabled,
      engagementScores: cfg.engagementScoresEnabled,
      frictionAnalytics: cfg.frictionAnalyticsEnabled,
      readReceiptsAllowed: cfg.readReceiptsAllowed,
    },
    garden: {
      graph: cfg.graphEnabled,
      weather: cfg.weatherEnabled,
      constellation: cfg.constellationEnabled,
      neighborhood: cfg.neighborhoodEnabled,
      readAffinity: cfg.readAffinityEnabled,
    },
    decay: { warmthHalfLifeDays: cfg.warmthHalfLifeDays, frictionHalfLifeDays: cfg.frictionHalfLifeDays },
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm test -- social-config
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/social-config.ts src/lib/social-config.test.ts
git commit -m "✨ feat(social): cached social-config resolver + admin/transparency views

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: API routes — GET/PATCH /settings/social + GET /social/transparency

**Files:**
- Modify: `apps/api/src/routes/misc.ts`

- [ ] **Step 1: Read the integration points.** Open `apps/api/src/routes/misc.ts`. Locate: (a) the `/settings/moderator` GET/PATCH block (~lines 163–187) — the new settings block goes directly after it; (b) the import list at the top; (c) the `requireProjectAdmin` helper (~lines 237–242); (d) confirm the bad-request error helper name in `apps/api/src/http/errors.ts` (expected `Errors.badRequest(code, message)` — if it differs, e.g. `Errors.invalid`, use that name in Step 2 and adjust the integration test's expected `code` field accordingly).

- [ ] **Step 2: Add imports** — extend the existing `@agora-server/contract` import in `misc.ts` with `socialConfigSchema, forbiddenSocialKeys, resolveSocialConfig, SOCIAL_PRIVACY_TIERS, type SocialPrivacyTier`, and add:

```typescript
import { getSocialConfig, invalidateSocialConfig, socialConfigView, transparencyView } from "../lib/social-config.js";
```

- [ ] **Step 3: Add the routes** — directly after the `.patch("/settings/moderator", …)` block, insert:

```typescript
  // ── social graph (community↔corporate tier; project-admin only) ─
  // Per-project social-graph config (docs/SOCIAL-GRAPH.md §5). Two enforcement points: forbidden
  // flags are REJECTED on write (400 social/tier-forbidden), and the resolver CLAMPS on read
  // (stale flags from a corporate→community switch are neutralized, never served).
  .get("/settings/social", requireAuth, async (c) => {
    await requireProjectAdmin(c);
    const [row] = await db
      .select({ socialConfig: projects.socialConfig })
      .from(projects)
      .where(eq(projects.id, c.var.projectId))
      .limit(1);
    return c.json(socialConfigView(row?.socialConfig, resolveSocialConfig(row?.socialConfig)));
  })
  .patch("/settings/social", requireAuth, async (c) => {
    await requireProjectAdmin(c);
    const body = parseBody(socialConfigSchema, await c.req.json().catch(() => ({})), "social");
    const [row] = await db
      .select({ socialConfig: projects.socialConfig })
      .from(projects)
      .where(eq(projects.id, c.var.projectId))
      .limit(1);
    const current = (row?.socialConfig && typeof row.socialConfig === "object" ? row.socialConfig : {}) as Record<string, any>;
    // Validate against the RESULTING tier (a tier change and flags may arrive in one PATCH).
    const nextTier: SocialPrivacyTier =
      body.privacyTier ?? (SOCIAL_PRIVACY_TIERS.includes(current.privacyTier) ? current.privacyTier : "community");
    const forbidden = forbiddenSocialKeys(nextTier, body as Record<string, unknown>);
    if (forbidden.length) {
      throw Errors.badRequest(
        "social/tier-forbidden",
        `Not allowed under the '${nextTier}' tier: ${forbidden.join(", ")}`,
      );
    }
    const next: Record<string, any> = { ...current };
    for (const k of [
      "privacyTier", "graphEnabled", "weatherEnabled", "constellationEnabled", "constellationKFloor",
      "neighborhoodEnabled", "influenceScoresEnabled", "siloDetectionEnabled", "engagementScoresEnabled",
      "frictionVisibleToStewards", "frictionAnalyticsEnabled", "readAffinityEnabled", "readReceiptsAllowed",
      "warmthHalfLifeDays", "frictionHalfLifeDays",
    ] as const) {
      const v = (body as Record<string, unknown>)[k];
      if (v === undefined) continue;
      if (v === null) delete next[k]; // clear → tier default
      else next[k] = v;
    }
    await db.update(projects).set({ socialConfig: next }).where(eq(projects.id, c.var.projectId));
    invalidateSocialConfig(c.var.projectId);
    return c.json(socialConfigView(next, resolveSocialConfig(next)));
  })
  // ── social transparency (any authenticated member) ─
  // INVARIANT (docs/AGORA-CORP.md §4.5): the active tier + enabled analytics are readable by every
  // member — people always know which instrument their instance is. Auth required (not public).
  .get("/social/transparency", requireAuth, async (c) => {
    return c.json(transparencyView(await getSocialConfig(c.var.projectId)));
  })
```

- [ ] **Step 4: Typecheck**

```bash
cd /Users/jenova/projects/jenova-marie/agora-server && pnpm -r typecheck
```

Expected: pass. (If `Errors.badRequest` doesn't exist, fix per Step 1d.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/misc.ts
git commit -m "✨ feat(social): settings/social GET+PATCH (reject-on-write) + member transparency endpoint

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Integration tests (gates + tier semantics)

**Files:**
- Create: `apps/api/test/integration/social-config.test.ts`

- [ ] **Step 1: Read the harness.** Open an existing file in `apps/api/test/integration/` (pick the smallest settings-related one) and note: how a test project row is minted, how authed requests are issued (helper to mint a JWT / call the Hono app), and the assertion style. **Adapt the imports/setup of the test below to that harness exactly** — the test bodies/assertions stay as written.

- [ ] **Step 2: Write the integration test** — create `apps/api/test/integration/social-config.test.ts` with these cases (adapt setup helpers per Step 1):

```typescript
import { describe, expect, it } from "vitest";
// Adapt these imports to the existing integration harness (see Step 1):
// - a helper that creates an isolated project + an admin user + a plain member user
// - a helper that performs authed JSON requests against the app

describe("social config — settings + transparency", () => {
  it("GET /settings/social returns community defaults for a fresh project", async () => {
    // as project admin:
    const res = await adminGet("/settings/social");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stored).toEqual({});
    expect(body.effective.privacyTier).toBe("community");
    expect(body.effective.readReceiptsAllowed).toBe(false);
  });

  it("403s a non-admin member on GET and PATCH /settings/social", async () => {
    expect((await memberGet("/settings/social")).status).toBe(403);
    expect((await memberPatch("/settings/social", { weatherEnabled: false })).status).toBe(403);
  });

  it("400s a corporate-only flag under community (reject-on-write)", async () => {
    const res = await adminPatch("/settings/social", { readReceiptsAllowed: true });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("social/tier-forbidden");
  });

  it("accepts tier switch + corporate flag in one PATCH (validated against the resulting tier)", async () => {
    const res = await adminPatch("/settings/social", { privacyTier: "corporate", readReceiptsAllowed: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.effective.privacyTier).toBe("corporate");
    expect(body.effective.readReceiptsAllowed).toBe(true);
  });

  it("clamps stale corporate flags after switching back to community (clamp-on-read)", async () => {
    await adminPatch("/settings/social", { privacyTier: "corporate", engagementScoresEnabled: true });
    const res = await adminPatch("/settings/social", { privacyTier: "community" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stored.engagementScoresEnabled).toBe(true); // still stored…
    expect(body.effective.engagementScoresEnabled).toBe(false); // …but never effective
  });

  it("null clears an override back to the tier default", async () => {
    await adminPatch("/settings/social", { weatherEnabled: false });
    const res = await adminPatch("/settings/social", { weatherEnabled: null });
    const body = await res.json();
    expect(body.stored.weatherEnabled).toBeUndefined();
    expect(body.effective.weatherEnabled).toBe(true);
  });

  it("GET /social/transparency: any authed member sees tier + analytics; anonymous is rejected", async () => {
    const res = await memberGet("/social/transparency");
    expect(res.status).toBe(200);
    const t = await res.json();
    expect(t.privacyTier).toBeDefined();
    expect(t.analytics).toHaveProperty("readReceiptsAllowed");
    expect((await anonGet("/social/transparency")).status).toBe(401);
  });
});
```

- [ ] **Step 3: Run the integration suite**

```bash
cd /Users/jenova/projects/jenova-marie/agora-server/apps/api && TMPDIR="$HOME/.cache/agora-tmp" pnpm test:integration -- social-config
```

Expected: PASS (needs `TEST_DATABASE_URL`; the `TMPDIR` prefix avoids the known macOS `/private/tmp` ENOSPC — see CLAUDE.md).

- [ ] **Step 4: Commit**

```bash
git add test/integration/social-config.test.ts
git commit -m "🧪 test(social): integration coverage for settings gates, tier semantics, transparency

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Admin client lib

**Files:**
- Modify: `apps/admin/src/lib/settings.ts`

- [ ] **Step 1: Append the social section** — at the end of `apps/admin/src/lib/settings.ts`, following the moderator section's pattern:

```typescript
// ── Social graph (GET/PATCH /settings/social) ────────────────────────────────────────────────────
export type SocialPrivacyTier = "community" | "corporate";

export interface ResolvedSocialConfig {
  privacyTier: SocialPrivacyTier;
  graphEnabled: boolean;
  weatherEnabled: boolean;
  constellationEnabled: boolean;
  constellationKFloor: number;
  neighborhoodEnabled: boolean;
  influenceScoresEnabled: boolean;
  siloDetectionEnabled: boolean;
  engagementScoresEnabled: boolean;
  frictionVisibleToStewards: boolean;
  frictionAnalyticsEnabled: boolean;
  readAffinityEnabled: boolean;
  readReceiptsAllowed: boolean;
  warmthHalfLifeDays: number;
  frictionHalfLifeDays: number;
}

export interface SocialConfigView {
  stored: Partial<ResolvedSocialConfig>;
  effective: ResolvedSocialConfig;
}

// PATCH semantics: omit = unchanged, null = clear override (→ tier default).
export type SocialConfigPatch = { [K in keyof ResolvedSocialConfig]?: ResolvedSocialConfig[K] | null };

export function getSocialConfig(signal?: AbortSignal): Promise<SocialConfigView> {
  return api<SocialConfigView>("/settings/social", { signal });
}

export function updateSocialConfig(patch: SocialConfigPatch): Promise<SocialConfigView> {
  return api<SocialConfigView>("/settings/social", { method: "PATCH", body: patch });
}
```

(Note: match the existing `api<T>()` helper's actual signature in this file — if PATCH bodies are passed as `body: JSON.stringify(patch)` or a different option shape elsewhere in the file, mirror that exactly.)

- [ ] **Step 2: Typecheck**

```bash
cd /Users/jenova/projects/jenova-marie/agora-server && pnpm -r typecheck
```

- [ ] **Step 3: Commit**

```bash
git add apps/admin/src/lib/settings.ts
git commit -m "✨ feat(admin): social-config client types + fetchers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Admin panel — Settings → Social Graph

**Files:**
- Create: `apps/admin/src/routes/settings/SocialGraphPanel.tsx`
- Modify: `apps/admin/src/routes/SettingsPage.tsx`

- [ ] **Step 1: Read the patterns.** Open `apps/admin/src/routes/settings/StewardPanel.tsx` (the simplest existing panel) and `SettingsPage.tsx`. Note: the React Query setup (`useQuery`/`useMutation` import source), the section wrapper component/classNames `SettingsPage` uses per panel, the `SETTINGS_READ_ONLY` flag usage, and any shared `Field`/save-button styling. **Mirror those exact wrappers/classNames in Step 2** — the component logic below stays as written.

- [ ] **Step 2: Create the panel** — `apps/admin/src/routes/settings/SocialGraphPanel.tsx`:

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getSocialConfig,
  updateSocialConfig,
  type ResolvedSocialConfig,
  type SocialConfigPatch,
  type SocialConfigView,
  type SocialPrivacyTier,
} from "../../lib/settings";

// Settings → Social Graph: the community↔corporate privacy tier + feature flags
// (docs/SOCIAL-GRAPH.md §5, docs/AGORA-CORP.md §4). Corporate-only analytics render locked under
// the community tier; the server rejects them anyway (400 social/tier-forbidden) — the lock here
// is honesty, not enforcement.
const CORPORATE_ONLY = [
  "influenceScoresEnabled",
  "siloDetectionEnabled",
  "engagementScoresEnabled",
  "frictionAnalyticsEnabled",
  "readReceiptsAllowed",
] as const;

const FLAG_LABELS: Array<{ key: keyof ResolvedSocialConfig; label: string; hint: string }> = [
  { key: "graphEnabled", label: "Social graph", hint: "Master switch for all graph-backed features." },
  { key: "weatherEnabled", label: "Weather", hint: "Aggregate community-health gauge (members)." },
  { key: "constellationEnabled", label: "Constellation", hint: "Anonymous cluster view (members, k-anonymized)." },
  { key: "neighborhoodEnabled", label: "Neighborhood", hint: "A member's own warm ties (self-view only)." },
  { key: "readAffinityEnabled", label: "Read affinity", hint: "Private per-viewer feed boost. Never graph data." },
  { key: "frictionVisibleToStewards", label: "Steward friction context", hint: "Audited, in-context only." },
  { key: "influenceScoresEnabled", label: "Influence scores", hint: "PageRank / bridge analytics (operators). Corporate tier." },
  { key: "siloDetectionEnabled", label: "Silo detection", hint: "Cross-team cluster analytics (operators). Corporate tier." },
  { key: "engagementScoresEnabled", label: "Engagement scores", hint: "Per-person warmth visible to operators. Corporate tier." },
  { key: "frictionAnalyticsEnabled", label: "Friction analytics", hint: "Aggregate conflict analytics (operators). Corporate tier." },
  { key: "readReceiptsAllowed", label: "Read receipts", hint: "Per-space opt-in, announcement spaces only. Corporate tier." },
];

export function SocialGraphPanel() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["settings", "social"],
    queryFn: ({ signal }) => getSocialConfig(signal),
    staleTime: 30_000,
  });
  if (isLoading) return <p className="text-sm text-neutral-500">Loading social graph settings…</p>;
  if (isError || !data) return <p className="text-sm text-red-600">Failed to load social graph settings.</p>;
  return <SocialGraphForm view={data} />;
}

function SocialGraphForm({ view }: { view: SocialConfigView }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ResolvedSocialConfig>(view.effective);
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (patch: SocialConfigPatch) => updateSocialConfig(patch),
    onSuccess: (next) => {
      qc.setQueryData(["settings", "social"], next);
      setDraft(next.effective);
      setError(null);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : "Save failed"),
  });

  const isCommunity = draft.privacyTier === "community";
  const setFlag = (k: keyof ResolvedSocialConfig, v: boolean | number | SocialPrivacyTier) =>
    setDraft((d) => {
      const next = { ...d, [k]: v };
      // Flipping to community immediately locks the corporate-only flags off in the draft,
      // mirroring the server's clamp so the form never shows a state the server would refuse.
      if (k === "privacyTier" && v === "community") for (const f of CORPORATE_ONLY) (next as any)[f] = false;
      return next;
    });

  const save = () => {
    // Send only keys that differ from the server's current effective config.
    const patch: SocialConfigPatch = {};
    for (const { key } of FLAG_LABELS) if (draft[key] !== view.effective[key]) (patch as any)[key] = draft[key];
    if (draft.privacyTier !== view.effective.privacyTier) patch.privacyTier = draft.privacyTier;
    if (draft.constellationKFloor !== view.effective.constellationKFloor) patch.constellationKFloor = draft.constellationKFloor;
    if (draft.warmthHalfLifeDays !== view.effective.warmthHalfLifeDays) patch.warmthHalfLifeDays = draft.warmthHalfLifeDays;
    if (draft.frictionHalfLifeDays !== view.effective.frictionHalfLifeDays) patch.frictionHalfLifeDays = draft.frictionHalfLifeDays;
    mutation.mutate(patch);
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium">Privacy tier</label>
        <select
          className="mt-1 rounded border px-2 py-1 text-sm"
          value={draft.privacyTier}
          onChange={(e) => setFlag("privacyTier", e.target.value as SocialPrivacyTier)}
        >
          <option value="community">community — vulnerable-population defaults (analytics locked off)</option>
          <option value="corporate">corporate — disclosed organizational analytics</option>
        </select>
        <p className="mt-1 text-xs text-neutral-500">
          The tier is visible to every member via the transparency endpoint — analytics are disclosed, never covert.
        </p>
      </div>

      <div className="space-y-2">
        {FLAG_LABELS.map(({ key, label, hint }) => {
          const corporateOnly = (CORPORATE_ONLY as readonly string[]).includes(key);
          const locked = corporateOnly && isCommunity;
          return (
            <label key={key} className={`flex items-start gap-2 text-sm ${locked ? "opacity-50" : ""}`}>
              <input
                type="checkbox"
                checked={draft[key] as boolean}
                disabled={locked || mutation.isPending}
                onChange={(e) => setFlag(key, e.target.checked)}
              />
              <span>
                <span className="font-medium">{label}</span>
                {locked && <span className="ml-1 text-xs text-neutral-400">(corporate tier only)</span>}
                <span className="block text-xs text-neutral-500">{hint}</span>
              </span>
            </label>
          );
        })}
      </div>

      <div className="flex gap-4">
        <NumberField label="Constellation k-floor (min 5)" min={5} value={draft.constellationKFloor}
          onChange={(v) => setFlag("constellationKFloor", v)} />
        <NumberField label="Warmth half-life (days)" min={1} value={draft.warmthHalfLifeDays}
          onChange={(v) => setFlag("warmthHalfLifeDays", v)} />
        <NumberField label="Friction half-life (days)" min={1} value={draft.frictionHalfLifeDays}
          onChange={(v) => setFlag("frictionHalfLifeDays", v)} />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="button"
        className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
        disabled={mutation.isPending}
        onClick={save}
      >
        {mutation.isPending ? "Saving…" : "Save social graph settings"}
      </button>
    </div>
  );
}

function NumberField({ label, min, value, onChange }: { label: string; min: number; value: number; onChange: (v: number) => void }) {
  return (
    <label className="block text-sm">
      <span className="font-medium">{label}</span>
      <input
        type="number"
        className="mt-1 block w-32 rounded border px-2 py-1"
        min={min}
        value={value}
        onChange={(e) => onChange(Math.max(min, Number(e.target.value) || min))}
      />
    </label>
  );
}
```

Adapt classNames/wrappers to whatever `StewardPanel.tsx` actually uses (Step 1) — keep the logic identical. If the panels share a `Field`/`Section` helper, use it instead of the raw markup above. Honor `SETTINGS_READ_ONLY` the same way the other panels do (disable inputs + hide the save button).

- [ ] **Step 3: Mount in SettingsPage** — in `apps/admin/src/routes/SettingsPage.tsx`, import and add a section between the Stewardship and Project-webhooks sections, mirroring the surrounding section markup exactly:

```tsx
import { SocialGraphPanel } from "./settings/SocialGraphPanel";
// …inside the page, mirroring the sibling sections' wrapper:
<SocialGraphPanel />
```

- [ ] **Step 4: Typecheck + build the admin app**

```bash
cd /Users/jenova/projects/jenova-marie/agora-server && pnpm -r typecheck && pnpm --filter @agora/admin build
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/routes/settings/SocialGraphPanel.tsx apps/admin/src/routes/SettingsPage.tsx
git commit -m "✨ feat(admin): Settings → Social Graph panel (tier picker + clamped flags)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Changelog, docs, full verification

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/SOCIAL-GRAPH.md`
- Add: `docs/AGORA-SOCIAL.md`, `docs/AGORA-CORP.md` (already written, untracked)

- [ ] **Step 1: Changelog** — under `## [Unreleased]` → `### Added`:

```markdown
- Social-graph configuration foundation (`projects.social_config`): the community↔corporate
  privacy tier from `docs/SOCIAL-GRAPH.md` §5. Zod-validated contract schema + per-tier defaults
  with two-point enforcement (forbidden flags rejected on write with `social/tier-forbidden`,
  clamped at read time), admin `GET/PATCH /settings/social`, member-facing
  `GET /social/transparency` (the active tier + enabled analytics are always visible to members),
  and an admin Settings → Social Graph panel. Migration `0038`.
```

- [ ] **Step 2: Mark the design doc** — in `docs/SOCIAL-GRAPH.md`, update the status line to note: §5 (`social_config`) is implemented (PR 1); keys are camelCase in the implementation (`privacyTier`, not `privacy_tier`).

- [ ] **Step 3: Full verification gate** (CLAUDE.md: don't claim completion otherwise)

```bash
cd /Users/jenova/projects/jenova-marie/agora-server
pnpm -r build && pnpm -r typecheck && pnpm test
cd apps/api && TMPDIR="$HOME/.cache/agora-tmp" pnpm test:integration -- social-config
```

Expected: all green.

- [ ] **Step 4: Commit docs + changelog**

```bash
git add CHANGELOG.md docs/SOCIAL-GRAPH.md docs/AGORA-SOCIAL.md docs/AGORA-CORP.md
git commit -m "📝 docs(social): changelog + design docs for the social-config foundation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Push and open the PR** (confirm with Jenova if not already authorized)

```bash
git push -u github feat/social-config
gh pr create --base root --title "feat(social): community↔corporate social_config foundation (PR 1)" --body "$(cat <<'EOF'
## Summary
- `projects.social_config` jsonb (migration 0038) — the community↔corporate privacy-tier switch from docs/SOCIAL-GRAPH.md §5
- Contract: zod schema, per-tier defaults, pure clamp/resolve (fully unit-tested — the clamp matrix carries the tier invariants)
- Two-point enforcement: forbidden flags rejected on write (400 `social/tier-forbidden`) AND clamped on read (stale flags after a tier switch are never served)
- Admin `GET/PATCH /settings/social` (requireProjectAdmin) + member `GET /social/transparency` (the disclosed-analytics invariant)
- Admin Settings → Social Graph panel
- Design docs: SOCIAL-GRAPH.md, AGORA-SOCIAL.md, AGORA-CORP.md

## Test plan
- [x] contract unit tests (tier defaults, forbidden keys, clamp matrix, k-floor)
- [x] api unit tests (views)
- [x] integration tests (403 non-admin, 400 forbidden flag, tier-switch semantics, null-clears, transparency)
- [x] `pnpm -r build && pnpm -r typecheck && pnpm test` green

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** SOCIAL-GRAPH.md §5 fields → all 15 present in schema/defaults/resolver/panel. Tier-clamp ("validation clamps every flag… fail closed") → `forbiddenSocialKeys` + `resolveSocialConfig` + both test suites. Transparency invariant (AGORA-CORP.md §4.5) → `/social/transparency` + `transparencyView` test. Jenova's four decisions → Task 7 (UI in PR 1), `requireProjectAdmin` gate, reject+clamp (Tasks 1/4/5), authed member endpoint (Task 4).
- **Known integration-point risks (deliberate, flagged in-task):** exact `Errors.badRequest` helper name (Task 4 Step 1d), integration-harness helpers (Task 5 Step 1), admin `api<T>()` body shape + panel wrapper markup (Tasks 6–7 Step 1). Each task front-loads a read-the-real-file step before code lands.
- **Type consistency:** `ResolvedSocialConfig` field names identical across contract, api lib, admin lib, panel. `SocialConfigView = { stored, effective }` consistent across Task 3 view fn, Task 4 routes, Task 5 assertions, Task 6 types.
- **Not in this PR (YAGNI, per plan):** no Neo4j client, no Weather endpoint (PR 2), no scorer changes (PR 3), no per-space read-receipt opt-in (Phase 4 — `readReceiptsAllowed` is only the master gate).
