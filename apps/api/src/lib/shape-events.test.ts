import { describe, it, expect } from "vitest";
import { shapeEvent } from "./shape.js";

const row = {
  id: "e1", projectId: "p1", shortId: "abc", userId: "u1",
  title: "Launch", description: null, startTime: new Date("2026-07-01T18:00:00Z"),
  endTime: null, timezone: "UTC", type: "online", url: null, venueName: null, address: null,
  spaceId: null, visibility: "public", status: "active", allowMaybe: true, guestListVisible: true,
  capacity: null, coverImageId: null, metadata: {}, moderationStatus: null,
  createdAt: new Date("2026-06-01T00:00:00Z"), updatedAt: new Date("2026-06-01T00:00:00Z"), deletedAt: null,
} as any;

describe("shapeEvent", () => {
  it("maps scalars, derives hostIds + rsvpCounts, ISO-formats dates", () => {
    const out = shapeEvent(row, { location: null, hostIds: ["u1"], rsvpCounts: { going: 2, maybe: 1, not_going: 0 } }) as any;
    expect(out.id).toBe("e1");
    expect(out.hostIds).toEqual(["u1"]);
    expect(out.rsvpCounts).toEqual({ going: 2, maybe: 1, not_going: 0 });
    expect(out.startTime).toBe("2026-07-01T18:00:00.000Z");
    expect(out.location).toBeNull();
    expect("userRsvp" in out).toBe(false); // omitted unless provided
  });
  it("emits GeoJSON [lng, lat] when location is present", () => {
    const out = shapeEvent(row, { location: { lat: 40.5, lng: -73.9 }, hostIds: [], rsvpCounts: { going: 0, maybe: 0, not_going: 0 } }) as any;
    expect(out.location).toEqual({ type: "Point", coordinates: [-73.9, 40.5] });
  });
  it("includes userRsvp when provided (incl. null)", () => {
    const out = shapeEvent(row, { location: null, hostIds: [], rsvpCounts: { going: 0, maybe: 0, not_going: 0 }, userRsvp: "going" }) as any;
    expect(out.userRsvp).toBe("going");
  });
});
