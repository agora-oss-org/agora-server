// Shared "what is this content" card used by both the report ReviewDialog and the AI-flag dialog, so
// flagged content renders identically however it surfaced. Shows the title, text, any media
// (entity images/files, comment gif), author, moderation status, and a deep link into the demo app.
import { ExternalLink, Paperclip } from "lucide-react";
import type { Comment, Entity, ReportTargetType } from "@agora-server/contract";
import { Badge } from "../../components/ui/Badge";
import { shortId } from "../../lib/time";

// Resolve a renderable image URL from an uploaded file record (medium variant → original).
// Mirrors agora-demo's fileImageSrc so the admin shows exactly what users see.
function fileImageSrc(file: any): string | null {
  if (!file || file.type !== "image") return null;
  const v = file.image?.variants ?? {};
  return v.medium?.publicPath || v.small?.publicPath || v.thumbnail?.publicPath || file.originalPath || null;
}

function gifSrc(gif: any): string | null {
  if (!gif) return null;
  if (typeof gif === "string") return gif;
  return gif.url || gif.gifUrl || gif.images?.original?.url || gif.media?.[0]?.gif?.url || null;
}

// Pull every reviewable attachment off the target: inline images, a gif (comments), and any
// non-image files (shown as openable links). Entities carry `files`; comments carry `gif`.
export function collectMedia(target: Entity | Comment | null): {
  images: string[];
  gif: string | null;
  files: { name: string; url: string }[];
} {
  const files = ((target as Entity | null)?.files ?? []) as any[];
  const images = files.map(fileImageSrc).filter((s): s is string => !!s);
  const other = files
    .filter((f) => f && f.type !== "image" && typeof f.originalPath === "string")
    .map((f) => ({ name: (f.originalPath as string).split("/").pop() || "attachment", url: f.originalPath as string }));
  return { images, gif: gifSrc((target as Comment | null)?.gif), files: other };
}

export function ContentPreview({
  targetType, target, isError, title, deepLink,
}: {
  targetType: ReportTargetType;
  target: Entity | Comment | null;
  isError: boolean;
  title: string;
  deepLink: string | null;
}) {
  const content = targetType === "entity" ? (target as Entity | null)?.content : (target as Comment | null)?.content;
  const author = (target as Entity | Comment | null)?.user;
  const status = (target as Entity | Comment | null)?.moderationStatus;
  const media = collectMedia(target);
  const hasMedia = media.images.length > 0 || media.files.length > 0 || !!media.gif;

  return (
    <div className="space-y-2 rounded-lg border border-border bg-bg p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-fg">{title}</p>
        {status ? (
          <Badge variant={status === "removed" ? "danger" : "success"}>{status}</Badge>
        ) : null}
      </div>
      {content ? (
        <p className="whitespace-pre-wrap break-words text-sm text-muted">{content}</p>
      ) : isError ? (
        <p className="text-sm text-muted">Couldn't load the content (it may have been deleted).</p>
      ) : !hasMedia ? (
        <p className="text-sm text-muted">(no text content)</p>
      ) : null}
      {hasMedia ? (
        <div className="space-y-2">
          {media.images.map((src, i) => (
            <img key={`img-${i}`} src={src} alt="" loading="lazy"
              className="max-h-80 w-auto max-w-full rounded-lg border border-border" />
          ))}
          {media.gif ? (
            <img src={media.gif} alt="" loading="lazy"
              className="max-h-80 w-auto max-w-full rounded-lg border border-border" />
          ) : null}
          {media.files.map((f, i) => (
            <a key={`file-${i}`} href={f.url} target="_blank" rel="noreferrer"
              className="flex items-center gap-1.5 text-sm text-primary hover:underline">
              <Paperclip className="size-3.5 shrink-0" /> {f.name}
            </a>
          ))}
        </div>
      ) : null}
      {author ? <p className="text-xs text-faint">by @{author.username ?? shortId(author.id)}</p> : null}
      {deepLink ? (
        <a href={deepLink} target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1.5 pt-1 text-sm font-medium text-primary hover:underline">
          <ExternalLink className="size-3.5 shrink-0" /> Open in app
        </a>
      ) : null}
    </div>
  );
}
