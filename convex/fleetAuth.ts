import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { requireCapability } from "./permissions";

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
