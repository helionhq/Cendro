import type { UserIdentity } from "convex/server";
import { ConvexError } from "convex/values";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  defaultRoleNames,
  defaultRoleCapabilities,
  isKnownCapability,
  legacyRoleCapabilities,
  type Capability,
} from "../src/lib/permissions";
import { isPlatformAdmin } from "../src/lib/platform-admin";
import { normalizeEmail } from "./validation";
import { DEFAULT_QUERY_LIMIT, takeWithOverflow } from "./queryLimits";

type Ctx = MutationCtx | QueryCtx;
type TruncationObserver = () => void;

async function takeScopeRows<T>(
  take: (limit: number) => Promise<T[]>,
  onTruncated?: TruncationObserver,
) {
  if (!onTruncated) return await take(DEFAULT_QUERY_LIMIT);
  const result = await takeWithOverflow(take);
  if (result.isTruncated) onTruncated();
  return result.rows;
}

export type CompanyAuthContext = {
  identity: UserIdentity;
  user: Doc<"appUsers">;
  company: Doc<"companies">;
  membership: Doc<"companyMemberships">;
  capabilities: Set<Capability>;
};

export function isPlatformAdminSubject(subject?: string | null) {
  return isPlatformAdmin(subject);
}

export function assertPlatformAdmin(identity: UserIdentity | null | undefined) {
  if (!identity || !isPlatformAdminSubject(identity.subject)) {
    throw new ConvexError("You do not have access to this.");
  }
}

// Deprecated email check - preserved only for safe closed fallback
export function isPlatformAdminEmail() {
  return false;
}
export function assertPlatformAdminEmail() {
  throw new ConvexError("You do not have access to this.");
}

export async function currentUser(ctx: Ctx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Please sign in.");
  const user = await ctx.db
    .query("appUsers")
    .withIndex("by_subject", (q) => q.eq("clerkSubject", identity.tokenIdentifier))
    .unique();
  if (!user) throw new ConvexError("Your profile is still syncing. Refresh in a moment.");
  return { identity, user };
}

export async function roleDocByName(
  ctx: Ctx,
  companyId: Id<"companies">,
  name: string
) {
  return await ctx.db
    .query("roles")
    .withIndex("by_company_and_name", (q) => q.eq("companyId", companyId).eq("name", name))
    .unique();
}

export function roleDocCapabilities(role: Doc<"roles">) {
  return new Set(role.capabilities.filter(isKnownCapability) as Capability[]);
}

export async function roleNameCapabilities(
  ctx: Ctx,
  companyId: Id<"companies">,
  roleName: string,
  cache?: Map<string, Promise<Set<Capability>>>
) {
  const cached = cache?.get(roleName);
  if (cached) return await cached;
  const promise = (async () => {
    const doc = await roleDocByName(ctx, companyId, roleName);
    return doc ? roleDocCapabilities(doc) : new Set(legacyRoleCapabilities(roleName));
  })();
  cache?.set(roleName, promise);
  return await promise;
}

/**
 * Inserts the default Admin/Manager/Employee role documents for a company
 * that does not have any roles yet. Idempotent and never resurrects roles an
 * admin deliberately removed.
 */
export async function ensureDefaultRoles(ctx: MutationCtx, companyId: Id<"companies">) {
  const existing = await ctx.db
    .query("roles")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .first();
  if (existing) return;
  const now = Date.now();
  for (const name of defaultRoleNames) {
    await ctx.db.insert("roles", {
      companyId,
      name,
      capabilities: defaultRoleCapabilities[name],
      createdAt: now,
      updatedAt: now,
    });
  }
}

export function cleanNamePart(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function nameFields(firstName: string, secondName: string) {
  const cleanSecondName = secondName.trim();
  return cleanSecondName ? { firstName, secondName: cleanSecondName } : { firstName };
}

export function namesFromIdentity(identity: UserIdentity, email: string) {
  return nameFields(
    cleanNamePart(identity.givenName) || cleanNamePart(identity.name) || email,
    cleanNamePart(identity.familyName)
  );
}

export function namesForExistingUser(
  existing: { firstName?: unknown; secondName?: unknown },
  identity: UserIdentity,
  email: string
) {
  const names = namesFromIdentity(identity, email);
  const firstName =
    typeof existing.firstName === "string" ? cleanNamePart(existing.firstName) || email : names.firstName;
  const secondName =
    typeof existing.secondName === "string" ? cleanNamePart(existing.secondName) : names.secondName ?? "";
  return nameFields(firstName, secondName);
}

export function memberFirstName(
  membership: { firstName?: string } | null | undefined,
  user: { firstName: string; email: string }
) {
  return membership?.firstName?.trim() || user.firstName.trim() || user.email;
}

export function memberFullName(
  membership: { firstName?: string; secondName?: string } | null | undefined,
  user: { firstName: string; secondName?: string; email: string }
) {
  const first = memberFirstName(membership, user);
  const second =
    membership?.secondName !== undefined ? membership.secondName.trim() : user.secondName?.trim() ?? "";
  return [first, second].filter(Boolean).join(" ") || user.email;
}

export async function membershipCapabilities(ctx: Ctx, m: Doc<"companyMemberships">) {
  return await roleNameCapabilities(ctx, m.companyId, m.role);
}

export type RoleManagerChange = {
  /** Memberships whose role name is about to change. */
  roleChanges?: ReadonlyMap<Id<"companyMemberships">, string>;
  /** Memberships whose active flag is about to change. */
  activeChanges?: ReadonlyMap<Id<"companyMemberships">, boolean>;
  /** Capability overrides for role names being edited (role name -> next capabilities). */
  capabilityChanges?: ReadonlyMap<string, readonly string[]>;
};

/**
 * Guarantees at least one active member retains the role-management
 * capability after the supplied pending changes. Must run inside the same
 * transaction as the mutation it guards.
 */
export async function assertRoleManagerRemains(
  ctx: Ctx,
  companyId: Id<"companies">,
  change: RoleManagerChange = {}
) {
  const capCache = new Map<string, Promise<Set<Capability>>>();
  for await (const membership of ctx.db
    .query("companyMemberships")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))) {
    const isActive = change.activeChanges?.get(membership._id) ?? membership.active;
    if (!isActive) continue;
    const roleName = change.roleChanges?.get(membership._id) ?? membership.role;
    const pendingCaps = change.capabilityChanges?.get(roleName);
    const caps = pendingCaps
      ? new Set(pendingCaps.filter(isKnownCapability) as Capability[])
      : await roleNameCapabilities(ctx, companyId, roleName, capCache);
    if (caps.has("company:manage_roles")) return;
  }
  throw new ConvexError("At least one active member must be able to manage roles.");
}

export async function currentOrCreateUser(ctx: MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Please sign in.");
  const email = identity.email ? normalizeEmail(identity.email) : null;
  if (!email) throw new ConvexError("Authenticated email is required.");
  const imageUrl = identity.pictureUrl;
  const now = Date.now();
  const existing = await ctx.db
    .query("appUsers")
    .withIndex("by_subject", (q) => q.eq("clerkSubject", identity.tokenIdentifier))
    .unique();
  if (existing) {
    const names = namesForExistingUser(existing, identity, email);
    await ctx.db.replace(existing._id, {
      clerkSubject: existing.clerkSubject,
      email,
      ...names,
      imageUrl,
      createdAt: existing.createdAt,
      updatedAt: now,
    });
    const user = await ctx.db.get(existing._id);
    if (!user) throw new ConvexError("Could not update your profile.");
    return { identity, user };
  }
  const names = namesFromIdentity(identity, email);
  const userId = await ctx.db.insert("appUsers", {
    clerkSubject: identity.tokenIdentifier,
    email,
    ...names,
    imageUrl,
    createdAt: now,
    updatedAt: now,
  });
  const user = await ctx.db.get(userId);
  if (!user) throw new ConvexError("Could not create your profile.");
  return { identity, user };
}

export async function requireCompanyAccess(
  ctx: Ctx,
  companyId: Id<"companies">
): Promise<CompanyAuthContext> {
  const { identity, user } = await currentUser(ctx);
  const company = await ctx.db.get(companyId);
  if (!company || company.deletedAt) throw new ConvexError("Company not found.");
  const membership = await ctx.db
    .query("companyMemberships")
    .withIndex("by_company_user", (q) => q.eq("companyId", companyId).eq("userId", user._id))
    .unique();
  if (!membership || !membership.active) throw new ConvexError("You do not have access to this company.");
  const caps = await membershipCapabilities(ctx, membership);
  return { identity, user, company, membership, capabilities: caps };
}

export async function requireMembership(ctx: Ctx, companyId: Id<"companies">) {
  const auth = await requireCompanyAccess(ctx, companyId);
  return {
    user: auth.user,
    membership: auth.membership,
    company: auth.company,
    capabilities: auth.capabilities,
    identity: auth.identity,
  };
}

export async function requireCapability(ctx: Ctx, companyId: Id<"companies">, capability: Capability) {
  const auth = await requireCompanyAccess(ctx, companyId);
  if (!auth.capabilities.has(capability)) throw new ConvexError("You do not have access to do that.");
  return auth;
}

/** Same check as requireCapability against capabilities the caller already resolved. */
export function assertCapability(caps: Set<Capability>, capability: Capability) {
  if (!caps.has(capability)) throw new ConvexError("You do not have access to do that.");
}

export async function assertCompanyDocument<Table extends TableNames>(
  ctx: Ctx,
  companyId: Id<"companies">,
  table: Table,
  id: Id<Table>,
  notFoundMessage = "Resource not found."
): Promise<Doc<Table>> {
  const doc = await ctx.db.get(id);
  if (!doc || (doc as any).companyId !== companyId) {
    throw new ConvexError(notFoundMessage);
  }
  return doc;
}

async function addActiveMembership(
  ctx: Ctx,
  ids: Set<Id<"companyMemberships">>,
  companyId: Id<"companies">,
  id: Id<"companyMemberships">
) {
  const candidate = await ctx.db.get(id);
  if (candidate?.companyId === companyId && candidate.active) ids.add(id);
}

export async function activeCompanyMembershipIds(
  ctx: Ctx,
  companyId: Id<"companies">,
  onTruncated?: TruncationObserver,
) {
  const all = await takeScopeRows(
    (limit) => ctx.db
      .query("companyMemberships")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .take(limit),
    onTruncated,
  );
  return new Set(all.filter((x) => x.active).map((x) => x._id));
}

export async function getManagedMembershipIds(
  ctx: Ctx,
  companyId: Id<"companies">,
  managerMembershipId: Id<"companyMemberships">,
  onTruncated?: TruncationObserver,
): Promise<Set<Id<"companyMemberships">>> {
  const ids = new Set<Id<"companyMemberships">>([managerMembershipId]);
  const userScopes = await takeScopeRows(
    (limit) => ctx.db
      .query("managerUserScopes")
      .withIndex("by_managerMembershipId_and_userMembershipId", (q) => q.eq("managerMembershipId", managerMembershipId))
      .take(limit),
    onTruncated,
  );
  for (const row of userScopes) await addActiveMembership(ctx, ids, companyId, row.userMembershipId);

  const [branchScopes, departmentScopes] = await Promise.all([
    takeScopeRows(
      (limit) => ctx.db
        .query("managerBranchScopes")
        .withIndex("by_managerMembershipId_and_branchId", (q) => q.eq("managerMembershipId", managerMembershipId))
        .take(limit),
      onTruncated,
    ),
    takeScopeRows(
      (limit) => ctx.db
        .query("managerDepartmentScopes")
        .withIndex("by_managerMembershipId_and_departmentId", (q) => q.eq("managerMembershipId", managerMembershipId))
        .take(limit),
      onTruncated,
    ),
  ]);
  const [branchAssignments, departmentAssignments] = await Promise.all([
    Promise.all(branchScopes.map((row) =>
      takeScopeRows(
        (limit) => ctx.db
          .query("userBranchAssignments")
          .withIndex("by_branch", (q) => q.eq("branchId", row.branchId))
          .take(limit),
        onTruncated,
      ),
    )),
    Promise.all(departmentScopes.map((row) =>
      takeScopeRows(
        (limit) => ctx.db
          .query("userDepartmentAssignments")
          .withIndex("by_department", (q) => q.eq("departmentId", row.departmentId))
          .take(limit),
        onTruncated,
      ),
    )),
  ]);
  for (const assignments of [...branchAssignments, ...departmentAssignments]) {
    for (const assignment of assignments) await addActiveMembership(ctx, ids, companyId, assignment.membershipId);
  }
  return ids;
}

/**
 * Scans a manager's scope without the default 500-row authorization cache.
 * The scan stops after one extra scope or membership row, so callers can
 * disclose that a bounded result may omit additional people.
 */
export async function scanManagedMembershipIds(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  managerMembershipId: Id<"companyMemberships">,
  limit: number,
): Promise<{ ids: Id<"companyMemberships">[]; isTruncated: boolean }> {
  const ids = new Set<Id<"companyMemberships">>([managerMembershipId]);
  let scopeRows = 0;
  let membershipRows = 0;
  const result = (isTruncated: boolean) => ({ ids: Array.from(ids), isTruncated });
  const nextScopeRow = () => ++scopeRows <= limit;
  const addMembership = (membershipId: Id<"companyMemberships">, belongsToCompany: boolean) => {
    membershipRows += 1;
    if (membershipRows > limit || (belongsToCompany && !ids.has(membershipId) && ids.size >= limit)) {
      return false;
    }
    if (belongsToCompany) ids.add(membershipId);
    return true;
  };

  for await (const row of ctx.db
    .query("managerUserScopes")
    .withIndex("by_managerMembershipId_and_userMembershipId", (q) => q.eq("managerMembershipId", managerMembershipId))) {
    if (!nextScopeRow() || !addMembership(row.userMembershipId, row.companyId === companyId)) return result(true);
  }

  for await (const scope of ctx.db
    .query("managerBranchScopes")
    .withIndex("by_managerMembershipId_and_branchId", (q) => q.eq("managerMembershipId", managerMembershipId))) {
    if (!nextScopeRow()) return result(true);
    if (scope.companyId !== companyId) continue;
    for await (const assignment of ctx.db
      .query("userBranchAssignments")
      .withIndex("by_branch", (q) => q.eq("branchId", scope.branchId))) {
      if (!addMembership(assignment.membershipId, assignment.companyId === companyId)) return result(true);
    }
  }

  for await (const scope of ctx.db
    .query("managerDepartmentScopes")
    .withIndex("by_managerMembershipId_and_departmentId", (q) => q.eq("managerMembershipId", managerMembershipId))) {
    if (!nextScopeRow()) return result(true);
    if (scope.companyId !== companyId) continue;
    for await (const assignment of ctx.db
      .query("userDepartmentAssignments")
      .withIndex("by_department", (q) => q.eq("departmentId", scope.departmentId))) {
      if (!addMembership(assignment.membershipId, assignment.companyId === companyId)) return result(true);
    }
  }

  return result(false);
}

export async function scopedMembershipIds(
  ctx: Ctx,
  companyId: Id<"companies">,
  m: Doc<"companyMemberships">,
  precomputedCaps?: Set<Capability>,
  targetCapability?: Capability,
  onTruncated?: TruncationObserver,
): Promise<Set<Id<"companyMemberships">>> {
  const caps = precomputedCaps ?? (await membershipCapabilities(ctx, m));
  if (targetCapability) {
    if (caps.has(targetCapability)) {
      return await activeCompanyMembershipIds(ctx, companyId, onTruncated);
    }
  } else if (
    caps.has("analytics:view:company") ||
    caps.has("tasks:jd:view:any") ||
    caps.has("tasks:one_time:view:any") ||
    caps.has("sops:view:company")
  ) {
    return await activeCompanyMembershipIds(ctx, companyId, onTruncated);
  }
  return await getManagedMembershipIds(ctx, companyId, m._id, onTruncated);
}

export function hasAnalyticsViewAccess(caps: Set<Capability>) {
  return (
    caps.has("analytics:view:company") ||
    caps.has("analytics:view:managed_scope") ||
    caps.has("analytics:view:self")
  );
}

export function assertAnalyticsViewAccess(caps: Set<Capability>) {
  if (!hasAnalyticsViewAccess(caps)) throw new ConvexError("You do not have access to analytics.");
}

export async function analyticsScopedMembershipIds(
  ctx: Ctx,
  companyId: Id<"companies">,
  m: Doc<"companyMemberships">,
  precomputedCaps?: Set<Capability>,
  onTruncated?: TruncationObserver,
) {
  const caps = precomputedCaps ?? (await membershipCapabilities(ctx, m));
  assertAnalyticsViewAccess(caps);
  if (caps.has("analytics:view:company")) return await activeCompanyMembershipIds(ctx, companyId, onTruncated);
  if (caps.has("analytics:view:managed_scope")) {
    const scoped = await getManagedMembershipIds(ctx, companyId, m._id, onTruncated);
    if (!caps.has("analytics:view:self")) scoped.delete(m._id);
    return scoped;
  }
  return new Set<Id<"companyMemberships">>([m._id]);
}

export function visibleAssigneeMembershipIds(
  assigneeMembershipIds: readonly Id<"companyMemberships">[],
  scopedIds: Set<Id<"companyMemberships">>
) {
  return assigneeMembershipIds.filter((id) => scopedIds.has(id));
}

export function taskHasVisibleAssignee(
  task: { assigneeMembershipIds: readonly Id<"companyMemberships">[] },
  scopedIds: Set<Id<"companyMemberships">>
) {
  return task.assigneeMembershipIds.some((id) => scopedIds.has(id));
}

export async function canViewTask(
  ctx: Ctx,
  companyId: Id<"companies">,
  m: Doc<"companyMemberships">,
  task: {
    companyId: Id<"companies">;
    assigneeMembershipIds: readonly Id<"companyMemberships">[];
    createdByMembershipId: Id<"companyMemberships">;
  },
  kind: "jd" | "one_time",
  precomputedCaps?: Set<Capability>,
  cachedManagedIds?: Set<Id<"companyMemberships">>
): Promise<boolean> {
  if (task.companyId !== companyId) return false;
  const caps = precomputedCaps ?? (await membershipCapabilities(ctx, m));
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  if (caps.has(`${prefix}:view:any` as Capability)) return true;
  const targets =
    task.assigneeMembershipIds.length > 0 ? task.assigneeMembershipIds : [task.createdByMembershipId];
  if (caps.has(`${prefix}:view:managed` as Capability)) {
    const managed = cachedManagedIds ?? (await getManagedMembershipIds(ctx, companyId, m._id));
    if (await hasAnyManagedMembership(ctx, companyId, m._id, targets, managed)) return true;
  }
  if (caps.has(`${prefix}:view:self` as Capability)) {
    if (targets.includes(m._id) || task.createdByMembershipId === m._id) return true;
  }
  return false;
}

export async function isManagedMembership(
  ctx: Ctx,
  companyId: Id<"companies">,
  managerMembershipId: Id<"companyMemberships">,
  membershipId: Id<"companyMemberships">,
  cachedManagedIds?: Set<Id<"companyMemberships">>,
) {
  if (cachedManagedIds?.has(membershipId) || membershipId === managerMembershipId) return true;
  const membership = await ctx.db.get(membershipId);
  if (!membership || membership.companyId !== companyId || !membership.active) return false;

  const directScope = await ctx.db
    .query("managerUserScopes")
    .withIndex("by_managerMembershipId_and_userMembershipId", (q) =>
      q.eq("managerMembershipId", managerMembershipId).eq("userMembershipId", membershipId),
    )
    .first();
  if (directScope?.companyId === companyId) {
    cachedManagedIds?.add(membershipId);
    return true;
  }

  // This is the authoritative fallback for an individual target, so it must
  // inspect every assignment rather than reuse the bounded scope cache.
  for await (const assignment of ctx.db
    .query("userBranchAssignments")
    .withIndex("by_membershipId_and_branchId", (q) => q.eq("membershipId", membershipId))) {
    if (assignment.companyId !== companyId) continue;
    const scope = await ctx.db
      .query("managerBranchScopes")
      .withIndex("by_managerMembershipId_and_branchId", (q) =>
        q.eq("managerMembershipId", managerMembershipId).eq("branchId", assignment.branchId),
      )
      .first();
    if (scope?.companyId === companyId) {
      cachedManagedIds?.add(membershipId);
      return true;
    }
  }
  for await (const assignment of ctx.db
    .query("userDepartmentAssignments")
    .withIndex("by_membershipId_and_departmentId", (q) => q.eq("membershipId", membershipId))) {
    if (assignment.companyId !== companyId) continue;
    const scope = await ctx.db
      .query("managerDepartmentScopes")
      .withIndex("by_managerMembershipId_and_departmentId", (q) =>
        q.eq("managerMembershipId", managerMembershipId).eq("departmentId", assignment.departmentId),
      )
      .first();
    if (scope?.companyId === companyId) {
      cachedManagedIds?.add(membershipId);
      return true;
    }
  }
  return false;
}

export async function hasAnyManagedMembership(
  ctx: Ctx,
  companyId: Id<"companies">,
  managerMembershipId: Id<"companyMemberships">,
  membershipIds: readonly Id<"companyMemberships">[],
  cachedManagedIds?: Set<Id<"companyMemberships">>,
) {
  for (const membershipId of membershipIds) {
    if (await isManagedMembership(ctx, companyId, managerMembershipId, membershipId, cachedManagedIds)) return true;
  }
  return false;
}

export async function hasAllManagedMemberships(
  ctx: Ctx,
  companyId: Id<"companies">,
  managerMembershipId: Id<"companyMemberships">,
  membershipIds: readonly Id<"companyMemberships">[],
  cachedManagedIds?: Set<Id<"companyMemberships">>,
) {
  for (const membershipId of membershipIds) {
    if (!(await isManagedMembership(ctx, companyId, managerMembershipId, membershipId, cachedManagedIds))) return false;
  }
  return true;
}

export async function assertCanAssign(
  ctx: Ctx,
  companyId: Id<"companies">,
  m: Doc<"companyMemberships">,
  assignees: Id<"companyMemberships">[],
  kind: "jd" | "one_time",
  precomputedCaps?: Set<Capability>
) {
  const caps = precomputedCaps ?? (await membershipCapabilities(ctx, m));
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  if (caps.has(`${prefix}:assign:any` as Capability)) return;
  if (caps.has(`${prefix}:assign:managed` as Capability)) {
    const scoped = await getManagedMembershipIds(ctx, companyId, m._id);
    if (await hasAllManagedMemberships(ctx, companyId, m._id, assignees, scoped)) return;
  }
  if (caps.has(`${prefix}:assign:self` as Capability) && assignees.length > 0 && assignees.every((id) => id === m._id))
    return;
  throw new ConvexError("You can only assign tasks inside your allowed scope.");
}

/** Update authority that does not depend on the assignee/creator self scope. */
async function hasNonSelfTaskUpdate(
  ctx: Ctx,
  companyId: Id<"companies">,
  m: Doc<"companyMemberships">,
  targets: Id<"companyMemberships">[],
  kind: "jd" | "one_time",
  caps: Set<Capability>,
) {
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  if (caps.has(`${prefix}:update:any` as Capability)) return true;
  if (caps.has(`${prefix}:update:managed` as Capability)) {
    const scoped = await getManagedMembershipIds(ctx, companyId, m._id);
    if (await hasAllManagedMemberships(ctx, companyId, m._id, targets, scoped)) return true;
  }
  return false;
}

export async function assertCanUpdateTask(
  ctx: Ctx,
  companyId: Id<"companies">,
  m: Doc<"companyMemberships">,
  targets: Id<"companyMemberships">[],
  kind: "jd" | "one_time",
  precomputedCaps?: Set<Capability>
) {
  const caps = precomputedCaps ?? (await membershipCapabilities(ctx, m));
  if (await hasNonSelfTaskUpdate(ctx, companyId, m, targets, kind, caps)) return;
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  if (caps.has(`${prefix}:update:self` as Capability) && targets.includes(m._id)) return;
  throw new ConvexError("You cannot update this task.");
}

/**
 * Changing who confirms a task is structural, not ordinary editing: it must
 * not rely on self-scoped update authority, or an assignee could appoint
 * themselves (or clear their own approver) and self-approve their work.
 */
export async function canChangeTaskConfirmer(
  ctx: Ctx,
  companyId: Id<"companies">,
  m: Doc<"companyMemberships">,
  targets: Id<"companyMemberships">[],
  kind: "jd" | "one_time",
  precomputedCaps?: Set<Capability>
) {
  const caps = precomputedCaps ?? (await membershipCapabilities(ctx, m));
  return await hasNonSelfTaskUpdate(ctx, companyId, m, targets, kind, caps);
}

export async function assertCanChangeTaskConfirmer(
  ctx: Ctx,
  companyId: Id<"companies">,
  m: Doc<"companyMemberships">,
  targets: Id<"companyMemberships">[],
  kind: "jd" | "one_time",
  precomputedCaps?: Set<Capability>
) {
  if (!(await canChangeTaskConfirmer(ctx, companyId, m, targets, kind, precomputedCaps))) {
    throw new ConvexError("You cannot change who confirms this task.");
  }
}

export async function assertCanDeleteTask(
  ctx: Ctx,
  companyId: Id<"companies">,
  m: Doc<"companyMemberships">,
  targets: Id<"companyMemberships">[],
  kind: "jd" | "one_time",
  precomputedCaps?: Set<Capability>
) {
  const caps = precomputedCaps ?? (await membershipCapabilities(ctx, m));
  const prefix = kind === "jd" ? "tasks:jd" : "tasks:one_time";
  if (caps.has(`${prefix}:delete:any` as Capability)) return;
  if (caps.has(`${prefix}:delete:managed` as Capability)) {
    const scoped = await getManagedMembershipIds(ctx, companyId, m._id);
    if (await hasAllManagedMemberships(ctx, companyId, m._id, targets, scoped)) return;
  }
  if (caps.has(`${prefix}:delete:self` as Capability) && targets.includes(m._id)) return;
  throw new ConvexError("You do not have access to delete this task.");
}

export async function membershipBranchIds(
  ctx: Ctx,
  membershipIds: Set<Id<"companyMemberships">>,
  onTruncated?: TruncationObserver,
) {
  const branchIds = new Set<Id<"branches">>();
  const rowLists = await Promise.all([...membershipIds].map((membershipId) =>
    takeScopeRows(
      (limit) => ctx.db
        .query("userBranchAssignments")
        .withIndex("by_membershipId_and_branchId", (q) => q.eq("membershipId", membershipId))
        .take(limit),
      onTruncated,
    ),
  ));
  for (const rows of rowLists) for (const row of rows) branchIds.add(row.branchId);
  return branchIds;
}

export async function membershipDepartmentIds(
  ctx: Ctx,
  membershipIds: Set<Id<"companyMemberships">>,
  onTruncated?: TruncationObserver,
) {
  const departmentIds = new Set<Id<"departments">>();
  const rowLists = await Promise.all([...membershipIds].map((membershipId) =>
    takeScopeRows(
      (limit) => ctx.db
        .query("userDepartmentAssignments")
        .withIndex("by_membershipId_and_departmentId", (q) => q.eq("membershipId", membershipId))
        .take(limit),
      onTruncated,
    ),
  ));
  for (const rows of rowLists) for (const row of rows) departmentIds.add(row.departmentId);
  return departmentIds;
}

export type SopListRowAuth = {
  /** The viewer's own branch assignments, memoized once per list operation. */
  selfBranchIds?: () => Promise<Set<Id<"branches">>>;
  /** The viewer's own department assignments, memoized once per list operation. */
  selfDepartmentIds?: () => Promise<Set<Id<"departments">>>;
  /** Department lookup memoized per id — one get per distinct department. */
  departmentById?: (departmentId: Id<"departments">) => Promise<Doc<"departments"> | null>;
};

/**
 * Per-list memoized lookups shared by every SOP row check. Without them,
 * visibility and filter checks re-read the viewer's own assignments once per
 * SOP row on the page.
 */
export function sopListScopeAuth(ctx: Ctx, companyId: Id<"companies">, membershipId?: Id<"companyMemberships">): SopListRowAuth {
  let selfBranchIds: Promise<Set<Id<"branches">>> | undefined;
  let selfDepartmentIds: Promise<Set<Id<"departments">>> | undefined;
  const departments = new Map<Id<"departments">, Promise<Doc<"departments"> | null>>();
  return {
    departmentById: (departmentId) => {
      let cached = departments.get(departmentId);
      if (!cached) departments.set(departmentId, (cached = ctx.db.get(departmentId)));
      return cached;
    },
    ...(membershipId
      ? {
          selfBranchIds: () => (selfBranchIds ??= membershipBranchIds(ctx, new Set([membershipId]))),
          selfDepartmentIds: () => (selfDepartmentIds ??= membershipDepartmentIds(ctx, new Set([membershipId]))),
        }
      : {}),
  };
}

type SopScopeTable = "sopBranchScopes" | "sopDepartmentScopes" | "sopUserScopes";
type SopScopeRow = Doc<"sopBranchScopes"> | Doc<"sopDepartmentScopes"> | Doc<"sopUserScopes">;

function takeSopScopeRows(ctx: Ctx, table: SopScopeTable, sopId: Id<"sops">, limit: number): Promise<SopScopeRow[]> {
  switch (table) {
    case "sopBranchScopes":
      return ctx.db.query("sopBranchScopes").withIndex("by_sopId_and_branchId", (q) => q.eq("sopId", sopId)).take(limit);
    case "sopDepartmentScopes":
      return ctx.db.query("sopDepartmentScopes").withIndex("by_sopId_and_departmentId", (q) => q.eq("sopId", sopId)).take(limit);
    case "sopUserScopes":
      return ctx.db.query("sopUserScopes").withIndex("by_sopId_and_userMembershipId", (q) => q.eq("sopId", sopId)).take(limit);
  }
}

export function sopScopeRowsFor(ctx: Ctx, sopId: Id<"sops">, table: "sopBranchScopes", onTruncated?: TruncationObserver): Promise<Doc<"sopBranchScopes">[]>;
export function sopScopeRowsFor(ctx: Ctx, sopId: Id<"sops">, table: "sopDepartmentScopes", onTruncated?: TruncationObserver): Promise<Doc<"sopDepartmentScopes">[]>;
export function sopScopeRowsFor(ctx: Ctx, sopId: Id<"sops">, table: "sopUserScopes", onTruncated?: TruncationObserver): Promise<Doc<"sopUserScopes">[]>;
export async function sopScopeRowsFor(ctx: Ctx, sopId: Id<"sops">, table: SopScopeTable, onTruncated?: TruncationObserver) {
  return await takeScopeRows((limit) => takeSopScopeRows(ctx, table, sopId, limit), onTruncated);
}

export async function visibleSopForSelf(
  ctx: Ctx,
  companyId: Id<"companies">,
  m: Doc<"companyMemberships">,
  sop: Doc<"sops">,
  onTruncated?: TruncationObserver,
  auth?: SopListRowAuth,
) {
  if (sop.companyId !== companyId) return false;
  if (sop.scopeType === "company") return true;
  if (sop.scopeType === "user") {
    const rows = await sopScopeRowsFor(ctx, sop._id, "sopUserScopes", onTruncated);
    return rows.some((row) => row.userMembershipId === m._id);
  }
  if (sop.scopeType === "branch") {
    const branchIds = auth?.selfBranchIds ? await auth.selfBranchIds() : await membershipBranchIds(ctx, new Set([m._id]), onTruncated);
    const sopBranches = await sopScopeRowsFor(ctx, sop._id, "sopBranchScopes", onTruncated);
    return sopBranches.some((row) => branchIds.has(row.branchId));
  }
  const departmentIds = auth?.selfDepartmentIds ? await auth.selfDepartmentIds() : await membershipDepartmentIds(ctx, new Set([m._id]), onTruncated);
  const sopDepartments = await sopScopeRowsFor(ctx, sop._id, "sopDepartmentScopes", onTruncated);
  return sopDepartments.some((row) => departmentIds.has(row.departmentId));
}

export type SopVisibilityContext = {
  scopedMembershipIds: Set<Id<"companyMemberships">>;
  membershipBranchIds: Set<Id<"branches">>;
  membershipDepartmentIds: Set<Id<"departments">>;
  managerBranchScopes: Set<Id<"branches">>;
  managerDepartmentScopes: Set<Id<"departments">>;
};

export async function buildSopVisibilityContext(
  ctx: Ctx,
  companyId: Id<"companies">,
  m: Doc<"companyMemberships">,
  precomputedCaps?: Set<Capability>,
  onTruncated?: TruncationObserver,
): Promise<SopVisibilityContext | null> {
  const caps = precomputedCaps ?? (await membershipCapabilities(ctx, m));
  const canSeeManaged =
    caps.has("sops:view:managed") ||
    caps.has("sops:manage:branch") ||
    caps.has("sops:manage:department") ||
    caps.has("sops:manage:user") ||
    caps.has("sops:delete:branch") ||
    caps.has("sops:delete:department") ||
    caps.has("sops:delete:user");
  if (!canSeeManaged) return null;
  const scoped = await getManagedMembershipIds(ctx, companyId, m._id, onTruncated);
  const [membershipBranchSet, membershipDepartmentSet, managedBranches, managedDepartments] = await Promise.all([
    membershipBranchIds(ctx, scoped, onTruncated),
    membershipDepartmentIds(ctx, scoped, onTruncated),
    takeScopeRows(
      (limit) => ctx.db
        .query("managerBranchScopes")
        .withIndex("by_managerMembershipId_and_branchId", (q) => q.eq("managerMembershipId", m._id))
        .take(limit),
      onTruncated,
    ),
    takeScopeRows(
      (limit) => ctx.db
        .query("managerDepartmentScopes")
        .withIndex("by_managerMembershipId_and_departmentId", (q) => q.eq("managerMembershipId", m._id))
        .take(limit),
      onTruncated,
    ),
  ]);
  return {
    scopedMembershipIds: scoped,
    membershipBranchIds: membershipBranchSet,
    membershipDepartmentIds: membershipDepartmentSet,
    managerBranchScopes: new Set(managedBranches.map((row) => row.branchId)),
    managerDepartmentScopes: new Set(managedDepartments.map((row) => row.departmentId)),
  };
}

export async function visibleSop(
  ctx: Ctx,
  companyId: Id<"companies">,
  m: Doc<"companyMemberships">,
  sop: Doc<"sops">,
  visibility?: SopVisibilityContext | null,
  precomputedCaps?: Set<Capability>,
  onTruncated?: TruncationObserver,
  auth?: SopListRowAuth,
) {
  if (sop.companyId !== companyId) return false;
  const caps = precomputedCaps ?? (await membershipCapabilities(ctx, m));
  if (caps.has("sops:view:company")) return true;
  if (caps.has("sops:view:managed")) {
    if (sop.scopeType === "company") return true;
    const v = visibility ?? (await buildSopVisibilityContext(ctx, companyId, m, caps, onTruncated));
    if (v) {
      if (sop.scopeType === "user") {
        const rows = await sopScopeRowsFor(ctx, sop._id, "sopUserScopes", onTruncated);
        if (rows.some((row) => v.scopedMembershipIds.has(row.userMembershipId))) return true;
      } else if (sop.scopeType === "branch") {
        const sopBranches = await sopScopeRowsFor(ctx, sop._id, "sopBranchScopes", onTruncated);
        if (sopBranches.some((row) => v.membershipBranchIds.has(row.branchId) || v.managerBranchScopes.has(row.branchId)))
          return true;
      } else if (sop.scopeType === "department") {
        const sopDepartments = await sopScopeRowsFor(ctx, sop._id, "sopDepartmentScopes", onTruncated);
        for (const row of sopDepartments) {
          if (v.membershipDepartmentIds.has(row.departmentId) || v.managerDepartmentScopes.has(row.departmentId))
            return true;
          const department = auth?.departmentById ? await auth.departmentById(row.departmentId) : await ctx.db.get(row.departmentId);
          if (department?.companyId === companyId && v.managerBranchScopes.has(department.branchId)) return true;
        }
      }
    }
  }
  if (caps.has("sops:view:self")) {
    return await visibleSopForSelf(ctx, companyId, m, sop, onTruncated, auth);
  }
  return false;
}

export function sopDeleteCapability(scopeType: Doc<"sops">["scopeType"]): Capability {
  return scopeType === "company"
    ? "sops:delete:company"
    : scopeType === "branch"
    ? "sops:delete:branch"
    : scopeType === "department"
    ? "sops:delete:department"
    : "sops:delete:user";
}

export function sopManageCapability(scopeType: Doc<"sops">["scopeType"]): Capability {
  return scopeType === "company"
    ? "sops:manage:company"
    : scopeType === "branch"
    ? "sops:manage:branch"
    : scopeType === "department"
    ? "sops:manage:department"
    : "sops:manage:user";
}
