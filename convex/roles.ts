import { ConvexError, v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  assertRoleManagerRemains,
  ensureDefaultRoles,
  requireCapability,
  requireMembership,
  roleDocByName,
} from "./permissions";
import { defaultRoleCapabilities, isKnownCapability, type Capability } from "../src/lib/permissions";
import { nonEmpty } from "./validation";

const ROLE_NAME_LIMIT = 60;
const LIST_LIMIT = 500;

async function assertRole(ctx: MutationCtx, companyId: Id<"companies">, roleId: Id<"roles">) {
  const role = await ctx.db.get(roleId);
  if (!role || role.companyId !== companyId) throw new ConvexError("Role not found.");
  return role;
}

function cleanCapabilities(input: string[]) {
  const seen = new Set<Capability>();
  for (const capability of input) {
    if (!isKnownCapability(capability)) throw new ConvexError("Unknown permission.");
    seen.add(capability);
  }
  return Array.from(seen);
}

async function assertRoleNameAvailable(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  name: string,
  exceptRoleId?: Id<"roles">
) {
  const existing = await roleDocByName(ctx, companyId, name);
  if (existing && existing._id !== exceptRoleId) {
    throw new ConvexError("A role with this name already exists.");
  }
}

function cleanRoleName(value: string) {
  const name = nonEmpty(value, "Role name");
  if (name.length > ROLE_NAME_LIMIT) throw new ConvexError("Role name is too long.");
  return name;
}

async function uniqueRoleName(ctx: MutationCtx, companyId: Id<"companies">, base: string) {
  const trimmed = base.slice(0, ROLE_NAME_LIMIT).trimEnd();
  if (!(await roleDocByName(ctx, companyId, trimmed))) return trimmed;
  for (let index = 2; ; index += 1) {
    const suffix = ` ${index}`;
    const candidate = `${trimmed.slice(0, ROLE_NAME_LIMIT - suffix.length)}${suffix}`;
    if (!(await roleDocByName(ctx, companyId, candidate))) return candidate;
  }
}

async function pendingInvitations(ctx: MutationCtx, companyId: Id<"companies">) {
  const rows: Doc<"invitations">[] = [];
  for await (const invitation of ctx.db
    .query("invitations")
    .withIndex("by_companyId_and_status_and_targetMembershipId", (q) => q.eq("companyId", companyId).eq("status", "pending"))) {
    rows.push(invitation);
  }
  return rows;
}

async function membershipsWithRole(ctx: MutationCtx, companyId: Id<"companies">, roleName: string) {
  const rows: Doc<"companyMemberships">[] = [];
  for await (const membership of ctx.db
    .query("companyMemberships")
    .withIndex("by_companyId_and_role", (q) => q.eq("companyId", companyId).eq("role", roleName))) {
    rows.push(membership);
  }
  return rows;
}

/**
 * Deletes legacy per-user override rows and clears the deprecated invitation
 * field. Runs inside role mutations and invitation flows so migrated
 * deployments are cleaned automatically on first use.
 */
async function deleteLegacyOverrideRows(ctx: MutationCtx, companyId: Id<"companies">) {
  for await (const membership of ctx.db
    .query("companyMemberships")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))) {
    while (true) {
      const rows = await ctx.db
        .query("permissionOverrides")
        .withIndex("by_membershipId_and_capability", (q) => q.eq("membershipId", membership._id))
        .take(LIST_LIMIT);
      if (!rows.length) break;
      for (const row of rows) await ctx.db.delete(row._id);
    }
  }
  for (const invitation of await pendingInvitations(ctx, companyId)) {
    if (invitation.permissionOverrides?.length) {
      await ctx.db.patch(invitation._id, { permissionOverrides: undefined });
    }
  }
}

/** One-time release backfill for untouched default Admin roles, not customized roles. */
export const enableJdLifecycleDefaults = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const previousDefaults = new Set<string>(defaultRoleCapabilities.Admin.filter((cap) => cap !== "tasks:jd:pause" && cap !== "tasks:jd:resume"));
    const page = await ctx.db.query("roles").paginate({ numItems: 100, cursor: args.cursor ?? null });
    let updated = 0;
    for (const role of page.page) {
      const caps = new Set(role.capabilities);
      if (role.name === "Admin" && caps.size === previousDefaults.size && [...previousDefaults].every((cap) => caps.has(cap))) {
        await ctx.db.patch(role._id, { capabilities: [...defaultRoleCapabilities.Admin], updatedAt: Date.now() });
        updated++;
      }
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.roles.enableJdLifecycleDefaults, { cursor: page.continueCursor });
    return updated;
  },
});

/** One-time release backfill for untouched default Admin and Manager roles, not customized roles. */
export const enableTaskConfirmationDefaults = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("roles").paginate({ numItems: 100, cursor: args.cursor ?? null });
    let updated = 0;
    for (const role of page.page) {
      if (role.name !== "Admin" && role.name !== "Manager") continue;
      const next = defaultRoleCapabilities[role.name];
      const previous = new Set(next.filter((cap) => cap !== "tasks:confirm"));
      const caps = new Set(role.capabilities);
      if (caps.size === previous.size && [...previous].every((cap) => caps.has(cap))) {
        await ctx.db.patch(role._id, { capabilities: [...next], updatedAt: Date.now() });
        updated++;
      }
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.roles.enableTaskConfirmationDefaults, { cursor: page.continueCursor });
    return updated;
  },
});

export const ensureDefaults = mutation({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    await requireMembership(ctx, args.companyId);
    await ensureDefaultRoles(ctx, args.companyId);
    await deleteLegacyOverrideRows(ctx, args.companyId);
    return null;
  },
});

export const create = mutation({
  args: { companyId: v.id("companies"), name: v.string(), capabilities: v.array(v.string()) },
  handler: async (ctx, args) => {
    const { user } = await requireCapability(ctx, args.companyId, "company:manage_roles");
    await ensureDefaultRoles(ctx, args.companyId);
    const name = cleanRoleName(args.name);
    const capabilities = cleanCapabilities(args.capabilities);
    await assertRoleNameAvailable(ctx, args.companyId, name);
    const now = Date.now();
    const roleId = await ctx.db.insert("roles", {
      companyId: args.companyId,
      name,
      capabilities,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("auditEvents", {
      companyId: args.companyId,
      actorUserId: user._id,
      action: "role.create",
      targetType: "role",
      targetId: roleId,
      metadata: { name },
      createdAt: now,
    });
    return roleId;
  },
});

export const update = mutation({
  args: { companyId: v.id("companies"), roleId: v.id("roles"), name: v.string(), capabilities: v.array(v.string()) },
  handler: async (ctx, args) => {
    const { user } = await requireCapability(ctx, args.companyId, "company:manage_roles");
    const role = await assertRole(ctx, args.companyId, args.roleId);
    const name = cleanRoleName(args.name);
    const capabilities = cleanCapabilities(args.capabilities);
    const renamed = name !== role.name;
    if (renamed) await assertRoleNameAvailable(ctx, args.companyId, name, role._id);

    if (renamed) {
      const memberships = await membershipsWithRole(ctx, args.companyId, role.name);
      const roleChanges = new Map(memberships.map((m) => [m._id, name]));
      await assertRoleManagerRemains(ctx, args.companyId, {
        roleChanges,
        capabilityChanges: new Map([[name, capabilities]]),
      });
      const now = Date.now();
      const beforeUpdatedAt = new Map(memberships.map((m) => [m._id, m.updatedAt]));
      for (const membership of memberships) {
        await ctx.db.patch(membership._id, { role: name, updatedAt: now });
      }
      for (const invitation of await pendingInvitations(ctx, args.companyId)) {
        const patch: { role?: string; targetMembershipUpdatedAt?: number } = {};
        if (invitation.role === role.name) patch.role = name;
        if (invitation.targetMembershipId) {
          const previous = beforeUpdatedAt.get(invitation.targetMembershipId);
          // Refresh the snapshot only when it still matched the membership
          // before this rename; an already-stale invitation must stay stale.
          if (previous !== undefined && invitation.targetMembershipUpdatedAt === previous) {
            patch.targetMembershipUpdatedAt = now;
          }
        }
        if (patch.role !== undefined || patch.targetMembershipUpdatedAt !== undefined) {
          await ctx.db.patch(invitation._id, patch);
        }
      }
    } else {
      await assertRoleManagerRemains(ctx, args.companyId, {
        capabilityChanges: new Map([[name, capabilities]]),
      });
    }

    await ctx.db.patch(role._id, { name, capabilities, updatedAt: Date.now() });
    await ctx.db.insert("auditEvents", {
      companyId: args.companyId,
      actorUserId: user._id,
      action: "role.update",
      targetType: "role",
      targetId: role._id,
      metadata: renamed ? { previousName: role.name, name } : { name },
      createdAt: Date.now(),
    });
    return null;
  },
});

export const duplicate = mutation({
  args: { companyId: v.id("companies"), roleId: v.id("roles") },
  handler: async (ctx, args) => {
    const { user } = await requireCapability(ctx, args.companyId, "company:manage_roles");
    const role = await assertRole(ctx, args.companyId, args.roleId);
    const now = Date.now();
    const name = await uniqueRoleName(ctx, args.companyId, `${role.name} copy`);
    const roleId = await ctx.db.insert("roles", {
      companyId: args.companyId,
      name,
      capabilities: role.capabilities,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("auditEvents", {
      companyId: args.companyId,
      actorUserId: user._id,
      action: "role.duplicate",
      targetType: "role",
      targetId: roleId,
      metadata: { name, sourceRoleId: role._id, sourceName: role.name },
      createdAt: now,
    });
    return roleId;
  },
});

export const remove = mutation({
  args: { companyId: v.id("companies"), roleId: v.id("roles") },
  handler: async (ctx, args) => {
    const { user } = await requireCapability(ctx, args.companyId, "company:manage_roles");
    const role = await assertRole(ctx, args.companyId, args.roleId);

    const member = await ctx.db
      .query("companyMemberships")
      .withIndex("by_companyId_and_role", (q) => q.eq("companyId", args.companyId).eq("role", role.name))
      .first();
    if (member) {
      throw new ConvexError("Reassign members to another role before deleting this one.");
    }
    const invitation = await ctx.db
      .query("invitations")
      .withIndex("by_companyId_and_status_and_targetMembershipId", (q) => q.eq("companyId", args.companyId).eq("status", "pending"))
      .filter((q) => q.eq(q.field("role"), role.name))
      .first();
    if (invitation) {
      throw new ConvexError("Revoke pending invitations using this role before deleting it.");
    }
    await assertRoleManagerRemains(ctx, args.companyId, {
      capabilityChanges: new Map([[role.name, []]]),
    });
    await ctx.db.delete(role._id);
    await ctx.db.insert("auditEvents", {
      companyId: args.companyId,
      actorUserId: user._id,
      action: "role.delete",
      targetType: "role",
      targetId: role._id,
      metadata: { name: role.name },
      createdAt: Date.now(),
    });
    return null;
  },
});

export const assign = mutation({
  args: {
    companyId: v.id("companies"),
    membershipIds: v.array(v.id("companyMemberships")),
    role: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireCapability(ctx, args.companyId, "company:manage_roles");
    await ensureDefaultRoles(ctx, args.companyId);
    const role = await roleDocByName(ctx, args.companyId, args.role);
    if (!role) throw new ConvexError("Role not found.");

    const membershipIds = Array.from(new Set(args.membershipIds));
    const targets: Doc<"companyMemberships">[] = [];
    for (const membershipId of membershipIds) {
      const membership = await ctx.db.get(membershipId);
      if (!membership || membership.companyId !== args.companyId) {
        throw new ConvexError("User not found in this company.");
      }
      targets.push(membership);
    }
    if (!targets.length) return null;

    await assertRoleManagerRemains(ctx, args.companyId, {
      roleChanges: new Map(targets.map((m) => [m._id, role.name])),
    });

    const pending = await pendingInvitations(ctx, args.companyId);
    const now = Date.now();
    for (const membership of targets) {
      if (membership.role !== role.name) {
        await ctx.db.patch(membership._id, { role: role.name, updatedAt: now });
        await ctx.db.insert("auditEvents", {
          companyId: args.companyId,
          actorUserId: user._id,
          action: "member.role_change",
          targetType: "membership",
          targetId: membership._id,
          metadata: { previousRole: membership.role, nextRole: role.name },
          createdAt: now,
        });
      }
      for (const invite of pending) {
        if (invite.targetMembershipId === membership._id) {
          await ctx.db.patch(invite._id, { status: "revoked" });
        }
      }
    }
    return null;
  },
});
