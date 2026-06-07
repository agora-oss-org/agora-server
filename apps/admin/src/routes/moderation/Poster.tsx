// Poster display: name (@username → name → "—") + the user's reputation. Shared by the moderation
// grids and the review dialog headers so the poster's standing shows everywhere they're named.
import type { UserSummary } from "@agora-server/contract";
import { displayName } from "../../lib/moderation";

export function Poster({ user, bold }: { user: UserSummary | null | undefined; bold?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className={bold ? "font-medium text-fg" : undefined}>{displayName(user)}</span>
      {user ? <span className="text-xs text-faint" title="reputation">{user.reputation} rep</span> : null}
    </span>
  );
}
