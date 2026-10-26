import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { analyticsScopedMembershipIds, memberFullName, requireMembership, scopedMembershipIds, taskHasVisibleAssignee } from "./permissions";
import { takeWithOverflow } from "./queryLimits";

const performancePeopleLimit = 20;

async function peopleRows(ctx: QueryCtx, companyId: Id<"companies">, ids: Set<Id<"companyMemberships">>, limit: number) {
  const out = [];
  for (const membershipId of Array.from(ids).slice(0, limit)) {
    const membership = await ctx.db.get(membershipId);
    if (!membership || membership.companyId !== companyId || !membership.active) continue;
    const user = await ctx.db.get(membership.userId);
    if (!user) continue;
    out.push({ membershipId: membership._id, name: memberFullName(membership, user), email: user.email, role: membership.role });
  }
  return out;
}

export const context = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership, company, capabilities } = await requireMembership(ctx, args.companyId);
    if (!capabilities.has("ai:use")) {
      throw new ConvexError("You do not have access to AI capabilities.");
    }
    let isTruncated = false;
    const scoped = await scopedMembershipIds(
      ctx,
      args.companyId,
      membership,
      capabilities,
      undefined,
      () => { isTruncated = true; },
    );
    const hasCompanyScope = capabilities.has("analytics:view:company") || capabilities.has("tasks:jd:view:any") || capabilities.has("tasks:one_time:view:any") || capabilities.has("sops:view:company");
    const hasManagedScope = capabilities.has("analytics:view:managed_scope") || capabilities.has("tasks:jd:view:managed") || capabilities.has("tasks:one_time:view:managed") || capabilities.has("sops:view:managed");
    const scope = hasCompanyScope ? "company" : hasManagedScope ? "managed" : "self";
    return {
      companyName: company.name,
      timeZone: company.timeZone ?? null,
      role: membership.role,
      capabilities: Array.from(capabilities),
      scope,
      visiblePeopleLimit: scoped.size,
      isTruncated,
      isComplete: !isTruncated,
      unsupportedActions: ["role-change", "permission-change", "company-settings", "member-management", "bulk-operations"],
    };
  },
});

export const performanceSummary = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    if (!capabilities.has("ai:use")) {
      throw new ConvexError("You do not have access to AI capabilities.");
    }
    let isTruncated = false;
    const scoped = await analyticsScopedMembershipIds(
      ctx,
      args.companyId,
      membership,
      capabilities,
      () => { isTruncated = true; },
    );
    const oneTimeResult = await takeWithOverflow(
      (limit) => ctx.db.query("oneTimeTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(limit),
    );
    if (oneTimeResult.isTruncated) isTruncated = true;
    const visibleOneTime = oneTimeResult.rows.filter((task) => taskHasVisibleAssignee(task, scoped));
    const completed = visibleOneTime.filter((task) => task.status === "completed").length;
    const overdue = visibleOneTime.filter((task) => task.status !== "completed" && (task.overdueAt || (task.status !== "awaiting_confirmation" && task.dueDate && task.dueDate < Date.now()))).length;
    const people = await peopleRows(ctx, args.companyId, scoped, performancePeopleLimit);
    const peopleTruncated = scoped.size > performancePeopleLimit;
    if (peopleTruncated) isTruncated = true;
    const byPerson = people.map((person) => {
      const assigned = visibleOneTime.filter((task) => task.assigneeMembershipIds.includes(person.membershipId));
      const personCompleted = assigned.filter((task) => task.status === "completed").length;
      const personOverdue = assigned.filter((task) => task.status !== "completed" && (task.overdueAt || (task.status !== "awaiting_confirmation" && task.dueDate && task.dueDate < Date.now()))).length;
      return { name: person.name, role: person.role, assignedOneTimeTasks: assigned.length, completedOneTimeTasks: personCompleted, overdueOneTimeTasks: personOverdue };
    });
    return {
      role: membership.role,
      scopeSize: scoped.size,
      oneTimeTaskCount: visibleOneTime.length,
      completedOneTimeTasks: completed,
      overdueOneTimeTasks: overdue,
      completionRate: visibleOneTime.length ? Math.round((completed / visibleOneTime.length) * 100) : 100,
      byPerson: byPerson.slice(0, performancePeopleLimit),
      isTruncated,
      isComplete: !isTruncated,
      limitations: { peopleTruncated },
    };
  },
});
