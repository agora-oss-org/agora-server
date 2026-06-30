# Agora — Response Model Reference

Field-level shapes the API must return, transcribed from `@replyke/core/src/interfaces/models/`.
These double as the source of truth for the Postgres schema (`db/`). Dates serialize as ISO strings.

## Entity
`id, foreignId?, shortId, projectId, sourceId?, spaceId?, space?, userId?, user?, title?, content?,
mentions[], attachments[](jsonb), files?[], keywords[], upvotes[] (v6 legacy), downvotes[] (v6 legacy),
reactionCounts (v7), userReaction?, repliesCount, views, score, scoreUpdatedAt, location?(GeoJSON Point),
metadata(jsonb ≤10KB), topComment?, isSaved?, createdAt, updatedAt, deletedAt?, isDraft?,
moderationStatus(approved|removed|null), moderatedAt?, moderatedById?, moderatedByType(client|user), moderationReason?`
`include`: space | user | topComment | saved | files

## Comment
`id, projectId, foreignId?, entityId, entity?, userId, user?, parentId?, parentComment?, content?,
gif?(GifData), mentions[], upvotes[] (v6), downvotes[] (v6), reactionCounts, userReaction?, repliesCount,
metadata(jsonb), createdAt, updatedAt, deletedAt?, parentDeletedAt? (v6), userDeletedAt? (Reddit-style),
moderationStatus, moderatedAt?, moderatedById?, moderatedByType?, moderationReason?`
`include`: user | entity | space | parent

## User (public) / AuthUser / UserFull
UserFull: `id, projectId, foreignId?, role(admin|moderator|visitor), email?, name?, username?, avatar?,
avatarFileId?, bannerFileId?, avatarFile?, bannerFile?, bio?(≤300), birthdate?, location?(GeoJSON),
metadata(jsonb), secureMetadata(jsonb, never exposed in public), reputation, isVerified, isActive,
lastActive, createdAt, updatedAt`
- **User** (public) = UserFull minus `email, secureMetadata, isVerified, isActive, lastActive, updatedAt`
- **AuthUser** = UserFull minus `secureMetadata`, plus `suspensions[]{reason?, startDate, endDate?}`, `authMethods[]`
- **Session response** (sign-in, and sign-up with auto-confirm) = `{ user: AuthUser, accessToken, refreshToken }`
- **Sign-up with email confirmation enabled** returns `{ status: "confirmation_required", email }` (`200`,
  no tokens): the user is created and the confirmation email sent, but no session exists until they
  confirm via the emailed link and then sign in. The same shape is returned for an already-registered
  email (GoTrue obfuscates it) to avoid email enumeration. The profile row is created lazily on first
  successful sign-in.

## Reaction
`id, projectId, targetType(entity|comment), targetId, userId, reactionType, createdAt, updatedAt, user?`
- ReactionType (8): `upvote(+1) downvote(-1) like(+1) love(+2) wow(+1) sad(0) angry(0) funny(+1)` (→ reputation)
- ReactionCounts: object with all 8 keys → number

## Space / SpaceDetailed
`id, projectId, shortId, slug?, name, description?, avatarFileId?, bannerFileId?, userId,
readingPermission(anyone|members), postingPermission(anyone|members|admins), requireJoinApproval,
readReceiptsEnabled(bool), parentSpaceId?, depth, metadata(jsonb), createdAt, updatedAt, deletedAt?,
membersCount, childSpacesCount, isMember?, avatarFile?, bannerFile?`
SpaceDetailed adds: `memberPermissions?, parentSpace?(SpacePreview), childSpaces[](SpacePreview)`

## SpaceMember
`id, projectId, spaceId, userId, role(admin|moderator|member), status(pending|active|banned|rejected),
joinedAt, createdAt`

## Rule
`id, projectId, spaceId, title, description?, order, lastApprovedBy?, createdAt, updatedAt`

## Conversation / ConversationPreview
`id, projectId, type(direct|group|space), name?, description?, spaceId?, createdById?, avatarFileId?,
lastMessageAt?, postingPermission(members|admins|null), metadata(jsonb), createdAt, updatedAt,
memberCount?, currentMember?, avatarFile?`
ConversationPreview adds: `unreadCount, lastMessage?` (its `content` truncated to ≤100 codepoints),
`otherMembers[]` (≤5 active non-self members as `{id, name, username, avatar}`; **empty for `space`
conversations**). Returned by `GET /chat/conversations` (list), `GET /chat/conversations/:id/preview`,
and the `conversation:created` socket event (zero-state: `unreadCount: 0`, `lastMessage: null`).
`otherMembers` is Agora-specific (additive; stock SDK ignores it) and is NOT attached to the base
`GET /chat/conversations/:id` detail. `currentMember` is present on the list + `/preview` but omitted
from the `conversation:created` payload (client refills on the next list fetch).

## ConversationMember
`id, projectId, conversationId, userId, role(admin|member|null), lastReadAt?, mutedUntil?, isActive,
leftAt?, createdAt, updatedAt, user?`

## ChatMessage
`id, localId?, projectId, conversationId, userId?, content?, gif?, mentions[], files?[], metadata(jsonb),
parentMessageId?, quotedMessageId?, threadReplyCount, reactionCounts(Record<string,number>),
userReactions[], editedAt?, userDeletedAt?, moderationStatus, moderatedAt?, moderatedById?,
moderatedByType?, moderationReason?, createdAt, updatedAt, user?, quotedMessage?, parentMessage?, sendFailed?`

## Follow
`id, projectId, followerId, followedId, createdAt`

## Connection (state machine)
Stored row implies: `id, projectId, requesterId, addresseeId, status(pending|connected|declined),
message?, createdAt, respondedAt?`. SDK status values: none | pending-sent | pending-received |
connected | declined-sent | declined-received. Connections pagination uses
`{ currentPage, totalPages, totalCount, hasNextPage, hasPreviousPage, limit }` (NOT the standard envelope).

## Collection
`id, projectId, userId, parentId?, name, entityCount, createdAt, updatedAt`
(+ a join table collection_entities: collectionId, entityId)

## File / Image
File: `id, projectId, userId?, entityId?, commentId?, chatMessageId?, spaceId?,
type(image|video|document|other), originalPath, originalSize, originalMimeType, position,
metadata(jsonb), image?(FileImage), createdAt, updatedAt`
FileImage: `fileId, originalWidth, originalHeight, variants(Record), processingStatus, processingError?,
format, quality, exifStripped, createdAt, updatedAt`

## Mention
Union: `{type:"user", id, foreignId?, username}` | `{type:"space", id, slug}`

## AppNotification
Base: `id, userId, type, isRead, metadata(jsonb), createdAt`. `type` is one of 17 (system,
entity-comment, comment-reply, entity-mention, comment-mention, entity-upvote, comment-upvote,
entity-reaction, comment-reaction, 4× reaction-milestone, new-follow, connection-request,
connection-accepted, space-membership-approved). Each type has an `action` + typed `metadata`
shape (see `AppNotification.ts`). Store generically: `type` + `action` + jsonb `metadata`.

## Project
`id, clientId, name, integrations[]{id, projectId, name, data(jsonb), createdAt}, createdAt, updatedAt`

## Event / EventRsvp / EventInvite
Event: `id, shortId, projectId, userId?, user?, title, description?, startTime, endTime?, timezone?,
type(online|physical|hybrid), url?, venueName?, address?, location?(GeoJSON Point), spaceId?, space?,
visibility(public|members|invite), status(active|cancelled), allowMaybe, guestListVisible, capacity?,
hostIds[], coverImageId?, files?[], rsvpCounts{going, maybe, not_going}, userRsvp?(going|maybe|not_going),
metadata(jsonb), createdAt, updatedAt, deletedAt?`
`include`: user | userRsvp (and space/files when populated)
EventRsvp: `id, eventId, userId, user?, status(going|maybe|not_going), createdAt, updatedAt`
EventInvite: `id, eventId, userId, user?, invitedAt, createdAt, updatedAt`
