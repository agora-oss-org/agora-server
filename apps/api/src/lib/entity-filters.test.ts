import { describe, expect, it } from "vitest";
import { parseBracketQuery } from "./entity-filters.js";

// parseBracketQuery turns the SDK's Axios bracket-notation query string (the exact wire format
// agora-sdk's entityListsApi serializes filter objects into) back into nested objects/arrays. It's
// the parse half of the feed-filter pipeline; buildFeedConditions (translation → SQL) is exercised
// by the integration suite. These cases pin the parsing contract on its own.
const q = (qs: string) => parseBracketQuery(`http://x/feed?${qs}`);

describe("parseBracketQuery", () => {
  it("returns {} for an empty query string", () => {
    expect(q("")).toEqual({});
  });

  it("parses a flat scalar key", () => {
    expect(q("timeFrame=week")).toEqual({ timeFrame: "week" });
  });

  it("keeps every value a string (no coercion)", () => {
    // downstream truthy()/Number() do the coercion; the parser must not pre-coerce.
    expect(q("followedOnly=true&locationFilters[radius]=500")).toEqual({
      followedOnly: "true",
      locationFilters: { radius: "500" },
    });
  });

  it("nests a single bracket segment into an object", () => {
    expect(q("attachmentsFilters[hasAttachments]=true")).toEqual({
      attachmentsFilters: { hasAttachments: "true" },
    });
  });

  it("nests deep bracket segments (metadataFilters[includes][status]=active)", () => {
    expect(q("metadataFilters[includes][status]=active")).toEqual({
      metadataFilters: { includes: { status: "active" } },
    });
  });

  it("builds an array when the next segment is a numeric index", () => {
    expect(q("keywordsFilters[includes][0]=x&keywordsFilters[includes][1]=y")).toEqual({
      keywordsFilters: { includes: ["x", "y"] },
    });
  });

  it("preserves index order regardless of query order", () => {
    const out = q("k[includes][1]=second&k[includes][0]=first");
    expect(out.k.includes).toEqual(["first", "second"]);
  });

  it("merges sibling keys under the same parent", () => {
    expect(q("titleFilters[hasTitle]=true&titleFilters[includes][0]=hello")).toEqual({
      titleFilters: { hasTitle: "true", includes: ["hello"] },
    });
  });

  it("URL-decodes keys and values", () => {
    expect(q("metadataFilters[includes][full%20name]=Ada%20Lovelace")).toEqual({
      metadataFilters: { includes: { "full name": "Ada Lovelace" } },
    });
  });

  it("handles a realistic multi-filter SDK request", () => {
    const out = q(
      "timeFrame=month&sortBy=hot&followedOnly=false" +
        "&keywordsFilters[includes][0]=trans&keywordsFilters[doesNotInclude][0]=spam" +
        "&metadataFilters[includesAny][0][tier]=gold&metadataFilters[exists][0]=verified",
    );
    expect(out).toEqual({
      timeFrame: "month",
      sortBy: "hot",
      followedOnly: "false",
      keywordsFilters: { includes: ["trans"], doesNotInclude: ["spam"] },
      metadataFilters: { includesAny: [{ tier: "gold" }], exists: ["verified"] },
    });
  });
});
