// The mention-token shape stored in the `mentions[]` jsonb on Entity/Comment/ChatMessage,
// 1:1 with the SDK's interfaces/models/Mention.ts. See docs/MODELS.md §Mention.
export type UserMention = { type: "user"; id: string; foreignId?: string; username: string };
export type SpaceMention = { type: "space"; id: string; slug: string };
export type Mention = UserMention | SpaceMention;
