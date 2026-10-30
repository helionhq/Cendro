import { ConvexError, v } from "convex/values";
import { action, query, type QueryCtx } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  assertRoleManagerRemains,
  ensureDefaultRoles,
  memberFirstName,
  memberFullName,
  membershipCapabilities,
  requireCapability,
  requireMembership,
  roleDocByName,
  roleDocCapabilities,
  roleNameCapabilities,
} from "./permissions";
import { baselineInvitationCapabilities, companyManagementCapabilities, isKnownCapability, type Capability } from "../src/lib/permissions";
import { defaultTimeZone } from "./taskCycles";
import { nonEmpty, normalizeEmail } from "./validation";
import { takeWithOverflow } from "./queryLimits";

const overviewListLimit = 500;

function cleanTimeZone(value: string) {
  const timeZone = nonEmpty(value, "Time zone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    throw new ConvexError("Select a valid time zone.");
  }
}

async function assertBranch(ctx: any, companyId: Id<"companies">, branchId: Id<"branches">) {
  const branch = await ctx.db.get(branchId);
  if (!branch || branch.companyId !== companyId) throw new ConvexError("Branch not found.");
  return branch;
}
async function assertDepartment(ctx: any, companyId: Id<"companies">, departmentId: Id<"departments">) {
  const department = await ctx.db.get(departmentId);
  if (!department || department.companyId !== companyId) throw new ConvexError("Department not found.");
  return department;
}
async function assertMembership(ctx: any, companyId: Id<"companies">, membershipId: Id<"companyMemberships">) {
  const membership = await ctx.db.get(membershipId);
  if (!membership || membership.companyId !== companyId) throw new ConvexError("User not found in this company.");
  return membership;
}
function unique<T>(items: T[]) { return Array.from(new Set(items)); }
function assertSameIdSet<T>(actual: T[], expected: T[], message: string) {
  if (new Set(actual).size !== actual.length || actual.length !== expected.length) throw new ConvexError(message);
  const expectedSet = new Set(expected);
  if (actual.some((id) => !expectedSet.has(id))) throw new ConvexError(message);
}

async function managerScope(
  ctx: QueryCtx,
  managerMembershipId: Id<"companyMemberships">,
  onTruncated?: () => void,
) {
  const [branches, departments, users] = await Promise.all([
    takeWithOverflow((limit) => ctx.db.query("managerBranchScopes").withIndex("by_managerMembershipId_and_branchId", (q) => q.eq("managerMembershipId", managerMembershipId)).take(limit), overviewListLimit),
    takeWithOverflow((limit) => ctx.db.query("managerDepartmentScopes").withIndex("by_managerMembershipId_and_departmentId", (q) => q.eq("managerMembershipId", managerMembershipId)).take(limit), overviewListLimit),
    takeWithOverflow((limit) => ctx.db.query("managerUserScopes").withIndex("by_managerMembershipId_and_userMembershipId", (q) => q.eq("managerMembershipId", managerMembershipId)).take(limit), overviewListLimit),
  ]);
  if (branches.isTruncated || departments.isTruncated || users.isTruncated) onTruncated?.();
  return {
    branchIds: branches.rows.map((row) => row.branchId),
    departmentIds: departments.rows.map((row) => row.departmentId),
    userMembershipIds: users.rows.map((row) => row.userMembershipId),
  };
}

async function clearUserManagementRows(ctx: any, membershipId: Id<"companyMemberships">) {
  while (true) {
    const rows = await ctx.db.query("userBranchAssignments").withIndex("by_membershipId_and_branchId", (q: any) => q.eq("membershipId", membershipId)).take(500);
    if (!rows.length) break;
    for (const row of rows) await ctx.db.delete(row._id);
  }
  while (true) {
    const rows = await ctx.db.query("userDepartmentAssignments").withIndex("by_membershipId_and_departmentId", (q: any) => q.eq("membershipId", membershipId)).take(500);
    if (!rows.length) break;
    for (const row of rows) await ctx.db.delete(row._id);
  }
  while (true) {
    const rows = await ctx.db.query("managerBranchScopes").withIndex("by_managerMembershipId_and_branchId", (q: any) => q.eq("managerMembershipId", membershipId)).take(500);
    if (!rows.length) break;
    for (const row of rows) await ctx.db.delete(row._id);
  }
  while (true) {
    const rows = await ctx.db.query("managerDepartmentScopes").withIndex("by_managerMembershipId_and_departmentId", (q: any) => q.eq("managerMembershipId", membershipId)).take(500);
    if (!rows.length) break;
    for (const row of rows) await ctx.db.delete(row._id);
  }
  while (true) {
    const rows = await ctx.db.query("managerUserScopes").withIndex("by_managerMembershipId_and_userMembershipId", (q: any) => q.eq("managerMembershipId", membershipId)).take(500);
    if (!rows.length) break;
    for (const row of rows) await ctx.db.delete(row._id);
  }
  while (true) {
    const rows = await ctx.db.query("managerUserScopes").withIndex("by_user", (q: any) => q.eq("userMembershipId", membershipId)).take(500);
    if (!rows.length) break;
    for (const row of rows) await ctx.db.delete(row._id);
  }
}

export const overview = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership, company, capabilities: caps } = await requireMembership(ctx, args.companyId);
    if (!companyManagementCapabilities.some((capability) => caps.has(capability))) throw new ConvexError("You do not have access to do that.");
    if (company.deletedAt) throw new ConvexError("Company not found.");

    const canReadStructure = caps.has("company:manage_branches") || caps.has("company:manage_departments") || caps.has("company:manage_users") || caps.has("company:invite_users") || caps.has("company:manage_roles");
    const canReadUsers = caps.has("company:manage_users") || caps.has("company:manage_roles");
    const canReadInvitations = caps.has("company:invite_users") || caps.has("company:manage_roles");
    const canReadRoles = caps.has("company:manage_roles");
    const skipped = { rows: [], isTruncated: false };
    const [branchResult, departmentResult, membershipResult, invitationResult, roleResult] = await Promise.all([
      canReadStructure
        ? takeWithOverflow((limit) => ctx.db.query("branches").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(limit), overviewListLimit)
        : skipped,
      canReadStructure
        ? takeWithOverflow((limit) => ctx.db.query("departments").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(limit), overviewListLimit)
        : skipped,
      canReadUsers
        ? takeWithOverflow((limit) => ctx.db.query("companyMemberships").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(limit), overviewListLimit)
        : skipped,
      canReadInvitations
        ? takeWithOverflow((limit) => ctx.db.query("invitations").withIndex("by_companyId_and_status_and_targetMembershipId", (q) => q.eq("companyId", args.companyId).eq("status", "pending")).order("desc").take(limit), 100)
        : skipped,
      canReadStructure
        ? takeWithOverflow((limit) => ctx.db.query("roles").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(limit), overviewListLimit)
        : skipped,
    ]);
    const branches = branchResult.rows.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt);
    const departments = departmentResult.rows.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt);
    let userDetailsTruncated = false;
    const users = (
      await Promise.all(
        membershipResult.rows.map(async (m) => {
          const [user, branchAssignmentResult, departmentAssignmentResult, scope] = await Promise.all([
            ctx.db.get(m.userId),
            takeWithOverflow(
              (limit) => ctx.db.query("userBranchAssignments").withIndex("by_membershipId_and_branchId", (q) => q.eq("membershipId", m._id)).take(limit),
              overviewListLimit,
            ),
            takeWithOverflow(
              (limit) => ctx.db.query("userDepartmentAssignments").withIndex("by_membershipId_and_departmentId", (q) => q.eq("membershipId", m._id)).take(limit),
              overviewListLimit,
            ),
            canReadRoles
              ? managerScope(ctx, m._id, () => { userDetailsTruncated = true; })
              : { branchIds: [], departmentIds: [], userMembershipIds: [] },
          ]);
          if (branchAssignmentResult.isTruncated || departmentAssignmentResult.isTruncated) {
            userDetailsTruncated = true;
          }
          if (!user) return null;
          const memFirstName = memberFirstName(m, user);
          const memSecondName = m.secondName !== undefined ? m.secondName.trim() : (user.secondName?.trim() ?? "");
          const memFullName = memberFullName(m, user);
          return {
            membership: { _id: m._id, role: m.role, active: m.active, createdAt: m.createdAt },
            user: { _id: user._id, name: memFullName, firstName: memFirstName, secondName: memSecondName, email: user.email },
            branchIds: branchAssignmentResult.rows.map((assignment) => assignment.branchId),
            departmentIds: departmentAssignmentResult.rows.map((assignment) => assignment.departmentId),
            scope,
          };
        }),
      )
    ).filter((row) => row !== null);
    const memberCountByRole = new Map<string, number>();
    for (const m of membershipResult.rows) {
      memberCountByRole.set(m.role, (memberCountByRole.get(m.role) ?? 0) + 1);
    }
    const roleDocs = roleResult.rows;
    roleDocs.sort((a, b) => a.name.localeCompare(b.name));
    // Inside the (companyId, "pending") range the index orders by targetMembershipId,
    // so targeted invites would surface first; re-sort to keep newest-first.
    invitationResult.rows.sort((a, b) => b.createdAt - a.createdAt || b._creationTime - a._creationTime);
    const truncated = {
      branches: branchResult.isTruncated,
      departments: departmentResult.isTruncated,
      users: membershipResult.isTruncated,
      invitations: invitationResult.isTruncated,
      userDetails: userDetailsTruncated,
    };
    const isTruncated = Object.values(truncated).some(Boolean);
    return {
      isTruncated,
      truncated,
      company: { _id: company._id, name: company.name, timeZone: company.timeZone ?? defaultTimeZone, hasTimeZone: Boolean(company.timeZone) },
      currentMembership: { _id: membership._id, role: membership.role, active: membership.active, createdAt: membership.createdAt },
      branches: branches.map((b) => ({ _id: b._id, name: b.name, order: b.order })),
      departments: departments.map((d) => ({ _id: d._id, branchId: d.branchId, name: d.name, order: d.order })),
      users,
      roles: roleDocs.map((role) => ({
        _id: role._id,
        name: role.name,
        capabilities: canReadRoles ? role.capabilities.filter(isKnownCapability) : [],
        memberCount: memberCountByRole.get(role.name) ?? 0,
      })),
      invitations: invitationResult.rows.map((i) => ({ _id: i._id, email: i.email, role: i.role, status: i.status, createdAt: i.createdAt, expiresAt: i.expiresAt, branchIds: i.branchIds ?? [], departmentIds: i.departmentIds ?? [], managedBranchIds: canReadRoles ? i.managedBranchIds ?? [] : [], managedDepartmentIds: canReadRoles ? i.managedDepartmentIds ?? [] : [], managedUserMembershipIds: canReadRoles ? i.managedUserMembershipIds ?? [] : [] })),
    };
  },
});

export const updateCompanyName = mutation({
  args: { companyId: v.id("companies"), name: v.string() },
  handler: async (ctx, args) => {
    const { user } = await requireCapability(ctx, args.companyId, "company:manage_settings");
    const company = await ctx.db.get(args.companyId);
    if (!company || company.deletedAt) throw new ConvexError("Company not found.");
    const name = nonEmpty(args.name, "Company name");
    await ctx.db.patch(args.companyId, { name });
    await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "company.update", targetType: "company", targetId: args.companyId, createdAt: Date.now() });
  },
});

export const updateCompanyTimeZone = mutation({
  args: { companyId: v.id("companies"), timeZone: v.string() },
  handler: async (ctx, args) => {
    const { user } = await requireCapability(ctx, args.companyId, "company:manage_settings");
    const company = await ctx.db.get(args.companyId);
    if (!company || company.deletedAt) throw new ConvexError("Company not found.");
    const timeZone = cleanTimeZone(args.timeZone);
    await ctx.db.patch(args.companyId, { timeZone });
    await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "company.time_zone_update", targetType: "company", targetId: args.companyId, createdAt: Date.now() });
  },
});

export const createBranch = mutation({ args: { companyId: v.id("companies"), name: v.string() }, handler: async (ctx, args) => { const { user } = await requireCapability(ctx, args.companyId, "company:manage_branches"); const now = Date.now(); const count = (await ctx.db.query("branches").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500)).length; const id = await ctx.db.insert("branches", { companyId: args.companyId, name: nonEmpty(args.name, "Branch name"), order: count, createdAt: now, updatedAt: now }); await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "branch.create", targetType: "branch", targetId: id, createdAt: now }); return id; } });
export const deleteBranch = mutation({ args: { companyId: v.id("companies"), branchId: v.id("branches") }, handler: async (ctx, args) => { const { user } = await requireCapability(ctx, args.companyId, "company:manage_branches"); await assertBranch(ctx, args.companyId, args.branchId); const deps = await ctx.db.query("departments").withIndex("by_branch", (q) => q.eq("branchId", args.branchId)).take(1); if (deps.length) throw new ConvexError("Delete departments under this branch first."); const assignments = await ctx.db.query("userBranchAssignments").withIndex("by_branch", (q) => q.eq("branchId", args.branchId)).take(1); if (assignments.length) throw new ConvexError("Remove user branch assignments before deleting this branch."); const scopes = await ctx.db.query("managerBranchScopes").withIndex("by_branch", (q) => q.eq("branchId", args.branchId)).take(1); if (scopes.length) throw new ConvexError("Remove managed scopes before deleting this branch."); const sopScopes = await ctx.db.query("sopBranchScopes").withIndex("by_branch", (q) => q.eq("branchId", args.branchId)).take(1); if (sopScopes.length) throw new ConvexError("Remove SOP scopes before deleting this branch."); await ctx.db.delete(args.branchId); await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "branch.delete", targetType: "branch", targetId: args.branchId, createdAt: Date.now() }); } });
export const createDepartment = mutation({ args: { companyId: v.id("companies"), branchId: v.id("branches"), name: v.string() }, handler: async (ctx, args) => { const { user } = await requireCapability(ctx, args.companyId, "company:manage_departments"); await assertBranch(ctx, args.companyId, args.branchId); const now = Date.now(); const count = (await ctx.db.query("departments").withIndex("by_branch", (q) => q.eq("branchId", args.branchId)).take(500)).length; const id = await ctx.db.insert("departments", { companyId: args.companyId, branchId: args.branchId, name: nonEmpty(args.name, "Department name"), order: count, createdAt: now, updatedAt: now }); await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "department.create", targetType: "department", targetId: id, createdAt: now }); return id; } });
export const deleteDepartment = mutation({ args: { companyId: v.id("companies"), departmentId: v.id("departments") }, handler: async (ctx, args) => { const { user } = await requireCapability(ctx, args.companyId, "company:manage_departments"); await assertDepartment(ctx, args.companyId, args.departmentId); const assignments = await ctx.db.query("userDepartmentAssignments").withIndex("by_department", (q) => q.eq("departmentId", args.departmentId)).take(1); if (assignments.length) throw new ConvexError("Remove user department assignments before deleting this department."); const scopes = await ctx.db.query("managerDepartmentScopes").withIndex("by_department", (q) => q.eq("departmentId", args.departmentId)).take(1); if (scopes.length) throw new ConvexError("Remove managed scopes before deleting this department."); const sopScopes = await ctx.db.query("sopDepartmentScopes").withIndex("by_department", (q) => q.eq("departmentId", args.departmentId)).take(1); if (sopScopes.length) throw new ConvexError("Remove SOP scopes before deleting this department."); await ctx.db.delete(args.departmentId); await ctx.db.insert("auditEvents", { companyId: args.companyId, actorUserId: user._id, action: "department.delete", targetType: "department", targetId: args.departmentId, createdAt: Date.now() }); } });

export const reorderBranches = mutation({
  args: { companyId: v.id("companies"), orderedBranchIds: v.array(v.id("branches")) },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "company:manage_branches");
    const currentBranches = await ctx.db.query("branches").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500);
    assertSameIdSet(args.orderedBranchIds, currentBranches.map((branch) => branch._id), "Branch order is stale. Refresh and try again.");

    const branchesById = new Map(currentBranches.map((branch) => [branch._id, branch]));
    const now = Date.now();
    for (let i = 0; i < args.orderedBranchIds.length; i++) {
      const branch = branchesById.get(args.orderedBranchIds[i]);
      if (!branch) throw new ConvexError("Branch order is stale. Refresh and try again.");
      await ctx.db.patch(branch._id, { order: i, updatedAt: now });
    }
  },
});

export const moveDepartment = mutation({
  args: { companyId: v.id("companies"), departmentId: v.id("departments"), toBranchId: v.id("branches"), orderedDepartmentIds: v.array(v.id("departments")) },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "company:manage_departments");
    const department = await assertDepartment(ctx, args.companyId, args.departmentId);
    await assertBranch(ctx, args.companyId, args.toBranchId);

    const currentDestinationDepartments = await ctx.db.query("departments").withIndex("by_branch", (q) => q.eq("branchId", args.toBranchId)).take(500);
    const currentDestinationIds = currentDestinationDepartments.map((dep) => dep._id);
    const expectedDestinationIds = currentDestinationIds.includes(department._id) ? currentDestinationIds : [...currentDestinationIds, department._id];
    assertSameIdSet(args.orderedDepartmentIds, expectedDestinationIds, "Department order is stale. Refresh and try again.");

    const orderedDepartments: Doc<"departments">[] = [];
    for (const departmentId of args.orderedDepartmentIds) {
      const dep = await assertDepartment(ctx, args.companyId, departmentId);
      if (dep._id !== department._id && dep.branchId !== args.toBranchId) throw new ConvexError("Department order is stale. Refresh and try again.");
      orderedDepartments.push(dep);
    }

    const now = Date.now();
    for (let i = 0; i < orderedDepartments.length; i++) {
      await ctx.db.patch(orderedDepartments[i]._id, { branchId: args.toBranchId, order: i, updatedAt: now });
    }

    if (department.branchId !== args.toBranchId) {
      const sourceDepartments = (await ctx.db.query("departments").withIndex("by_branch", (q) => q.eq("branchId", department.branchId)).take(500)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt);
      for (let i = 0; i < sourceDepartments.length; i++) await ctx.db.patch(sourceDepartments[i]._id, { order: i, updatedAt: now });
    }
  },
});
export const setUserActive = mutation({
  args: { companyId: v.id("companies"), membershipId: v.id("companyMemberships"), active: v.boolean() },
  handler: async (ctx, args) => {
    const { user, capabilities: actorCaps } = await requireCapability(ctx, args.companyId, "company:manage_users");
    const membership = await assertMembership(ctx, args.companyId, args.membershipId);
    if (membership.active === args.active) return null;
    const now = Date.now();
    if (!args.active) {
      const targetCaps = await membershipCapabilities(ctx, membership);
      if (targetCaps.has("company:manage_roles") && !actorCaps.has("company:manage_roles")) {
        throw new ConvexError("You do not have access to deactivate a role administrator.");
      }
      await assertRoleManagerRemains(ctx, args.companyId, { activeChanges: new Map([[args.membershipId, false]]) });
      await clearUserManagementRows(ctx, args.membershipId);
      // Targeted pending invitations are queried per membership: scanning the
      // company's first N pending rows could miss invites aimed at this member.
      const pendingTargeted = await ctx.db
        .query("invitations")
        .withIndex("by_companyId_and_status_and_targetMembershipId", (q) => q.eq("companyId", args.companyId).eq("status", "pending").eq("targetMembershipId", args.membershipId))
        .take(500);
      for (const invite of pendingTargeted) {
        await ctx.db.patch(invite._id, { status: "revoked" });
      }
      await ctx.db.patch(args.membershipId, { active: false, updatedAt: now });
      await ctx.db.insert("auditEvents", {
        companyId: args.companyId,
        actorUserId: user._id,
        action: "member.deactivate",
        targetType: "membership",
        targetId: args.membershipId,
        createdAt: now,
      });
    } else {
      const targetCaps = await membershipCapabilities(ctx, membership);
      if (targetCaps.has("company:manage_roles") && !actorCaps.has("company:manage_roles")) {
        throw new ConvexError("You do not have access to activate a role administrator.");
      }
      await ctx.db.patch(args.membershipId, { active: true, updatedAt: now });
      await ctx.db.insert("auditEvents", {
        companyId: args.companyId,
        actorUserId: user._id,
        action: "member.activate",
        targetType: "membership",
        targetId: args.membershipId,
        createdAt: now,
      });
    }
    return null;
  },
});

export const removeUsers = mutation({
  args: { companyId: v.id("companies"), membershipIds: v.array(v.id("companyMemberships")) },
  handler: async (ctx, args) => {
    const { user, capabilities: actorCaps } = await requireCapability(ctx, args.companyId, "company:manage_users");
    const membershipIds = unique(args.membershipIds);
    // Targets often share a role, so resolve each role doc at most once.
    const roleCapsCache = new Map<string, Promise<Set<Capability>>>();
    const targetCapsList = await Promise.all(
      membershipIds.map(async (membershipId) => {
        const membership = await assertMembership(ctx, args.companyId, membershipId);
        return roleNameCapabilities(ctx, args.companyId, membership.role, roleCapsCache);
      }),
    );
    for (const targetCaps of targetCapsList) {
      if (targetCaps.has("company:manage_roles") && !actorCaps.has("company:manage_roles")) {
        throw new ConvexError("You do not have access to remove a role administrator.");
      }
    }
    await assertRoleManagerRemains(ctx, args.companyId, { activeChanges: new Map(membershipIds.map((membershipId) => [membershipId, false])) });
    // Targeted pending invitations are queried per membership: scanning the
    // company's first N pending rows could miss invites aimed at a target.
    const pendingLists = await Promise.all(
      membershipIds.map((membershipId) =>
        ctx.db
          .query("invitations")
          .withIndex("by_companyId_and_status_and_targetMembershipId", (q) => q.eq("companyId", args.companyId).eq("status", "pending").eq("targetMembershipId", membershipId))
          .take(500),
      ),
    );
    const pendingByTarget = new Map(membershipIds.map((membershipId, index) => [membershipId, pendingLists[index]]));
    const now = Date.now();
    for (const membershipId of membershipIds) {
      await clearUserManagementRows(ctx, membershipId);
      for (const invite of pendingByTarget.get(membershipId) ?? []) {
        await ctx.db.patch(invite._id, { status: "revoked" });
      }
      await ctx.db.patch(membershipId, { active: false, updatedAt: now });
      await ctx.db.insert("auditEvents", {
        companyId: args.companyId,
        actorUserId: user._id,
        action: "member.deactivate",
        targetType: "membership",
        targetId: membershipId,
        createdAt: now,
      });
    }
    return null;
  },
});

export const updateMemberName = mutation({
  args: {
    companyId: v.id("companies"),
    userId: v.id("appUsers"),
    firstName: v.string(),
    secondName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user: actor } = await requireCapability(ctx, args.companyId, "company:manage_users");
    const targetUser = await ctx.db.get(args.userId);
    if (!targetUser) throw new ConvexError("User not found.");

    const membership = await ctx.db
      .query("companyMemberships")
      .withIndex("by_company_user", (q) => q.eq("companyId", args.companyId).eq("userId", args.userId))
      .unique();
    if (!membership) throw new ConvexError("User not found in this company.");

    const firstName = args.firstName.trim();
    const secondName = args.secondName !== undefined ? args.secondName.trim() : undefined;
    if (!firstName) throw new ConvexError("First name is required.");

    await ctx.db.patch(membership._id, {
      firstName,
      secondName,
      updatedAt: Date.now(),
    });

    await ctx.db.insert("auditEvents", {
      companyId: args.companyId,
      actorUserId: actor._id,
      action: "user.update_name",
      targetType: "user",
      targetId: targetUser._id,
      metadata: { firstName, secondName },
      createdAt: Date.now(),
    });

    return targetUser._id;
  },
});

export const setAssignments = mutation({
  args: { companyId: v.id("companies"), membershipId: v.id("companyMemberships"), branchIds: v.array(v.id("branches")), departmentIds: v.array(v.id("departments")) },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "company:manage_users");
    await assertMembership(ctx, args.companyId, args.membershipId);
    const branchIds = unique(args.branchIds);
    const departmentIds = unique(args.departmentIds);
    for (const branchId of branchIds) await assertBranch(ctx, args.companyId, branchId);
    for (const departmentId of departmentIds) await assertDepartment(ctx, args.companyId, departmentId);
    for (const r of await ctx.db.query("userBranchAssignments").withIndex("by_membershipId_and_branchId", (q) => q.eq("membershipId", args.membershipId)).take(500)) await ctx.db.delete(r._id);
    for (const r of await ctx.db.query("userDepartmentAssignments").withIndex("by_membershipId_and_departmentId", (q) => q.eq("membershipId", args.membershipId)).take(500)) await ctx.db.delete(r._id);
    for (const branchId of branchIds) await ctx.db.insert("userBranchAssignments", { companyId: args.companyId, membershipId: args.membershipId, branchId });
    for (const departmentId of departmentIds) await ctx.db.insert("userDepartmentAssignments", { companyId: args.companyId, membershipId: args.membershipId, departmentId });
  },
});

export const setManagerScope = mutation({
  args: { companyId: v.id("companies"), managerMembershipId: v.id("companyMemberships"), branchIds: v.array(v.id("branches")), departmentIds: v.array(v.id("departments")), userMembershipIds: v.array(v.id("companyMemberships")) },
  handler: async (ctx, args) => {
    await requireCapability(ctx, args.companyId, "company:manage_roles");
    await assertMembership(ctx, args.companyId, args.managerMembershipId);
    const branchIds = unique(args.branchIds);
    const departmentIds = unique(args.departmentIds);
    const userMembershipIds = unique(args.userMembershipIds).filter((id) => id !== args.managerMembershipId);
    for (const branchId of branchIds) await assertBranch(ctx, args.companyId, branchId);
    for (const departmentId of departmentIds) await assertDepartment(ctx, args.companyId, departmentId);
    for (const membershipId of userMembershipIds) await assertMembership(ctx, args.companyId, membershipId);
    for (const r of await ctx.db.query("managerBranchScopes").withIndex("by_managerMembershipId_and_branchId", (q) => q.eq("managerMembershipId", args.managerMembershipId)).take(500)) await ctx.db.delete(r._id);
    for (const r of await ctx.db.query("managerDepartmentScopes").withIndex("by_managerMembershipId_and_departmentId", (q) => q.eq("managerMembershipId", args.managerMembershipId)).take(500)) await ctx.db.delete(r._id);
    for (const r of await ctx.db.query("managerUserScopes").withIndex("by_managerMembershipId_and_userMembershipId", (q) => q.eq("managerMembershipId", args.managerMembershipId)).take(500)) await ctx.db.delete(r._id);
    const updatedAt = Date.now();
    for (const branchId of branchIds) await ctx.db.insert("managerBranchScopes", { companyId: args.companyId, managerMembershipId: args.managerMembershipId, branchId, updatedAt });
    for (const departmentId of departmentIds) await ctx.db.insert("managerDepartmentScopes", { companyId: args.companyId, managerMembershipId: args.managerMembershipId, departmentId, updatedAt });
    for (const userMembershipId of userMembershipIds) await ctx.db.insert("managerUserScopes", { companyId: args.companyId, managerMembershipId: args.managerMembershipId, userMembershipId, updatedAt });
  },
});

export const createInvitationRecord = internalMutation({
  args: {
    companyId: v.id("companies"),
    email: v.string(),
    role: v.string(),
    branchIds: v.optional(v.array(v.id("branches"))),
    departmentIds: v.optional(v.array(v.id("departments"))),
    managedBranchIds: v.optional(v.array(v.id("branches"))),
    managedDepartmentIds: v.optional(v.array(v.id("departments"))),
    managedUserMembershipIds: v.optional(v.array(v.id("companyMemberships"))),
  },
  handler: async (ctx, args) => {
    const { user, company, capabilities: caps } = await requireCapability(ctx, args.companyId, "company:invite_users");
    await ensureDefaultRoles(ctx, args.companyId);
    const role = await roleDocByName(ctx, args.companyId, args.role);
    if (!role) throw new ConvexError("Role not found.");
    const canManageRoles = caps.has("company:manage_roles");
    const baseline = new Set<string>(baselineInvitationCapabilities);
    const roleCaps = roleDocCapabilities(role);
    if (!canManageRoles && !Array.from(roleCaps).every((cap) => baseline.has(cap))) {
      throw new ConvexError("You do not have access to invite with this role.");
    }
    const branchIds = unique(args.branchIds ?? []);
    const departmentIds = unique(args.departmentIds ?? []);
    const managedBranchIds = unique(args.managedBranchIds ?? []);
    const managedDepartmentIds = unique(args.managedDepartmentIds ?? []);
    const managedUserMembershipIds = unique(args.managedUserMembershipIds ?? []);
    if (
      (managedBranchIds.length || managedDepartmentIds.length || managedUserMembershipIds.length) &&
      !canManageRoles
    ) {
      throw new ConvexError("You cannot grant managed scopes.");
    }
    for (const branchId of [...branchIds, ...managedBranchIds]) await assertBranch(ctx, args.companyId, branchId);
    for (const departmentId of [...departmentIds, ...managedDepartmentIds]) await assertDepartment(ctx, args.companyId, departmentId);
    for (const membershipId of managedUserMembershipIds) {
      const m = await assertMembership(ctx, args.companyId, membershipId);
      if (!m.active) throw new ConvexError("Inactive users cannot be target scopes.");
    }
    const email = normalizeEmail(args.email);
    const now = Date.now();

    const existingUser = await ctx.db.query("appUsers").withIndex("by_email", (q) => q.eq("email", email)).unique();
    let targetMembership: Doc<"companyMemberships"> | null = null;
    if (existingUser) {
      targetMembership = await ctx.db
        .query("companyMemberships")
        .withIndex("by_company_user", (q) => q.eq("companyId", args.companyId).eq("userId", existingUser._id))
        .unique();
      if (targetMembership && targetMembership.active) {
        throw new ConvexError("A user with this email is already an active member of this company.");
      }
    }

    const existingPending = await ctx.db
      .query("invitations")
      .withIndex("by_companyId_and_email_and_status", (q) =>
        q.eq("companyId", args.companyId).eq("email", email).eq("status", "pending")
      )
      .collect();
    for (const inv of existingPending) {
      await ctx.db.patch(inv._id, { status: "revoked" });
    }

    const companyAuthVersion = company.authVersion ?? 1;
    const token = crypto.randomUUID();
    const patch = {
      role: role.name,
      branchIds,
      departmentIds,
      managedBranchIds,
      managedDepartmentIds,
      managedUserMembershipIds,
      expiresAt: now + 1_209_600_000,
    };
    const id = await ctx.db.insert("invitations", {
      companyId: args.companyId,
      email,
      ...patch,
      token,
      status: "pending",
      invitedBy: user._id,
      authVersion: companyAuthVersion,
      issuedAt: now,
      targetMembershipId: targetMembership?._id,
      targetMembershipUpdatedAt: targetMembership?.updatedAt,
      createdAt: now,
    });

    await ctx.db.insert("auditEvents", {
      companyId: args.companyId,
      actorUserId: user._id,
      action: "invitation.create",
      targetType: "invitation",
      targetId: id,
      metadata: { email, role: role.name },
      createdAt: now,
    });

    return { id, token };
  },
});

export const inviteUser = action({
  args: { companyId: v.id("companies"), email: v.string(), role: v.string(), branchIds: v.optional(v.array(v.id("branches"))), departmentIds: v.optional(v.array(v.id("departments"))), managedBranchIds: v.optional(v.array(v.id("branches"))), managedDepartmentIds: v.optional(v.array(v.id("departments"))), managedUserMembershipIds: v.optional(v.array(v.id("companyMemberships"))) },
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    const invite = await ctx.runMutation(internal.companyManagement.createInvitationRecord, args);
    await ctx.runAction(internal.email.sendInvitation, { companyId: args.companyId, invitationId: invite.id, email: args.email, role: args.role, token: invite.token });
    return { ok: true };
  },
});

export const cancelInvitation = mutation({
  args: { companyId: v.id("companies"), invitationId: v.id("invitations") },
  handler: async (ctx, args) => {
    const { user } = await requireCapability(ctx, args.companyId, "company:invite_users");
    const invitation = await ctx.db.get(args.invitationId);
    if (!invitation || invitation.companyId !== args.companyId) throw new ConvexError("Invitation not found.");
    if (invitation.status !== "pending") throw new ConvexError("This invitation is no longer pending.");
    const now = Date.now();
    await ctx.db.patch(invitation._id, { status: "revoked" });
    await ctx.db.insert("auditEvents", {
      companyId: args.companyId,
      actorUserId: user._id,
      action: "invitation.revoke",
      targetType: "invitation",
      targetId: invitation._id,
      metadata: { email: invitation.email },
      createdAt: now,
    });
    return null;
  },
});
