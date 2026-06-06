// Integration: entity-feed filters + sort (lib/entity-filters.ts) against a real Postgres.
// Exercises the SDK's bracket-notation filter contract end-to-end: keyword/title/content/
// attachments/metadata filters, followedOnly, timeFrame, and the sort modes.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { api, createProject, createUser, deleteProject, base } from "./helpers.js";
import { db } from "../../src/db/index.js";
import { entities } from "../../src/db/schema/index.js";

describe("entity feed filters + sort (integration)", () => {
  let projectId: string;
  let owner: { id: string; token: string };
  let followee: { id: string; token: string };
  let B: string;
  const id: Record<string, string> = {}; // label -> entity id

  // ids returned by a feed query, in order
  const feed = async (qs: string) => {
    const res = await api("GET", `${B}/entities?${qs}`, { token: owner.token });
    expect(res.status).toBe(200);
    return (res.body.data as any[]).map((e) => e.id);
  };
  const labelsOf = (ids: string[]) => ids.map((x) => Object.keys(id).find((k) => id[k] === x) ?? x);

  beforeAll(async () => {
    projectId = await createProject();
    owner = await createUser(projectId);
    followee = await createUser(projectId);
    B = base(projectId);

    const mk = async (token: string, body: Record<string, unknown>) => {
      const res = await api("POST", `${B}/entities`, { token, body });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    // created oldest→newest in this order
    id.ramen = await mk(owner.token, {
      title: "Ramen Guide", content: "tonkotsu broth recipe", keywords: ["food", "ramen"],
      metadata: { category: "food", level: "beginner" }, attachments: [{ url: "x.jpg" }],
    });
    id.sushi = await mk(owner.token, {
      title: "Sushi Tips", content: "fresh fish selection", keywords: ["food", "sushi"],
      metadata: { category: "food", level: "advanced" },
    });
    id.misc = await mk(owner.token, {
      content: "no title here", keywords: ["misc"], metadata: { category: "misc" },
    });
    id.byFollowee = await mk(followee.token, {
      title: "Followee Post", content: "hello from followee", keywords: ["food"], metadata: { category: "food" },
    });
  });

  afterAll(async () => {
    if (projectId) await deleteProject(projectId);
  });

  it("titleFilters: hasTitle + includes", async () => {
    expect((await feed("titleFilters[hasTitle]=true")).sort()).toEqual([id.ramen, id.sushi, id.byFollowee].sort());
    expect(await feed("titleFilters[hasTitle]=false")).toEqual([id.misc]);
    expect(await feed("titleFilters[includes]=Ramen")).toEqual([id.ramen]);
  });

  it("contentFilters: includes + doesNotInclude", async () => {
    expect(await feed("contentFilters[includes]=fish")).toEqual([id.sushi]);
    const noBroth = await feed("contentFilters[doesNotInclude]=broth");
    expect(noBroth).not.toContain(id.ramen);
    expect(noBroth.sort()).toEqual([id.sushi, id.misc, id.byFollowee].sort());
  });

  it("keywordsFilters: includes is 'has all', doesNotInclude is 'has none'", async () => {
    expect(await feed("keywordsFilters[includes][0]=food&keywordsFilters[includes][1]=ramen")).toEqual([id.ramen]);
    expect((await feed("keywordsFilters[includes][0]=food")).sort()).toEqual([id.ramen, id.sushi, id.byFollowee].sort());
    const noSushi = await feed("keywordsFilters[doesNotInclude][0]=sushi");
    expect(noSushi).not.toContain(id.sushi);
  });

  it("attachmentsFilters: hasAttachments", async () => {
    expect(await feed("attachmentsFilters[hasAttachments]=true")).toEqual([id.ramen]);
    expect(await feed("attachmentsFilters[hasAttachments]=false")).not.toContain(id.ramen);
  });

  it("metadataFilters: includes / exists / doesNotExist / includesAny / doesNotInclude", async () => {
    expect((await feed("metadataFilters[includes][category]=food")).sort()).toEqual([id.ramen, id.sushi, id.byFollowee].sort());
    expect((await feed("metadataFilters[exists][0]=level")).sort()).toEqual([id.ramen, id.sushi].sort());
    expect((await feed("metadataFilters[doesNotExist][0]=level")).sort()).toEqual([id.misc, id.byFollowee].sort());
    expect((await feed("metadataFilters[includesAny][0][level]=beginner&metadataFilters[includesAny][1][level]=advanced")).sort())
      .toEqual([id.ramen, id.sushi].sort());
    expect(await feed("metadataFilters[doesNotInclude][category]=food")).toEqual([id.misc]);
  });

  it("followedOnly: only entities by followed users (and nothing when unauthenticated)", async () => {
    await api("POST", `${B}/users/${followee.id}/follow`, { token: owner.token });
    expect(await feed("followedOnly=true")).toEqual([id.byFollowee]);
    // unauthenticated → no results
    const anon = await api("GET", `${B}/entities?followedOnly=true`);
    expect(anon.body.data).toHaveLength(0);
  });

  it("timeFrame: excludes entities older than the window", async () => {
    // age `misc` to 10 days ago
    await db.update(entities).set({ createdAt: new Date(Date.now() - 10 * 864e5) }).where(eq(entities.id, id.misc));
    expect(await feed("timeFrame=week")).not.toContain(id.misc);
    expect(await feed("timeFrame=year")).toContain(id.misc);
  });

  it("sort: new (desc default) vs sortDir=asc", async () => {
    // misc was aged to the past, so newest→oldest: byFollowee, sushi, ramen, misc
    expect(await feed("sortBy=new")).toEqual([id.byFollowee, id.sushi, id.ramen, id.misc]);
    expect(await feed("sortBy=new&sortDir=asc")).toEqual([id.misc, id.ramen, id.sushi, id.byFollowee]);
  });

  it("sortByReaction puts the most-reacted first", async () => {
    await api("POST", `${B}/entities/${id.sushi}/reactions`, { token: owner.token, body: { reactionType: "upvote" } });
    const ranked = await feed("sortByReaction=upvote&sortDir=desc");
    expect(ranked[0]).toBe(id.sushi);
  });

  it("sortBy=metadata.<key> orders by a metadata field", async () => {
    // among entities that HAVE level: "advanced" < "beginner" alphabetically → sushi first asc
    const asc = await feed("metadataFilters[exists][0]=level&sortBy=metadata.level&sortType=text&sortDir=asc");
    expect(asc).toEqual([id.sushi, id.ramen]);
  });
});
