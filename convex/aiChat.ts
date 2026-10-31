import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { query } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireMembership } from "./permissions";
import { nonEmpty } from "./validation";
import { createAiPersistencePayload, verifyAiPersistenceSignature } from "../src/lib/ai-chat-hmac";

function safeTitle(value: string) {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

const aiRateLimitConfigs = {
  "ai-chat": { limit: 20, windowMs: 60_000 },
  "ai-title": { limit: 10, windowMs: 60_000 },
} as const;

async function assertSession(ctx: QueryCtx | MutationCtx, companyId: Id<"companies">, sessionId: Id<"aiChatSessions">) {
  const { membership, user, company, capabilities: caps } = await requireMembership(ctx, companyId);
  if (!caps.has("ai:use")) throw new ConvexError("You do not have permission to use AI.");
  const session = await ctx.db.get(sessionId);
  if (!session || session.companyId !== companyId || session.membershipId !== membership._id) throw new ConvexError("Chat session not found.");
  return { session, membership, user, company, caps };
}

const DELETE_MESSAGE_BATCH_SIZE = 100;
const MESSAGE_HISTORY_LIMIT = 100;

async function deleteMessageBatch(ctx: MutationCtx, sessionId: Id<"aiChatSessions">) {
  const messages = await ctx.db.query("aiChatMessages").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).take(DELETE_MESSAGE_BATCH_SIZE);
  for (const message of messages) await ctx.db.delete(message._id);
  return messages.length === DELETE_MESSAGE_BATCH_SIZE;
}

export const consumeRateLimit = mutation({
  args: { kind: v.union(v.literal("ai-chat"), v.literal("ai-title")) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Authentication required.");

    const now = Date.now();
    const expired = await ctx.db.query("aiRateLimits").withIndex("by_resetAt", (q) => q.lt("resetAt", now)).take(20);
    for (const bucket of expired) await ctx.db.delete(bucket._id);

    const config = aiRateLimitConfigs[args.kind];
    const key = `${args.kind}:${identity.tokenIdentifier}`;
    const bucket = await ctx.db.query("aiRateLimits").withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (!bucket) {
      await ctx.db.insert("aiRateLimits", { key, count: 1, resetAt: now + config.windowMs, updatedAt: now });
      return { ok: true as const };
    }
    if (bucket.resetAt <= now) {
      await ctx.db.patch(bucket._id, { count: 1, resetAt: now + config.windowMs, updatedAt: now });
      return { ok: true as const };
    }
    if (bucket.count >= config.limit) return { ok: false as const, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
    await ctx.db.patch(bucket._id, { count: bucket.count + 1, updatedAt: now });
    return { ok: true as const };
  },
});

export const listSessions = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership, capabilities: caps } = await requireMembership(ctx, args.companyId);
    if (!caps.has("ai:use")) return [];
    const rows = await ctx.db.query("aiChatSessions").withIndex("by_membership_and_updatedAt", (q) => q.eq("membershipId", membership._id)).order("desc").take(50);
    return rows
      .filter((row) => row.companyId === args.companyId && row.hasMessages !== false)
      .map((row) => ({ _id: row._id, title: row.title, createdAt: row.createdAt, updatedAt: row.updatedAt }));
  },
});

export const createSession = mutation({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership, capabilities: caps } = await requireMembership(ctx, args.companyId);
    if (!caps.has("ai:use")) throw new ConvexError("You do not have permission to use AI.");
    const now = Date.now();
    return await ctx.db.insert("aiChatSessions", { companyId: args.companyId, membershipId: membership._id, hasMessages: false, createdAt: now, updatedAt: now });
  },
});

export const getSession = query({
  args: { companyId: v.id("companies"), sessionId: v.id("aiChatSessions") },
  handler: async (ctx, args) => {
    const { session } = await assertSession(ctx, args.companyId, args.sessionId);
    return { _id: session._id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt };
  },
});

export const getOrCreateSession = mutation({
  args: { companyId: v.id("companies"), sessionId: v.optional(v.id("aiChatSessions")) },
  handler: async (ctx, args) => {
    const { membership, capabilities: caps } = await requireMembership(ctx, args.companyId);
    if (!caps.has("ai:use")) throw new ConvexError("You do not have permission to use AI.");
    if (args.sessionId) {
      const existing = await ctx.db.get(args.sessionId);
      if (existing && existing.companyId === args.companyId && existing.membershipId === membership._id) return existing._id;
    }
    const now = Date.now();
    return await ctx.db.insert("aiChatSessions", { companyId: args.companyId, membershipId: membership._id, hasMessages: false, createdAt: now, updatedAt: now });
  },
});

export const authorizeSessionForAgent = query({
  args: { companyId: v.id("companies"), sessionId: v.id("aiChatSessions") },
  handler: async (ctx, args) => {
    const { membership, caps, company } = await assertSession(ctx, args.companyId, args.sessionId);
    return { membershipId: membership._id, role: membership.role, capabilities: Array.from(caps), timeZone: company.timeZone ?? null };
  },
});

export const listMessages = query({
  args: { companyId: v.id("companies"), sessionId: v.id("aiChatSessions") },
  handler: async (ctx, args) => {
    await assertSession(ctx, args.companyId, args.sessionId);
    const newestMessages = await ctx.db.query("aiChatMessages").withIndex("by_session", (q) => q.eq("sessionId", args.sessionId)).order("desc").take(MESSAGE_HISTORY_LIMIT);
    // Fetch the newest bounded window, then return it chronologically for display.
    return newestMessages.sort((a, b) => a.createdAt - b.createdAt);
  },
});

export const appendMessage = mutation({
  args: {
    companyId: v.id("companies"),
    sessionId: v.id("aiChatSessions"),
    role: v.literal("user"),
    content: v.string(),
    clientMessageId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { session } = await assertSession(ctx, args.companyId, args.sessionId);
    const content = nonEmpty(args.content, "Message");
    if (args.clientMessageId) {
      const existing = await ctx.db.query("aiChatMessages").withIndex("by_session_and_clientMessageId", (q) => q.eq("sessionId", args.sessionId).eq("clientMessageId", args.clientMessageId)).unique();
      if (existing) return existing._id;
    }
    const now = Date.now();
    const id = await ctx.db.insert("aiChatMessages", { sessionId: args.sessionId, role: "user", content, clientMessageId: args.clientMessageId, createdAt: now });
    await ctx.db.patch(session._id, { hasMessages: true, updatedAt: now });
    return id;
  },
});

export const persistServerMessage = mutation({
  args: {
    companyId: v.id("companies"),
    sessionId: v.id("aiChatSessions"),
    role: v.union(v.literal("assistant"), v.literal("tool")),
    content: v.string(),
    clientMessageId: v.optional(v.string()),
    timestamp: v.number(),
    requestId: v.string(),
    signature: v.string(),
  },
  handler: async (ctx, args) => {
    const secret = process.env.AI_CHAT_PERSISTENCE_SECRET;
    if (!secret) {
      throw new ConvexError("AI persistence secret is not configured.");
    }
    const now = Date.now();
    if (Math.abs(now - args.timestamp) > 5 * 60 * 1000) {
      throw new ConvexError("Persistence request expired.");
    }

    const existingReq = await ctx.db
      .query("aiChatPersistenceRequests")
      .withIndex("by_requestId", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (existingReq) {
      throw new ConvexError("Replay detected: request ID already used.");
    }

    const payload = createAiPersistencePayload({
      companyId: args.companyId,
      sessionId: args.sessionId,
      role: args.role,
      timestamp: args.timestamp,
      requestId: args.requestId,
      content: args.content,
    });
    const isValid = await verifyAiPersistenceSignature(secret, payload, args.signature);
    if (!isValid) {
      throw new ConvexError("Invalid persistence signature.");
    }

    await ctx.db.insert("aiChatPersistenceRequests", {
      requestId: args.requestId,
      createdAt: now,
    });

    const { session } = await assertSession(ctx, args.companyId, args.sessionId);

    if (args.clientMessageId) {
      const existing = await ctx.db
        .query("aiChatMessages")
        .withIndex("by_session_and_clientMessageId", (q) =>
          q.eq("sessionId", args.sessionId).eq("clientMessageId", args.clientMessageId)
        )
        .unique();
      if (existing) return existing._id;
    }

    const id = await ctx.db.insert("aiChatMessages", {
      sessionId: args.sessionId,
      role: args.role,
      content: args.content,
      clientMessageId: args.clientMessageId,
      createdAt: now,
    });
    await ctx.db.patch(session._id, { hasMessages: true, updatedAt: now });
    return id;
  },
});

export const setSessionTitle = mutation({
  args: { companyId: v.id("companies"), sessionId: v.id("aiChatSessions"), title: v.string() },
  handler: async (ctx, args) => {
    await assertSession(ctx, args.companyId, args.sessionId);
    const title = safeTitle(args.title);
    if (!title) throw new ConvexError("Title is required.");
    await ctx.db.patch(args.sessionId, { title, updatedAt: Date.now() });
    return title;
  },
});

export const deleteSession = mutation({
  args: { companyId: v.id("companies"), sessionId: v.id("aiChatSessions") },
  handler: async (ctx, args) => {
    await assertSession(ctx, args.companyId, args.sessionId);
    const shouldContinue = await deleteMessageBatch(ctx, args.sessionId);
    if (shouldContinue) {
      await ctx.scheduler.runAfter(0, internal.aiChat.deleteSessionMessages, { sessionId: args.sessionId });
      return null;
    }
    await ctx.db.delete(args.sessionId);
    return null;
  },
});

export const deleteSessionMessages = internalMutation({
  args: { sessionId: v.id("aiChatSessions") },
  handler: async (ctx, args) => {
    const shouldContinue = await deleteMessageBatch(ctx, args.sessionId);
    if (shouldContinue) {
      await ctx.scheduler.runAfter(0, internal.aiChat.deleteSessionMessages, { sessionId: args.sessionId });
      return null;
    }
    const session = await ctx.db.get(args.sessionId);
    if (session) await ctx.db.delete(args.sessionId);
    return null;
  },
});

