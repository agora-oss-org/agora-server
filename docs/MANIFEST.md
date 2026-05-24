# Agora — Build Manifest

> The concrete contract Agora's server must implement to be consumed **1:1** by the
> (forked) Replyke SDK. Extracted directly from `@replyke/core` source at
> `github.com/replyke/monorepo` (Apache-2.0), commit fetched 2026-05-22.
>
> Legend: **✅ SDK-confirmed** = method+path read straight from SDK call sites.
> **🔶 inferred** = path seen in SDK but method/shape assumed from REST convention or
> the RTK-Query layer; verify against the published OpenAPI spec at `/openapi/v7`.

---

## 0. The fork: where the base URL is hardcoded

The published SDK will **not** fully point at Agora via env var alone. Fork `@replyke/core`
(+ the framework packages) and repoint these:

| File | Constant | Change to |
|---|---|---|
| `config/axios.ts` | `export const BASE_URL = "https://api.replyke.com/v7"` | your host + `/v7` |
| `utils/env.ts` | `getApiBaseUrl()` fallback `'https://api.replyke.com/v7'` (×3) | your host |
| `hooks/search/useAskContent.ts` | hardcoded semantic-search URL | your host |
| `context/chat-context.tsx` | `getSocketUrl()` origin (derived from BASE_URL) | your socket host |
| OAuth sign-in hook (`react-js`) | hardcoded origin | your host |

Only the RTK-Query layer (`store/api/baseApi.ts`) already respects
`VITE_API_BASE_URL` / `REACT_APP_API_BASE_URL`.

---

## 1. Global contract (must match exactly)

**URL shape:** `https://YOUR_HOST/v7/:projectId/<endpoint>` — `projectId` is the first
path segment after `/v7`.

**Auth header:** `Authorization: Bearer <accessToken>`.
- access token TTL **30 min**, refresh token TTL **30 days**
- refresh-token **rotation with reuse detection**: each refresh revokes the old token &
  issues a new one; replaying a spent token revokes the whole token family; **30s grace**
  window for racing tabs
- external auth: verify an **RS256** JWT against a per-project public key — claims
  `sub`, `iss` (project id), `aud: "replyke.com"`, `userData` — then mint your own pair

**Pagination envelope** (offset-based, `?page=&limit=`):
```json
{ "data": [ ... ],
  "pagination": { "page": 1, "pageSize": 20, "totalPages": 5, "totalItems": 93, "hasMore": true } }
```
> ⚠️ Note: the **connections** module uses a *different* pagination shape
> (`{ currentPage, totalPages, totalCount, hasNextPage, hasPreviousPage, limit }`) — see §3.

**Error envelope:**
```json
{ "error": "Human readable message", "code": "feature/slug", "field": "optional" }
```
Status codes: `400 / 401 / 403 / 404 / 409 / 429 / 500`.

---

## 2. REST endpoint checklist (grouped by module)

`:projectId` prefix omitted below for brevity — every path is `/v7/:projectId/<path>`.

### auth
| Method | Path | Status |
|---|---|---|
| POST | `/auth/sign-up` | ✅ |
| POST | `/auth/sign-in` | ✅ |
| POST | `/auth/sign-out` | ✅ |
| POST | `/auth/request-new-access-token` | ✅ |
| POST | `/auth/change-password` | ✅ |
| POST | `/auth/request-password-reset` | ✅ |
| POST | `/auth/verify-email` | ✅ |
| POST | `/auth/send-verification-email` | ✅ |
| POST | `/auth/verify-external-user` (body `{ userJwt }`; legacy `{ token }` also accepted) | ✅ |

### oauth
Sign-in/link use Supabase as the OAuth broker (code + PKCE). `authorize`/`link` return
`{ authorizationUrl }`; the provider redirects the browser to `callback`, which exchanges the code,
mints Agora tokens, and 302-redirects to `redirectAfterAuth#accessToken=…&refreshToken=…` (or
`?error=…&error_description=…`). PKCE verifier is held in `oauth_states` between authorize→callback.
| Method | Path | Status |
|---|---|---|
| POST | `/oauth/authorize` (body `{ provider, redirectAfterAuth }` → `{ authorizationUrl }`) | ✅ |
| POST | `/oauth/link` (authed; same shape) | ✅ |
| GET | `/oauth/callback` (`?aid=&code=` or `?aid=&error=` → 302 redirect with tokens/error) | ✅ |
| GET | `/oauth/identities` | ✅ |
| DELETE | `/oauth/identities/:id` | ✅ |

### crypto (testing only)
Dev/quick-start only — the client sends its OWN external-auth private key (PKCS8) and the server
signs an RS256 JWT (issuer=projectId, aud="replyke.com", sub=userData.id, claim `userData`) that
`/auth/verify-external-user` then accepts. Returns a bare JWT string.
| Method | Path | Status |
|---|---|---|
| POST | `/crypto/sign-testing-jwt/v2` (body `{ privateKey, userData:{id,…} }` → JWT string) | ✅ |

### projects
| Method | Path | Status |
|---|---|---|
| GET | `/projects/lean` | ✅ |

### entities
| Method | Path | Status |
|---|---|---|
| GET | `/entities` (feed/list — accepts filters, see §5) | ✅ |
| POST | `/entities` | ✅ |
| GET | `/entities/:id` | ✅ |
| PATCH | `/entities/:id` | ✅ |
| DELETE | `/entities/:id` | ✅ |
| GET | `/entities/by-foreign-id` | ✅ |
| GET | `/entities/by-short-id` | ✅ |
| GET | `/entities/drafts` | ✅ |
| POST | `/entities/:id/publish` | ✅ |
| GET | `/entities/is-entity-saved` | ✅ |
| POST/DELETE | `/entities/:id/reactions` | ✅ |

### comments
| Method | Path | Status |
|---|---|---|
| GET | `/comments` (list; `entityId`, `parentId`, `sortBy` new/old/top, pagination) | ✅ |
| GET | `/comments/thread` (full nested subtree; `entityId`, `rootId?` → `{ data: Comment[] }` w/ `replies[]`) | ✅ |
| POST | `/comments` | ✅ |
| GET | `/comments/:id` (→ `{ comment }`; `include`=user,parent) | ✅ |
| PATCH | `/comments/:id` | ✅ |
| DELETE | `/comments/:id` | ✅ |
| GET | `/comments/by-foreign-id` (→ `{ comment }`) | ✅ |
| POST/DELETE | `/comments/:id/reactions` | ✅ |

### users
| Method | Path | Status |
|---|---|---|
| GET | `/users/:id` | ✅ |
| PATCH | `/users/:id` (update profile) | ✅ |
| GET | `/users/by-foreign-id` | ✅ |
| GET | `/users/by-username` | ✅ |
| GET | `/users/check-username` | ✅ |
| GET | `/users/suggestions` | ✅ |
| GET | `/users/:id/follow` (follow status) | ✅ |
| POST | `/users/:id/follow` | ✅ |
| DELETE | `/users/:id/follow` | ✅ |
| GET | `/users/:id/followers` | ✅ |
| GET | `/users/:id/following` | ✅ |
| GET | `/users/:id/followers-count` | ✅ |
| GET | `/users/:id/following-count` | ✅ |
| GET | `/users/:id/connections-count` | ✅ (also exposed at the `/v7` root `/users/:userId/connections-count` via the connections module) |

### follows
| Method | Path | Status |
|---|---|---|
| DELETE | `/follows/:id` | ✅ |
| GET | `/follows/followers` | ✅ |
| GET | `/follows/following` | ✅ |
| GET | `/follows/followers-count` | ✅ |
| GET | `/follows/following-count` | ✅ |

### connections (state machine: none → pending → connected/declined)
> ⚠️ Endpoints not fully visible in axios sweep (likely RTK-Query layer / different prefix).
> Confirm exact paths from OpenAPI. Response shapes are in `interfaces/models/Connection.ts`.
> Operations the SDK exposes: send request, accept, decline, withdraw, disconnect,
> list connections, list pending (received/sent), connection status, connection count.

### spaces
| Method | Path | Status |
|---|---|---|
| GET | `/spaces` (list, `?…`) | ✅ |
| POST | `/spaces` | ✅ |
| GET | `/spaces/:id` | ✅ |
| PATCH | `/spaces/:id` | ✅ |
| DELETE | `/spaces/:id` | ✅ |
| GET | `/spaces/by-short-id?shortId=` | ✅ |
| GET | `/spaces/by-slug?slug=` | ✅ |
| GET | `/spaces/check-slug?slug=` | ✅ |
| GET | `/spaces/user-spaces` | ✅ |
| GET | `/spaces/:id/breadcrumb` | ✅ |
| GET | `/spaces/:id/children?page=&limit=` | ✅ |
| POST | `/spaces/:id/join` | ✅ |
| DELETE | `/spaces/:id/leave` | ✅ |
| GET | `/spaces/:id/members?…` | ✅ |
| DELETE | `/spaces/:id/members/:id` | ✅ |
| PATCH | `/spaces/:id/members/:id/role` | ✅ |
| PATCH | `/spaces/:id/members/:id/approve` | ✅ |
| PATCH | `/spaces/:id/members/:id/decline` | ✅ |
| PATCH | `/spaces/:id/members/:id/unban` | ✅ |
| GET | `/spaces/:id/membership/me` | ✅ |
| GET | `/spaces/:id/team` | ✅ |
| GET/PATCH | `/spaces/:id/digest-config` | ✅ |
| GET | `/spaces/:id/rules` | ✅ |
| POST | `/spaces/:id/rules` | ✅ |
| GET | `/spaces/:id/rules/:id` | ✅ |
| PATCH | `/spaces/:id/rules/:id` | ✅ |
| DELETE | `/spaces/:id/rules/:id` | ✅ |
| PATCH | `/spaces/:id/rules/reorder` | ✅ |
| PATCH | `/spaces/:id/entities/:id/moderation` | ✅ |
| PATCH | `/spaces/:id/comments/:id/moderation` | ✅ |
| PATCH | `/spaces/:id/reports/entity/:id` | ✅ |
| PATCH | `/spaces/:id/reports/comment/:id` | ✅ |

### chat (REST side — realtime is §4)
| Method | Path | Status |
|---|---|---|
| GET | `/chat/conversations` | ✅ |
| POST | `/chat/conversations` | ✅ |
| POST | `/chat/conversations/direct` | ✅ |
| GET | `/chat/conversations/:id` | ✅ |
| PATCH | `/chat/conversations/:id` | ✅ |
| DELETE | `/chat/conversations/:id` | ✅ |
| DELETE | `/chat/conversations/:id/leave` | ✅ |
| POST | `/chat/conversations/:id/read` | ✅ |
| GET | `/chat/conversations/:id/members` | ✅ |
| POST | `/chat/conversations/:id/members` | ✅ |
| DELETE | `/chat/conversations/:id/members/:id` | ✅ |
| PATCH | `/chat/conversations/:id/members/:id/role` | ✅ |
| GET | `/chat/conversations/:id/messages` | ✅ |
| POST | `/chat/conversations/:id/messages` | ✅ |
| PATCH | `/chat/conversations/:id/messages/:id` | ✅ |
| DELETE | `/chat/conversations/:id/messages/:id` | ✅ |
| POST | `/chat/conversations/:id/messages/:id/reactions` | ✅ |
| POST | `/chat/conversations/:id/messages/:id/report` | ✅ |
| GET | `/chat/spaces/:id/conversation` | ✅ |

### collections
| Method | Path | Status |
|---|---|---|
| GET | `/collections/root` | ✅ |
| GET | `/collections/:id` | ✅ |
| GET/POST | `/collections/:id/sub-collections` | ✅ |
| GET/POST | `/collections/:id/entities` | ✅ |
| DELETE | `/collections/:id/entities/:id` | ✅ |

### app-notifications
| Method | Path | Status |
|---|---|---|
| GET | `/app-notifications` | ✅ |
| GET | `/app-notifications/count` | ✅ |
| PATCH | `/app-notifications/:id/mark-as-read` | ✅ |
| POST | `/app-notifications/mark-all-as-read` | ✅ |

### reports
| Method | Path | Status |
|---|---|---|
| POST | `/reports` | ✅ |
| GET | `/reports/moderated` | ✅ |

### search
All search endpoints are **POST** with a JSON body `{ query, limit?, ... }` and return a **bare
array** of `{ similarity, record }` results (NOT a `{ data, pagination }` envelope) — confirmed
against the SDK's `useSearchContent`/`useAskContent`/`useSearchSpaces`/`useSearchUsers`.
| Method | Path | Status |
|---|---|---|
| POST | `/search/content` (semantic across entity/comment/message; Voyage→`match_content` pgvector; honors `sourceTypes`) → `ContentSearchResult[]` | ✅ |
| POST | `/search/ask` (RAG; SSE stream `token`→`sources`→`done`/`error`) | ✅ |
| POST | `/search/spaces` (ILIKE) → `SpaceSearchResult[]` | ✅ |
| POST | `/search/users` (ILIKE) → `UserSearchResult[]` | ✅ |

### storage
| Method | Path | Status |
|---|---|---|
| POST | `/storage` | ✅ |
| POST | `/storage/images` (UploadImageOptions: mode exact-dimensions/aspect-ratio-width\|height/original-aspect/multi-aspect-ratio + format/quality/stripExif/fit/pathParts → `{ fileId, original, variants, metadata }`) | ✅ |

### utils
| Method | Path | Status |
|---|---|---|
| GET | `/utils/get-metadata` (URL/OG metadata fetch) | ✅ |

### webhooks (project-admin; server-side admin surface, not an SDK hook)
Replyke-style project webhooks: synchronous `validate` events (host may veto a write → 403) +
fire-and-forget `*.complete` broadcasts. HMAC `X-Signature`/`X-Timestamp` (+ `X-Response-Signature`
on validate replies). Covered events: entity/comment/space/message/user `.created`/`.updated` +
`notification.created`. Config below is admin-gated (profile role `admin`).
| Method | Path | Status |
|---|---|---|
| GET | `/webhooks/config` (→ `{ url, events, hasSecret }`; secret never returned) | ✅ |
| PATCH | `/webhooks/config` (set `url`/`secret`/`events`; cache-invalidated) | ✅ |
| POST | `/webhooks/test` (signed test ping → `{ configured, ok, status? }`) | ✅ |

---

## 3. Response object models (must match `@replyke/core` interfaces)

Every returned object must match the TS interfaces or the typed hooks break. Full field
lists captured in `docs/MODELS.md` (source: `interfaces/models/`):

`Entity`, `Comment` (+ `GifData`, `TopComment`), `User`/`AuthUser`/`UserFull`,
`Reaction` (+ `ReactionCounts`, 8 `ReactionType`s), `Space`/`SpaceDetailed`/`SpacePreview`,
`SpaceMember`, `Rule`, `Conversation`/`ConversationPreview`, `ConversationMember`,
`ChatMessage`, `Follow`, `Connection` (+ its many response shapes), `Collection`,
`File`/`FileImage`, `Image`, `Mention` (user|space), `Project`, and the 17-variant
`UnifiedAppNotification` union.

**Reaction types (8):** `upvote, downvote, like, love, wow, sad, angry, funny`.
**v6→v7 note:** `Entity`/`Comment` keep legacy `upvotes[]`/`downvotes[]` arrays AND the v7
`reactionCounts` object + `userReaction`. Reproduce both for compatibility.

---

## 4. 🔴 Socket.io realtime contract (the hard part)

**Not** raw WebSocket and **not** drop-in Supabase Realtime. You must run a **socket.io**
server speaking these exact event names.

**Connection** (`context/chat-context.tsx`):
```js
io(socketUrl, { auth: { token: accessToken }, query: { projectId }, autoConnect: true })
```
`socketUrl` = origin of the (forked) BASE_URL. Authenticate the socket from `auth.token`,
scope it by `query.projectId`.

**Server → Client events** (`types/socket.ts` — `ServerToClientEvents`):
| Event | Payload |
|---|---|
| `message:created` | `ChatMessage` |
| `message:updated` | `{ messageId, conversationId, content, gif, mentions, metadata, editedAt }` |
| `message:deleted` | `{ messageId, conversationId, userDeletedAt }` |
| `message:removed` | `{ messageId, conversationId }` (moderation) |
| `message:reaction` | `{ messageId, conversationId, emoji, userId, delta: 1\|-1, reactionCounts }` |
| `thread:reply_count` | `{ messageId, conversationId, threadReplyCount }` |
| `typing:start` | `{ userId, conversationId }` |
| `typing:stop` | `{ userId, conversationId }` |
| `member:joined` | `{ conversationId, member: ConversationMember }` |
| `member:left` | `{ conversationId, userId }` |
| `conversation:updated` | `Partial<Conversation> & { id }` |
| `conversation:deleted` | `{ conversationId }` |
| `connect` / `disconnect` | (built-in) |

**Client → Server events** (`ClientToServerEvents`):
| Event | Payload |
|---|---|
| `join:conversation` | `{ conversationId }` |
| `leave:conversation` | `{ conversationId }` |
| `typing:start` | `{ conversationId }` |
| `typing:stop` | `{ conversationId }` |

**Room semantics:** client emits `join:conversation` to subscribe; server fans out
message/typing/member events to that conversation room. Read state via REST
`POST /chat/conversations/:id/read`.

---

## 5. Entity feed filters (query params on `GET /entities`)

From `interfaces/entity-filters/`:
- **content**: `hasContent`, `includes`, `doesNotInclude`
- **title**: `hasTitle`, `includes`, `doesNotInclude`
- **keywords**: `includes[]`, `doesNotInclude[]`
- **attachments**: `hasAttachments`
- **metadata**: `includes`, `includesAny[]`, `doesNotInclude`, `exists[]`, `doesNotExist[]`
- **location**: `{ latitude, longitude, radius }` (GeoJSON Point on entity)
- plus sort (hot/top/new/controversial via `score`), `spaceId`, pagination, `include[]`
  (`space|user|topComment|saved|files`)

---

## 6. Difficulty ranking (honest)

| Layer | Difficulty | Why |
|---|---|---|
| REST CRUD (entities/comments/follows/collections/spaces) | 🟢 easy–med | straight from spec; Supabase handles data |
| Pagination / error envelopes | 🟢 easy | formatting conventions |
| Auth token rotation + RS256 external | 🟡 med | rotation/reuse/grace must be faithful |
| Feed ranking, vote tallies, notification fan-out | 🟡 med | real business logic (triggers + RPC) |
| Socket.io chat realtime | 🔴 hardest | stateful, event-exact, rooms + read state + typing |

**Recommendation:** build REST + auth + schema first; stub the chat module behind a flag
and add the socket.io server last.
