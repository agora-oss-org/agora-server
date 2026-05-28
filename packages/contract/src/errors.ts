// Replyke error envelope shape: the JSON body returned on any API error.
// The ApiError class + Errors factory (and their HTTP-status coupling) stay server-side;
// this is just the wire shape clients can rely on. See docs/MANIFEST.md.
export interface ErrorEnvelope {
  error: string; // human-readable message
  code: string; // "feature/slug"
  field?: string; // offending field, when applicable
}
