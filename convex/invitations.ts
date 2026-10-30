import { ConvexError, v } from "convex/values";
import { internalQuery, query } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { assertRoleManagerRemains, currentOrCreateUser, ensureDefaultRoles, roleDocByName } from "./permissions";

export const preview = query({
  args: { token: v.string() },
  returns: v.union(v.null(), v.object({ role: v.string(), companyName: v.string(), expiresAt: v.number() })),
  handler: async (ctx, args) => {
    const invitation = await ctx.db.query("invitations").withIndex("by_token", (q) => q.eq("token", args.token)).unique();
    if (!invitation || invitation.status !== "pending") return null;
    const company = await ctx.db.get(invitation.companyId);
    if (!company || company.deletedAt) return null;
    // The client owns time-based presentation; cached queries do not rerun at expiry.
    // Acceptance still checks the authoritative server clock.
    return { role: invitation.role, companyName: company.name, expiresAt: invitation.expiresAt };
  },
});

export const accept = mutation({
  args: { token: v.string() },
  returns: v.object({ companyId: v.id("companies") }),
  handler: async (ctx, args) => {
    const { user, identity } = await currentOrCreateUser(ctx);
    if (identity.emailVerified !== true) {
      throw new ConvexError("Email verification is required to accept an invitation.");
    }
    const invitation = await ctx.db.query("invitations").withIndex("by_token", (q) => q.eq("token", args.token)).unique();
    if (!invitation || invitation.status !== "pending") throw new ConvexError("Invitation not found.");
    if (invitation.expiresAt <= Date.now()) throw new ConvexError("This invitation has expired.");
    if (invitation.email.toLowerCase() !== user.email.toLowerCase()) throw new ConvexError("This invitation was sent to a different email address.");
    const company = await ctx.db.get(invitation.companyId);
    if (!company || company.deletedAt) throw new ConvexError("Company not found.");

    const companyAuthVersion = company.authVersion ?? 1;
    if (invitation.authVersion !== undefined && invitation.authVersion !== companyAuthVersion) {
      throw new ConvexError("This invitation is invalid or has been superseded.");
    }

    const now = Date.now();
    const existing = await ctx.db.query("companyMemberships").withIndex("by_company_user", (q) => q.eq("companyId", invitation.companyId).eq("userId", user._id)).unique();
    if (existing && existing.active) {
      throw new ConvexError("You are already an active member of this company.");
    }

    if (existing && !existing.active) {
      if (invitation.targetMembershipId && invitation.targetMembershipId !== existing._id) {
        throw new ConvexError("Invitation target membership does not match.");
      }
      if (
        invitation.targetMembershipUpdatedAt !== undefined &&
        existing.updatedAt !== invitation.targetMembershipUpdatedAt
      ) {
        throw new ConvexError("Membership state has changed since invitation was issued. Please request a new invitation.");
      }
    }

    await ensureDefaultRoles(ctx, invitation.companyId);
    const role = await roleDocByName(ctx, invitation.companyId, invitation.role);
    if (!role) {
      throw new ConvexError("The role on this invitation no longer exists. Please request a new invitation.");
    }
    if (existing) {
      await assertRoleManagerRemains(ctx, invitation.companyId, {
        roleChanges: new Map([[existing._id, role.name]]),
        activeChanges: new Map([[existing._id, true]]),
      });
    }
    const membershipId = existing
      ? existing._id
      : await ctx.db.insert("companyMemberships", { companyId: invitation.companyId, userId: user._id, role: role.name, active: true, createdAt: now, updatedAt: now });
    if (existing) await ctx.db.patch(existing._id, { role: role.name, active: true, updatedAt: now });

    const branchIds = invitation.branchIds ?? [];
    const departmentIds = invitation.departmentIds ?? [];
    const managedBranchIds = invitation.managedBranchIds ?? [];
    const managedDepartmentIds = invitation.managedDepartmentIds ?? [];
    const managedUserMembershipIds = invitation.managedUserMembershipIds ?? [];
    for (const branchId of [...branchIds, ...managedBranchIds]) { const branch = await ctx.db.get(branchId); if (!branch || branch.companyId !== invitation.companyId) throw new ConvexError("Invitation contains an invalid branch."); }
    for (const departmentId of [...departmentIds, ...managedDepartmentIds]) { const department = await ctx.db.get(departmentId); if (!department || department.companyId !== invitation.companyId) throw new ConvexError("Invitation contains an invalid department."); }
    for (const userMembershipId of managedUserMembershipIds) { const scopedMembership = await ctx.db.get(userMembershipId); if (!scopedMembership || scopedMembership.companyId !== invitation.companyId || !scopedMembership.active) throw new ConvexError("Invitation contains an invalid managed user."); }

    for (const row of await ctx.db.query("userBranchAssignments").withIndex("by_membershipId_and_branchId", (q) => q.eq("membershipId", membershipId)).take(500)) await ctx.db.delete(row._id);
    for (const row of await ctx.db.query("userDepartmentAssignments").withIndex("by_membershipId_and_departmentId", (q) => q.eq("membershipId", membershipId)).take(500)) await ctx.db.delete(row._id);
    for (const branchId of branchIds) await ctx.db.insert("userBranchAssignments", { companyId: invitation.companyId, membershipId, branchId });
    for (const departmentId of departmentIds) await ctx.db.insert("userDepartmentAssignments", { companyId: invitation.companyId, membershipId, departmentId });

    for (const row of await ctx.db.query("managerBranchScopes").withIndex("by_managerMembershipId_and_branchId", (q) => q.eq("managerMembershipId", membershipId)).take(500)) await ctx.db.delete(row._id);
    for (const row of await ctx.db.query("managerDepartmentScopes").withIndex("by_managerMembershipId_and_departmentId", (q) => q.eq("managerMembershipId", membershipId)).take(500)) await ctx.db.delete(row._id);
    for (const row of await ctx.db.query("managerUserScopes").withIndex("by_managerMembershipId_and_userMembershipId", (q) => q.eq("managerMembershipId", membershipId)).take(500)) await ctx.db.delete(row._id);
    for (const branchId of managedBranchIds) await ctx.db.insert("managerBranchScopes", { companyId: invitation.companyId, managerMembershipId: membershipId, branchId, updatedAt: now });
    for (const departmentId of managedDepartmentIds) await ctx.db.insert("managerDepartmentScopes", { companyId: invitation.companyId, managerMembershipId: membershipId, departmentId, updatedAt: now });
    for (const userMembershipId of managedUserMembershipIds) if (userMembershipId !== membershipId) await ctx.db.insert("managerUserScopes", { companyId: invitation.companyId, managerMembershipId: membershipId, userMembershipId, updatedAt: now });

    await ctx.db.patch(invitation._id, { status: "accepted" });
    await ctx.db.insert("auditEvents", { companyId: invitation.companyId, actorUserId: user._id, action: "invitation.accept", targetType: "membership", targetId: membershipId, metadata: { role: role.name }, createdAt: now });
    return { companyId: invitation.companyId };
  },
});

export const markSent = internalMutation({
  args: { invitationId: v.id("invitations") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.invitationId, { sentAt: Date.now() });
  },
});

export const statusById = internalQuery({
  args: { invitationId: v.id("invitations") },
  handler: async (ctx, args) => (await ctx.db.get(args.invitationId))?.status ?? null,
});
