// Pure authorization/semantics predicates for the Events domain (unit-tested without a DB).
// The route resolves the DB facts (counts, membership, invitation, host roster) and calls these.

/** Capacity caps `going` only: null = unlimited; otherwise reject once going-count hits capacity. */
export function canRsvpGoing(goingCount: number, capacity: number | null): boolean {
  return capacity == null || goingCount < capacity;
}

export function isEventHost(hostIds: string[], userId: string | undefined): boolean {
  return !!userId && hostIds.includes(userId);
}

/** Removing the sole host would orphan the event (must be rejected). */
export function wouldOrphanHosts(hostIds: string[], removingUserId: string): boolean {
  return hostIds.length <= 1 && hostIds.includes(removingUserId);
}

export function canViewEvent(
  ev: { visibility: "public" | "members" | "invite" },
  v: { isAuthed: boolean; isMember: boolean; isInvited: boolean; isHostOrAdmin: boolean },
): boolean {
  if (v.isHostOrAdmin) return true;
  switch (ev.visibility) {
    case "public": return true;
    case "members": return v.isMember;
    case "invite": return v.isInvited;
  }
}
