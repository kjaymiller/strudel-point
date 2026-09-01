// Wire contract for the in-room chatbot (see apps/gateway/src/chat/).
//
// The transcript is not stored server-side: the gateway runs one tool-using turn and
// forgets it. Every client already receives every `chat:message` event for its channel, so
// each browser holds the same transcript for free, and the client that typed sends its own
// view of it back as `history`. That keeps the bot as stateless as the rest of the gateway
// — any instance can serve any turn — at the cost of a bounded transcript on the wire.

/** The userId the gateway stamps on the bot's own events. Not a real socket, so never in presence. */
export const BOT_USER_ID = "bot";
export const BOT_USERNAME = "strudelbot";

/** How many prior turns a client should send. Enough for context, bounded so the request stays small. */
export const CHAT_HISTORY_LIMIT = 20;

export interface ChatTurn {
  role: "user" | "assistant";
  /** For a user turn, prefixed with the speaker's name server-side — the room is multi-user. */
  content: string;
  username?: string;
}

export interface ChatRequest {
  /** The message just typed. Sent separately from `history` so the gateway never has to guess. */
  message: string;
  username: string;
  /** Prior turns, oldest first, already trimmed to CHAT_HISTORY_LIMIT by the client. */
  history: ChatTurn[];
}

export interface ChatResponse {
  /** The bot's reply. Already broadcast as a `chat:message` event — returned for the caller's own error handling. */
  reply: string;
  /** Names of the tools the bot ran this turn, in order, so the UI can show what it touched. */
  toolsUsed: string[];
}

/** Which runtime is answering. Claude through the official SDK, or any chat-completions server. */
export type ChatProvider = "anthropic" | "openai-compatible";

/** GET /api/chat/status — lets the UI say why nobody's answering instead of failing on send. */
export interface ChatStatus {
  enabled: boolean;
  provider: ChatProvider;
  /** Empty when the provider has no model configured and none can be guessed for it. */
  model: string;
  /** Why it's off, in words an operator can act on. Only set when `enabled` is false. */
  reason?: string;
}
