import { describe, it, expect } from "vitest";
import { canRsvpGoing, isEventHost, wouldOrphanHosts, canViewEvent } from "./events-policy.js";

describe("canRsvpGoing", () => {
  it("allows unlimited capacity (null)", () => expect(canRsvpGoing(999, null)).toBe(true));
  it("allows while under capacity, blocks at/over", () => {
    expect(canRsvpGoing(4, 5)).toBe(true);
    expect(canRsvpGoing(5, 5)).toBe(false);
    expect(canRsvpGoing(6, 5)).toBe(false);
  });
});

describe("isEventHost", () => {
  it("is true only when the user id is in hostIds", () => {
    expect(isEventHost(["a", "b"], "b")).toBe(true);
    expect(isEventHost(["a", "b"], "c")).toBe(false);
    expect(isEventHost(["a"], undefined)).toBe(false);
  });
});

describe("wouldOrphanHosts", () => {
  it("is true only when removing the sole host", () => {
    expect(wouldOrphanHosts(["a"], "a")).toBe(true);
    expect(wouldOrphanHosts(["a", "b"], "a")).toBe(false);
    expect(wouldOrphanHosts(["a", "b"], "c")).toBe(false); // not a host → not orphaning
  });
});

describe("canViewEvent", () => {
  const V = (p: any) => ({ isAuthed: false, isMember: false, isInvited: false, isHostOrAdmin: false, ...p });
  it("host/admin always see, regardless of visibility", () => {
    expect(canViewEvent({ visibility: "invite" }, V({ isHostOrAdmin: true }))).toBe(true);
  });
  it("public is visible to anyone", () => {
    expect(canViewEvent({ visibility: "public" }, V({}))).toBe(true);
  });
  it("members requires membership", () => {
    expect(canViewEvent({ visibility: "members" }, V({ isAuthed: true, isMember: true }))).toBe(true);
    expect(canViewEvent({ visibility: "members" }, V({ isAuthed: true, isMember: false }))).toBe(false);
  });
  it("invite requires an invitation", () => {
    expect(canViewEvent({ visibility: "invite" }, V({ isAuthed: true, isInvited: true }))).toBe(true);
    expect(canViewEvent({ visibility: "invite" }, V({ isAuthed: true, isInvited: false }))).toBe(false);
  });
});
