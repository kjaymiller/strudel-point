import {
  BOT_USER_ID,
  BOT_USERNAME,
  type ChatRequest,
  type ChatResponse,
  type ChatStatus,
} from "@strudel-point/shared";
import { Router } from "express";
import { asyncHandler } from "../asyncHandler.js";
import { chatEnabled, chatStatus, runChatTurn } from "../chat/agent.js";
import { publishChannelEvent } from "../kafka.js";

export const chatRouter = Router();

/** Longest message the bot will accept. Generous for a chat line, small enough to bound a turn. */
const MAX_MESSAGE_CHARS = 4000;

// GET /api/chat/status -> ChatStatus
// Exists so the panel can render "no ANTHROPIC_API_KEY" (or "CHAT_BASE_URL is unset") as a
// state instead of as a failed send — the bot being unconfigured is a normal way to run this
// stack, whichever provider is selected.
chatRouter.get("/chat/status", (_req, res) => {
  const status: ChatStatus = chatStatus();
  res.json(status);
});

// POST /api/channels/:channelId/chat { message, username, history } -> ChatResponse
//
// The user's own message is *not* published here — the client already sent it over its
// socket as a chat:message event, the same way it sends every other event, so publishing it
// again would double it in every transcript. This endpoint only owns the bot's half.
chatRouter.post(
  "/channels/:channelId/chat",
  asyncHandler(async (req, res) => {
    if (!chatEnabled()) {
      return res.status(503).json({ error: "the chatbot is not configured on this gateway" });
    }
    const body = req.body as Partial<ChatRequest>;
    if (!body.message?.trim() || !body.username) {
      return res.status(400).json({ error: "message and username are required" });
    }
    if (body.message.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({ error: `message must be under ${MAX_MESSAGE_CHARS} characters` });
    }

    const { reply, toolsUsed } = await runChatTurn({
      channelId: req.params.channelId,
      username: body.username,
      message: body.message,
      history: Array.isArray(body.history) ? body.history : [],
    });

    // Kafka, not this response, is what puts the reply on everyone's screen — including the
    // asker's. The body below is for the caller's own error handling; the panel renders the
    // broadcast copy, so one client's reply can't arrive out of order with another's.
    await publishChannelEvent({
      type: "chat:message",
      channelId: req.params.channelId,
      userId: BOT_USER_ID,
      username: BOT_USERNAME,
      author: "bot",
      body: reply,
      toolsUsed,
      ts: Date.now(),
    });

    const response: ChatResponse = { reply, toolsUsed };
    res.json(response);
  }),
);
