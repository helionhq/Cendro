import { ConvexError, v } from "convex/values";
import { internalQuery, type MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireCapability, requireMembership } from "./permissions";

/**
 * Actions have no `ctx.db`, so they authorize through these internal queries
 * before doing any HTTP work. The audit script follows these calls.
 */
function authResult(auth: Awaited<ReturnType<typeof requireCapability>>) {
  return { membershipId: auth.membership._id };
}

export const requireView = internalQuery({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => authResult(await requireCapability(ctx, args.companyId, "fleet:view")),
});

export const requireLog = internalQuery({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => authResult(await requireCapability(ctx, args.companyId, "fleet:log")),
});

export const requireManage = internalQuery({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => authResult(await requireCapability(ctx, args.companyId, "fleet:manage")),
});

/**
 * Fleet actions that change operational records (trip logging, alert review)
 * are open to loggers and managers. Kept here so every fleet module uses the
 * same rule instead of re-implementing the capability check.
 */
export async function requireFleetLogOrManage(ctx: MutationCtx, companyId: Id<"companies">) {
  const auth = await requireMembership(ctx, companyId);
  if (!auth.capabilities.has("fleet:log") && !auth.capabilities.has("fleet:manage")) {
    throw new ConvexError("You do not have access to do that.");
  }
  return auth;
}
