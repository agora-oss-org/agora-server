import { TriangleAlert } from "lucide-react";

// Shown at the top of a settings form while it has unsaved edits, warning the operator to save before
// leaving (a banner warns; it can't block navigation). Purely informational — the operator saves via
// the form's own "Save changes" button (deliberately not duplicated here, so a single banner can't
// imply it saves more than one section). Render it as the FIRST child INSIDE the <form>, and only when
// the form is actually dirty and not view-only.
export function UnsavedBanner() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-0 z-10 flex items-center gap-2 rounded-lg border border-warning/40 bg-elevated px-4 py-3 text-sm text-fg shadow-sm"
    >
      <TriangleAlert className="size-4 shrink-0 text-warning" />
      You have unsaved changes — save before navigating away.
    </div>
  );
}
