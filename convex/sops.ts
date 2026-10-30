import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { mutation } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import type { Capability } from "../src/lib/permissions";
import { sopListOrderLimit, sopListOrderMaxSerializedBytes } from "../src/lib/sop-list-sort";
import { sopListPreferenceResultValidator, sopListSortValidator } from "./sopListPreferences";
import schema from "./schema";
import { assertCapability, buildSopVisibilityContext, getManagedMembershipIds, memberFirstName, memberFullName, membershipCapabilities, requireCapability, requireMembership, scopedMembershipIds, sopDeleteCapability, sopListScopeAuth, sopManageCapability, sopScopeRowsFor, visibleSop, visibleSopForSelf, type SopListRowAuth, type SopVisibilityContext } from "./permissions";
import { nonEmpty } from "./validation";
import { nextReference } from "./references";
import { scanUntil } from "./queryLimits";
import { paletteSearchInput, searchPaletteRows } from "./searchText";


async function assertTargets(ctx: any, companyId: Id<"companies">, args: { branchIds: Id<"branches">[]; departmentIds: Id<"departments">[]; userMembershipIds: Id<"companyMemberships">[] }) {
  for (const branchId of args.branchIds) { const branch = await ctx.db.get(branchId); if (!branch || branch.companyId !== companyId) throw new ConvexError("Branch not found."); }
  for (const departmentId of args.departmentIds) { const department = await ctx.db.get(departmentId); if (!department || department.companyId !== companyId) throw new ConvexError("Department not found."); }
  for (const membershipId of args.userMembershipIds) { const membership = await ctx.db.get(membershipId); if (!membership || membership.companyId !== companyId || !membership.active) throw new ConvexError("User not found."); }
}

async function getManagedScopeTargets(ctx: MutationCtx | QueryCtx, companyId: Id<"companies">, membership: Doc<"companyMemberships">, caps?: Set<Capability>) {
  const capabilities = caps ?? (await membershipCapabilities(ctx, membership));
  if (capabilities.has("sops:manage:company")) return null;
  const [managedBranches, userIds, managedDepartments] = await Promise.all([
    ctx.db.query("managerBranchScopes").withIndex("by_managerMembershipId_and_branchId", (q) => q.eq("managerMembershipId", membership._id)).take(500),
    getManagedMembershipIds(ctx, companyId, membership._id),
    ctx.db.query("managerDepartmentScopes").withIndex("by_managerMembershipId_and_departmentId", (q) => q.eq("managerMembershipId", membership._id)).take(500),
  ]);
  const branchIds = new Set<Id<"branches">>(managedBranches.map((row) => row.branchId));
  // Assignment-derived branches must join branchIds before the department
  // queries run — departments are loaded per branch, so a branch added later
  // would contribute no departments.
  const assignmentLists = await Promise.all([...userIds].map((userId) => ctx.db.query("userBranchAssignments").withIndex("by_membershipId_and_branchId", (q) => q.eq("membershipId", userId)).take(500)));
  for (const assignments of assignmentLists) {
    for (const assignment of assignments) branchIds.add(assignment.branchId);
  }
  const departmentLists = await Promise.all([...branchIds].map((branchId) => ctx.db.query("departments").withIndex("by_branch", (q) => q.eq("branchId", branchId)).take(500)));
  const departmentIds = new Set<Id<"departments">>(managedDepartments.map((row) => row.departmentId));
  for (const departments of departmentLists) {
    for (const department of departments) if (department.companyId === companyId) departmentIds.add(department._id);
  }
  return { branchIds, departmentIds, userIds };
}

type SopManagedTargets = Awaited<ReturnType<typeof getManagedScopeTargets>>;
type SopListAuth = SopListRowAuth & { managedTargets: () => Promise<SopManagedTargets> };

function sopListAuth(ctx: MutationCtx | QueryCtx, companyId: Id<"companies">, membership: Doc<"companyMemberships">, caps: Set<Capability>): SopListAuth {
  let managedTargets: Promise<SopManagedTargets> | undefined;
  return {
    ...sopListScopeAuth(ctx, companyId, membership._id),
    managedTargets: () => (managedTargets ??= getManagedScopeTargets(ctx, companyId, membership, caps)),
  };
}

async function assertManagedTargets(ctx: MutationCtx | QueryCtx, companyId: Id<"companies">, membership: Doc<"companyMemberships">, args: { branchIds: Id<"branches">[]; departmentIds: Id<"departments">[]; userMembershipIds: Id<"companyMemberships">[] }, caps?: Set<Capability>) {
  const managed = await getManagedScopeTargets(ctx, companyId, membership, caps);
  if (!managed) return;
  for (const branchId of args.branchIds) if (!managed.branchIds.has(branchId)) throw new ConvexError("You can only target branches in your managed scope.");
  for (const departmentId of args.departmentIds) if (!managed.departmentIds.has(departmentId)) throw new ConvexError("You can only target departments in your managed scope.");
  for (const userId of args.userMembershipIds) if (!managed.userIds.has(userId)) throw new ConvexError("You can only target users in your managed scope.");
}

function assertScopeSelection(args: { scopeType: "company" | "branch" | "department" | "user"; branchIds: Id<"branches">[]; departmentIds: Id<"departments">[]; userMembershipIds: Id<"companyMemberships">[] }) {
  if (args.scopeType === "company" && (args.branchIds.length || args.departmentIds.length || args.userMembershipIds.length)) throw new ConvexError("Company-wide SOPs cannot target a branch, department, or user.");
  if (args.scopeType === "branch" && (args.branchIds.length !== 1 || args.departmentIds.length || args.userMembershipIds.length)) throw new ConvexError("Select one branch for branch scope.");
  if (args.scopeType === "department" && (args.departmentIds.length !== 1 || args.branchIds.length || args.userMembershipIds.length)) throw new ConvexError("Select one department for department scope.");
  if (args.scopeType === "user" && (args.userMembershipIds.length !== 1 || args.branchIds.length || args.departmentIds.length)) throw new ConvexError("Select one user for user scope.");
}

async function canManageSopTargets(
  ctx: MutationCtx | QueryCtx,
  companyId: Id<"companies">,
  membership: Doc<"companyMemberships">,
  scopeType: Doc<"sops">["scopeType"],
  targets: { branchIds: Id<"branches">[]; departmentIds: Id<"departments">[]; userMembershipIds: Id<"companyMemberships">[] },
  caps: Set<Capability>,
  managedTargets?: () => Promise<SopManagedTargets>
): Promise<boolean> {
  const reqCap = sopManageCapability(scopeType);
  if (!caps.has(reqCap)) return false;
  if (scopeType === "company") return true;
  const managed = await (managedTargets ? managedTargets() : getManagedScopeTargets(ctx, companyId, membership, caps));
  if (!managed) return true;
  for (const b of targets.branchIds) if (!managed.branchIds.has(b)) return false;
  for (const d of targets.departmentIds) if (!managed.departmentIds.has(d)) return false;
  for (const u of targets.userMembershipIds) if (!managed.userIds.has(u)) return false;
  return true;
}

async function canDeleteSopTargets(
  ctx: MutationCtx | QueryCtx,
  companyId: Id<"companies">,
  membership: Doc<"companyMemberships">,
  scopeType: Doc<"sops">["scopeType"],
  targets: { branchIds: Id<"branches">[]; departmentIds: Id<"departments">[]; userMembershipIds: Id<"companyMemberships">[] },
  caps: Set<Capability>,
  managedTargets?: () => Promise<SopManagedTargets>
): Promise<boolean> {
  const reqCap = sopDeleteCapability(scopeType);
  if (!caps.has(reqCap)) return false;
  if (scopeType === "company") return true;
  const managed = await (managedTargets ? managedTargets() : getManagedScopeTargets(ctx, companyId, membership, caps));
  if (!managed) return true;
  for (const b of targets.branchIds) if (!managed.branchIds.has(b)) return false;
  for (const d of targets.departmentIds) if (!managed.departmentIds.has(d)) return false;
  for (const u of targets.userMembershipIds) if (!managed.userIds.has(u)) return false;
  return true;
}
const sopViewValidator = v.union(v.literal("all"), v.literal("my"));
const sopScopeFilterValidator = v.union(v.literal("all"), v.literal("company"), v.literal("branch"), v.literal("department"), v.literal("user"));
async function deleteScopeRows(ctx: any, sopId: Id<"sops">) {
  while (true) {
    const rows = await ctx.db.query("sopBranchScopes").withIndex("by_sopId_and_branchId", (q: any) => q.eq("sopId", sopId)).take(500);
    if (!rows.length) break;
    for (const row of rows) await ctx.db.delete(row._id);
  }
  while (true) {
    const rows = await ctx.db.query("sopDepartmentScopes").withIndex("by_sopId_and_departmentId", (q: any) => q.eq("sopId", sopId)).take(500);
    if (!rows.length) break;
    for (const row of rows) await ctx.db.delete(row._id);
  }
  while (true) {
    const rows = await ctx.db.query("sopUserScopes").withIndex("by_sopId_and_userMembershipId", (q: any) => q.eq("sopId", sopId)).take(500);
    if (!rows.length) break;
    for (const row of rows) await ctx.db.delete(row._id);
  }
}
async function insertScopeRows(ctx: MutationCtx, companyId: Id<"companies">, sopId: Id<"sops">, args: { branchIds: Id<"branches">[]; departmentIds: Id<"departments">[]; userMembershipIds: Id<"companyMemberships">[] }) {
  for (const branchId of args.branchIds) await ctx.db.insert("sopBranchScopes", { companyId, sopId, branchId });
  for (const departmentId of args.departmentIds) await ctx.db.insert("sopDepartmentScopes", { companyId, sopId, departmentId });
  for (const userMembershipId of args.userMembershipIds) await ctx.db.insert("sopUserScopes", { companyId, sopId, userMembershipId });
}
async function withScopes(ctx: QueryCtx, sop: Doc<"sops">, membership: Doc<"companyMemberships">, companyName?: string, precomputedCaps?: Set<Capability>, auth?: SopListAuth) {
  const [branchScopeRows, departmentScopeRows, userScopeRows] = await Promise.all([
    sopScopeRowsFor(ctx, sop._id, "sopBranchScopes"),
    sopScopeRowsFor(ctx, sop._id, "sopDepartmentScopes"),
    sopScopeRowsFor(ctx, sop._id, "sopUserScopes"),
  ]);
  const branchIds = branchScopeRows.map((row) => row.branchId);
  const departmentIds = departmentScopeRows.map((row) => row.departmentId);
  const userMembershipIds = userScopeRows.map((row) => row.userMembershipId);
  let scopeTargetName = companyName ?? "Company";
  let scopeTargetUser: { firstName: string; name: string; imageUrl: string | null } | null = null;
  if (sop.scopeType === "branch") {
    const branch = branchIds[0] ? await ctx.db.get(branchIds[0]) : null;
    scopeTargetName = branch?.companyId === sop.companyId ? branch.name : "Unknown branch";
  } else if (sop.scopeType === "department") {
    const department = departmentIds[0]
      ? await (auth?.departmentById ? auth.departmentById(departmentIds[0]) : ctx.db.get(departmentIds[0]))
      : null;
    scopeTargetName = department?.companyId === sop.companyId ? department.name : "Unknown department";
  } else if (sop.scopeType === "user") {
    const userMembership = userMembershipIds[0] ? await ctx.db.get(userMembershipIds[0]) : null;
    const user = userMembership?.companyId === sop.companyId ? await ctx.db.get(userMembership.userId) : null;
    if (user) {
      scopeTargetName = memberFullName(userMembership, user);
      scopeTargetUser = { firstName: memberFirstName(userMembership, user), name: scopeTargetName, imageUrl: user.imageUrl ?? null };
    } else {
      scopeTargetName = "Unknown user";
    }
  }
  const caps = precomputedCaps ?? (await membershipCapabilities(ctx, membership));
  const managedTargets = auth?.managedTargets;
  const [canUpdate, canDelete] = await Promise.all([
    canManageSopTargets(ctx, sop.companyId, membership, sop.scopeType, { branchIds, departmentIds, userMembershipIds }, caps, managedTargets),
    canDeleteSopTargets(ctx, sop.companyId, membership, sop.scopeType, { branchIds, departmentIds, userMembershipIds }, caps, managedTargets),
  ]);
  return { ...sop, branchIds, departmentIds, userMembershipIds, scopeTargetName, scopeTargetUser, canUpdate, canDelete };
}

async function sopMatchesFilters(ctx: QueryCtx, sop: Doc<"sops">, args: { scope?: "all" | Doc<"sops">["scopeType"]; branchId?: Id<"branches">; userMembershipId?: Id<"companyMemberships"> }, auth?: SopListRowAuth) {
  if (args.scope && args.scope !== "all" && sop.scopeType !== args.scope) return false;
  if (args.branchId) {
    if (sop.scopeType === "branch") {
      const rows = await sopScopeRowsFor(ctx, sop._id, "sopBranchScopes");
      if (!rows.some((row) => row.branchId === args.branchId)) return false;
    } else if (sop.scopeType === "department") {
      const rows = await sopScopeRowsFor(ctx, sop._id, "sopDepartmentScopes");
      let matchesBranch = false;
      for (const row of rows) {
        const department = auth?.departmentById ? await auth.departmentById(row.departmentId) : await ctx.db.get(row.departmentId);
        if (department?.companyId === sop.companyId && department.branchId === args.branchId) matchesBranch = true;
      }
      if (!matchesBranch) return false;
    } else {
      return false;
    }
  }
  if (args.userMembershipId) {
    const rows = await sopScopeRowsFor(ctx, sop._id, "sopUserScopes");
    if (!rows.some((row) => row.userMembershipId === args.userMembershipId)) return false;
  }
  return true;
}

async function sopVisibleForView(ctx: QueryCtx, companyId: Id<"companies">, membership: Doc<"companyMemberships">, sop: Doc<"sops">, view: "all" | "my" | undefined, visibility: SopVisibilityContext | null, caps: Set<Capability>, canUseAllView: boolean, auth?: SopListRowAuth) {
  if (view === "all" && canUseAllView) return await visibleSop(ctx, companyId, membership, sop, visibility, caps, undefined, auth);
  if (!caps.has("sops:view:self")) return false;
  return await visibleSopForSelf(ctx, companyId, membership, sop, undefined, auth);
}

// Page size for the legacy scan-until-filled path; scans continue until the
// requested count is collected or the company index is exhausted, so sparse
// matches beyond the first page are not silently dropped. A total ceiling
// keeps the single-transaction query under Convex read limits — hitting it
// fails loudly rather than silently returning partial results.
const FILTERED_SOP_SCAN_CEILING = 1000;

async function filteredSopRows(ctx: QueryCtx, args: { companyId: Id<"companies">; search?: string; view?: "all" | "my"; scope?: "all" | Doc<"sops">["scopeType"]; branchId?: Id<"branches">; userMembershipId?: Id<"companyMemberships">; limit: number }) {
  const { membership, capabilities: caps } = await requireMembership(ctx, args.companyId);
  const company = await ctx.db.get(args.companyId);
  const visibility = await buildSopVisibilityContext(ctx, args.companyId, membership, caps);
  const auth = sopListAuth(ctx, args.companyId, membership, caps);
  const canUseAllView = caps.has("sops:view:company") || caps.has("sops:view:managed");
  const search = args.search?.trim().toLowerCase();
  const { kept, exhausted } = await scanUntil(
    ctx.db.query("sops").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc"),
    FILTERED_SOP_SCAN_CEILING,
    args.limit,
    async (sop) => {
      if (search && !sop.reference.toLowerCase().includes(search) && !sop.title.toLowerCase().includes(search) && !sop.content.toLowerCase().includes(search)) return false;
      if (!(await sopVisibleForView(ctx, args.companyId, membership, sop, args.view, visibility, caps, canUseAllView, auth))) return false;
      if (!(await sopMatchesFilters(ctx, sop, args, auth))) return false;
      return true;
    },
  );
  // A short result after an exhausted index is legitimate; only a scan cut off
  // by the ceiling is an incomplete result worth failing loudly on.
  if (!exhausted && kept.length < args.limit) {
    throw new ConvexError("Too many SOPs to scan. Narrow the filters or use the paginated list endpoint.");
  }
  return await Promise.all(kept.map((sop) => withScopes(ctx, sop, membership, company?.name, caps, auth)));
}

export const list = query({
  args: { companyId: v.id("companies"), search: v.optional(v.string()), view: v.optional(sopViewValidator), scope: v.optional(sopScopeFilterValidator), branchId: v.optional(v.id("branches")), userMembershipId: v.optional(v.id("companyMemberships")), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const { membership, capabilities: caps } = await requireMembership(ctx, args.companyId);
    const company = await ctx.db.get(args.companyId);
    const visibility = await buildSopVisibilityContext(ctx, args.companyId, membership, caps);
    const canUseAllView = caps.has("sops:view:company") || caps.has("sops:view:managed");
    const auth = sopListAuth(ctx, args.companyId, membership, caps);
    // Visibility/search filtering happens after database pagination, so pages may contain fewer items than requested; continuation tokens still advance correctly.
    const page = await ctx.db.query("sops").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").paginate(args.paginationOpts);
    const search = args.search?.trim().toLowerCase();
    const keepFlags = await Promise.all(page.page.map(async (sop) => {
      if (!(await sopVisibleForView(ctx, args.companyId, membership, sop, args.view, visibility, caps, canUseAllView, auth))) return false;
      if (!(await sopMatchesFilters(ctx, sop, args, auth))) return false;
      if (search && !sop.reference.toLowerCase().includes(search) && !sop.title.toLowerCase().includes(search) && !sop.content.toLowerCase().includes(search)) return false;
      return true;
    }));
    const kept = page.page.filter((_, index) => keepFlags[index]);
    const out = await Promise.all(kept.map((sop) => withScopes(ctx, sop, membership, company?.name, caps, auth)));
    return { ...page, page: out };
  },
});

export const listRows = query({
  args: { companyId: v.id("companies"), search: v.optional(v.string()), view: v.optional(sopViewValidator), scope: v.optional(sopScopeFilterValidator), branchId: v.optional(v.id("branches")), userMembershipId: v.optional(v.id("companyMemberships")) },
  handler: async (ctx, args) => await filteredSopRows(ctx, { ...args, limit: 200 }),
});

// Full content is deliberately excluded from list rows: the list only needs it
// for search, which the server-side search_content index now handles.
const { content: _sopContentField, ...sopOrderingSopFields } = schema.tables.sops.validator.fields;
const sopOrderingRowValidator = v.object({
  _id: v.id("sops"),
  _creationTime: v.number(),
  ...sopOrderingSopFields,
  branchIds: v.array(v.id("branches")),
  departmentIds: v.array(v.id("departments")),
  userMembershipIds: v.array(v.id("companyMemberships")),
  scopeTargetName: v.string(),
  scopeTargetUser: v.union(
    v.object({ firstName: v.string(), name: v.string(), imageUrl: v.union(v.string(), v.null()) }),
    v.null(),
  ),
  canUpdate: v.boolean(),
  canDelete: v.boolean(),
  matchesMyView: v.boolean(),
  filterBranchIds: v.array(v.id("branches")),
});

// The list sorts and orders SOPs in the browser, so it reads every authorized SOP through
// bounded pages and filters locally instead of letting the server drop rows it never saw.
export const listOrderingRows = query({
  args: { companyId: v.id("companies"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(sopOrderingRowValidator),
  handler: async (ctx, args) => {
    const { membership, capabilities: caps } = await requireMembership(ctx, args.companyId);
    const company = await ctx.db.get(args.companyId);
    const visibility = await buildSopVisibilityContext(ctx, args.companyId, membership, caps);
    const auth = sopListAuth(ctx, args.companyId, membership, caps);
    const page = await ctx.db.query("sops").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").paginate(args.paginationOpts);
    const visibleFlags = await Promise.all(page.page.map((sop) => visibleSop(ctx, args.companyId, membership, sop, visibility, caps, undefined, auth)));
    const visibleSops = page.page.filter((_, index) => visibleFlags[index]);
    const [rows, myViewFlags] = await Promise.all([
      Promise.all(visibleSops.map((sop) => withScopes(ctx, sop, membership, company?.name, caps, auth))),
      Promise.all(visibleSops.map((sop) => visibleSopForSelf(ctx, args.companyId, membership, sop, undefined, auth))),
    ]);
    const departmentIds = new Set<Id<"departments">>();
    for (let index = 0; index < visibleSops.length; index += 1) {
      if (visibleSops[index].scopeType === "department") for (const departmentId of rows[index].departmentIds) departmentIds.add(departmentId);
    }
    const departmentDocs = (await Promise.all([...departmentIds].map((departmentId) => auth.departmentById ? auth.departmentById(departmentId) : ctx.db.get(departmentId)))).filter(Boolean) as Doc<"departments">[];
    const departmentBranches = new Map(departmentDocs.map((department) => [department._id, department.companyId === args.companyId ? department.branchId : null]));
    const authorizedRows = visibleSops.map((sop, index) => {
      const { content: _content, ...row } = rows[index];
      const filterBranchIds: Id<"branches">[] = [];
      if (sop.scopeType === "branch") {
        filterBranchIds.push(...row.branchIds);
      } else if (sop.scopeType === "department") {
        for (const departmentId of row.departmentIds) {
          const branchId = departmentBranches.get(departmentId) ?? null;
          if (branchId) filterBranchIds.push(branchId);
        }
      }
      return {
        ...row,
        // The self capability is checked here because visibleSopForSelf alone does not enforce it.
        matchesMyView: caps.has("sops:view:self") && myViewFlags[index],
        filterBranchIds,
      };
    });
    return { ...page, page: authorizedRows };
  },
});

/**
 * Server-side content search over the sops search index, so the browser list no
 * longer needs every SOP's full content to answer a body-text query.
 */
const CONTENT_SEARCH_TARGET = 100;
const CONTENT_SEARCH_SCAN_BUDGET = 500;

// Full-text hits arrive ranked by the index before any visibility filtering,
// so keep paging until enough *visible* matches collect or the scan budget
// ends — a first page of inaccessible hits must not hide real matches.
async function visibleContentMatches(
  ctx: MutationCtx | QueryCtx,
  companyId: Id<"companies">,
  needle: string,
  membership: Doc<"companyMemberships">,
  caps: Set<Capability>,
  visibility: SopVisibilityContext | null,
  target: number,
  budget: number,
  auth?: SopListRowAuth,
) {
  const { kept, exhausted } = await scanUntil(
    ctx.db.query("sops").withSearchIndex("search_content", (q) => q.search("content", needle).eq("companyId", companyId)),
    budget,
    target,
    async (sop) => await visibleSop(ctx, companyId, membership, sop, visibility, caps, undefined, auth),
  );
  return { sops: kept, exhausted };
}

export const contentSearchIds = query({
  args: { companyId: v.id("companies"), query: v.string() },
  returns: v.object({ ids: v.array(v.id("sops")), truncated: v.boolean() }),
  handler: async (ctx, args) => {
    const { membership, capabilities: caps } = await requireMembership(ctx, args.companyId);
    const needle = args.query.trim();
    if (!needle) return { ids: [], truncated: false };
    const visibility = await buildSopVisibilityContext(ctx, args.companyId, membership, caps);
    const auth = sopListAuth(ctx, args.companyId, membership, caps);
    const { sops, exhausted } = await visibleContentMatches(ctx, args.companyId, needle, membership, caps, visibility, CONTENT_SEARCH_TARGET, CONTENT_SEARCH_SCAN_BUDGET, auth);
    return { ids: sops.map((sop) => sop._id), truncated: !exhausted };
  },
});

// Only indexed title matches or the requested reference range are considered.
export const search = query({
  args: { companyId: v.id("companies"), query: v.string() },
  returns: v.object({
    sops: v.array(v.object({ _id: v.id("sops"), reference: v.string(), title: v.string(), scopeType: v.string() })),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const input = paletteSearchInput(args.query);
    if (!input) return { sops: [], truncated: false };
    const { membership, capabilities: caps } = await requireMembership(ctx, args.companyId);
    if (!["sops:view:company", "sops:view:managed", "sops:view:self"].some((capability) => caps.has(capability as Capability))) {
      return { sops: [], truncated: false };
    }
    const visibility = await buildSopVisibilityContext(ctx, args.companyId, membership, caps);
    const auth = sopListAuth(ctx, args.companyId, membership, caps);
    const isVisible = async (sop: Doc<"sops">) => await visibleSop(ctx, args.companyId, membership, sop, visibility, caps, undefined, auth);
    const toRow = (sop: Doc<"sops">) => ({ _id: sop._id, reference: sop.reference, title: sop.title, scopeType: sop.scopeType });
    const { rows, truncated } = await searchPaletteRows(ctx, {
      input,
      prefixes: ["SOP"],
      byReference: (prefix) => ctx.db.query("sops").withIndex("by_companyId_and_reference", (q) => q.eq("companyId", args.companyId).gte("reference", prefix).lt("reference", `${prefix}\uffff`)),
      byTitle: (title) => ctx.db.query("sops").withSearchIndex("search_title", (q) => q.search("title", title).eq("companyId", args.companyId)),
      isVisible,
    });
    return { sops: rows.map(toRow), truncated };
  },
});

async function getSopListPreference(ctx: QueryCtx | MutationCtx, companyId: Id<"companies">, membershipId: Id<"companyMemberships">) {
  return await ctx.db
    .query("sopListPreferences")
    .withIndex("by_companyId_and_membershipId", (q) => q.eq("companyId", companyId).eq("membershipId", membershipId))
    .unique();
}

function sopListPreferenceResult(preference: Doc<"sopListPreferences"> | null) {
  return {
    sort: preference?.sort ?? { mode: "default" as const },
    customOrder: preference?.customOrder ?? null,
    revision: preference?.revision ?? 0,
    updatedAt: preference?.updatedAt ?? null,
  };
}

function assertExpectedSopPreferenceRevision(preference: Doc<"sopListPreferences"> | null, expectedRevision: number) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new ConvexError("SOP list preference revision is invalid.");
  }
  if ((preference?.revision ?? 0) !== expectedRevision) {
    throw new ConvexError("SOP list preference was updated. Refresh and try again.");
  }
}

function assertSopListOrderInput(orderedIds: Id<"sops">[]) {
  if (orderedIds.length > sopListOrderLimit) {
    throw new ConvexError(`SOP list order can contain at most ${sopListOrderLimit} SOPs.`);
  }
  if (new Set(orderedIds).size !== orderedIds.length) {
    throw new ConvexError("SOP list order contains duplicate SOP IDs.");
  }
  if (JSON.stringify(orderedIds).length > sopListOrderMaxSerializedBytes) {
    throw new ConvexError("SOP list order is too large to save.");
  }
}

// Concurrently created SOPs are appended by restoration, so the vector only has to be accessible.
async function validateSopListOrder(
  ctx: MutationCtx,
  companyId: Id<"companies">,
  membership: Doc<"companyMemberships">,
  orderedIds: Id<"sops">[],
  precomputedCaps?: Set<Capability>,
) {
  const caps = precomputedCaps ?? (await membershipCapabilities(ctx, membership));
  const visibility = await buildSopVisibilityContext(ctx, companyId, membership, caps);
  const auth = sopListAuth(ctx, companyId, membership, caps);
  for (const sopId of orderedIds) {
    const sop = await ctx.db.get(sopId);
    if (!sop || sop.companyId !== companyId || !(await visibleSop(ctx, companyId, membership, sop, visibility, caps, undefined, auth))) {
      throw new ConvexError("SOP not found.");
    }
  }
  return orderedIds;
}

export const getListPreference = query({
  args: { companyId: v.id("companies") },
  returns: sopListPreferenceResultValidator,
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    return sopListPreferenceResult(await getSopListPreference(ctx, args.companyId, membership._id));
  },
});

export const setListSort = mutation({
  args: { companyId: v.id("companies"), sort: sopListSortValidator, expectedRevision: v.number() },
  returns: sopListPreferenceResultValidator,
  handler: async (ctx, args) => {
    const { membership } = await requireMembership(ctx, args.companyId);
    const preference = await getSopListPreference(ctx, args.companyId, membership._id);
    assertExpectedSopPreferenceRevision(preference, args.expectedRevision);
    const now = Date.now();
    const revision = args.expectedRevision + 1;
    let preferenceId: Id<"sopListPreferences">;
    if (preference) {
      await ctx.db.patch(preference._id, { sort: args.sort, revision, updatedAt: now });
      preferenceId = preference._id;
    } else {
      preferenceId = await ctx.db.insert("sopListPreferences", {
        companyId: args.companyId,
        membershipId: membership._id,
        sort: args.sort,
        revision,
        updatedAt: now,
      });
    }
    const saved = await ctx.db.get(preferenceId);
    if (!saved) throw new ConvexError("SOP list preference was not saved.");
    return sopListPreferenceResult(saved);
  },
});

export const saveListOrder = mutation({
  args: { companyId: v.id("companies"), orderedIds: v.array(v.id("sops")), expectedRevision: v.number() },
  returns: sopListPreferenceResultValidator,
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    assertSopListOrderInput(args.orderedIds);
    const preference = await getSopListPreference(ctx, args.companyId, membership._id);
    assertExpectedSopPreferenceRevision(preference, args.expectedRevision);
    const customOrder = await validateSopListOrder(ctx, args.companyId, membership, args.orderedIds, capabilities);
    const now = Date.now();
    const revision = args.expectedRevision + 1;
    let preferenceId: Id<"sopListPreferences">;
    if (preference) {
      await ctx.db.patch(preference._id, { sort: { mode: "custom" }, customOrder, revision, updatedAt: now });
      preferenceId = preference._id;
    } else {
      preferenceId = await ctx.db.insert("sopListPreferences", {
        companyId: args.companyId,
        membershipId: membership._id,
        sort: { mode: "custom" },
        customOrder,
        revision,
        updatedAt: now,
      });
    }
    const saved = await ctx.db.get(preferenceId);
    if (!saved) throw new ConvexError("SOP list preference was not saved.");
    return sopListPreferenceResult(saved);
  },
});

export const get = query({ args: { companyId: v.id("companies"), sopId: v.id("sops") }, handler: async (ctx, args) => { const { membership, capabilities: caps } = await requireMembership(ctx, args.companyId); const sop = await ctx.db.get(args.sopId); if (!sop || sop.companyId !== args.companyId || !(await visibleSop(ctx, args.companyId, membership, sop, undefined, caps))) throw new ConvexError("SOP not found."); const company = await ctx.db.get(args.companyId); return await withScopes(ctx, sop, membership, company?.name, caps); } });

const scopeOptionCapabilities: Capability[] = ["sops:manage:branch", "sops:manage:department", "sops:manage:user"];

export const scopeOptions = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    if (!scopeOptionCapabilities.some((capability) => capabilities.has(capability))) throw new ConvexError("You do not have access to do that.");
    const canUseBranch = capabilities.has("sops:manage:branch");
    const canUseDepartment = capabilities.has("sops:manage:department");
    const canUseUser = capabilities.has("sops:manage:user");
    const [branches, departments, memberships] = await Promise.all([
      canUseBranch || canUseDepartment ? ctx.db.query("branches").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500) : Promise.resolve([]),
      canUseDepartment ? ctx.db.query("departments").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500) : Promise.resolve([]),
      canUseUser ? ctx.db.query("companyMemberships").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500) : Promise.resolve([]),
    ]);
    const managed = await getManagedScopeTargets(ctx, args.companyId, membership, capabilities);
    const scopedBranches = canUseBranch ? (managed ? branches.filter((branch) => managed.branchIds.has(branch._id)) : branches) : [];
    const scopedDepartments = managed ? departments.filter((department) => managed.departmentIds.has(department._id)) : departments;
    const branchNames = new Map(branches.map((branch) => [branch._id, branch.name]));
    const activeMemberships = memberships.filter((m) => m.active && (!managed || managed.userIds.has(m._id)));
    const userRows = await Promise.all(activeMemberships.map(async (membership) => ({ membership, user: await ctx.db.get(membership.userId) })));
    const users = [];
    for (const { membership, user } of userRows) {
      if (user) users.push({ membership: { _id: membership._id, role: membership.role }, user: { name: memberFullName(membership, user), firstName: memberFirstName(membership, user), imageUrl: user.imageUrl ?? null } });
    }
    return {
      branches: scopedBranches.map((branch) => ({ _id: branch._id, name: branch.name })),
      departments: scopedDepartments.map((department) => ({ _id: department._id, name: department.name, branchId: department.branchId, branchName: branchNames.get(department.branchId) ?? "Unknown branch" })),
      users,
    };
  },
});

export const filterOptions = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const { membership, capabilities: caps } = await requireMembership(ctx, args.companyId);
    const canFilterManaged = caps.has("sops:view:company") || caps.has("sops:view:managed") || caps.has("sops:manage:company") || caps.has("sops:manage:branch") || caps.has("sops:manage:department") || caps.has("sops:manage:user");
    if (!canFilterManaged) return { branches: [], departments: [], users: [] };

    const branchIds = new Set<Id<"branches">>();
    const departmentIds = new Set<Id<"departments">>();
    let userIds: Set<Id<"companyMemberships">>;
    if (caps.has("sops:view:company") || caps.has("sops:manage:company")) {
      const [branches, departments, memberships] = await Promise.all([
        ctx.db.query("branches").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500),
        ctx.db.query("departments").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500),
        ctx.db.query("companyMemberships").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(500),
      ]);
      for (const branch of branches) branchIds.add(branch._id);
      for (const department of departments) departmentIds.add(department._id);
      userIds = new Set(memberships.filter((m) => m.active).map((m) => m._id));
    } else {
      const managed = await getManagedScopeTargets(ctx, args.companyId, membership, caps);
      userIds = managed?.userIds ?? await scopedMembershipIds(ctx, args.companyId, membership, caps, "sops:view:company");
      for (const branchId of managed?.branchIds ?? []) branchIds.add(branchId);
      for (const departmentId of managed?.departmentIds ?? []) departmentIds.add(departmentId);
    }

    const [branchDocs, departmentDocs, membershipDocs] = await Promise.all([
      Promise.all([...branchIds].map((branchId) => ctx.db.get(branchId))),
      Promise.all([...departmentIds].map((departmentId) => ctx.db.get(departmentId))),
      Promise.all([...userIds].map((membershipId) => ctx.db.get(membershipId))),
    ]);
    const branches = branchDocs.filter((branch) => branch?.companyId === args.companyId).map((branch) => ({ _id: branch!._id, name: branch!.name }));
    const branchNames = new Map(branches.map((branch) => [branch._id, branch.name]));
    const departments = departmentDocs.filter((department) => department?.companyId === args.companyId).map((department) => ({ _id: department!._id, name: department!.name, branchId: department!.branchId, branchName: branchNames.get(department!.branchId) ?? "Unknown branch" }));
    const activeMemberships = membershipDocs.filter((m): m is Doc<"companyMemberships"> => Boolean(m && m.companyId === args.companyId && m.active));
    const userDocs = await Promise.all(activeMemberships.map((m) => ctx.db.get(m.userId)));
    const users = [];
    for (let index = 0; index < activeMemberships.length; index += 1) {
      const userMembership = activeMemberships[index];
      const user = userDocs[index];
      if (user) users.push({ membership: { _id: userMembership._id, role: userMembership.role }, user: { name: memberFullName(userMembership, user), firstName: memberFirstName(userMembership, user), imageUrl: user.imageUrl ?? null } });
    }
    branches.sort((a, b) => a.name.localeCompare(b.name));
    departments.sort((a, b) => a.name.localeCompare(b.name));
    users.sort((a, b) => a.user.name.localeCompare(b.user.name));
    return { branches, departments, users };
  },
});

export const create = mutation({
  args: { companyId: v.id("companies"), title: v.string(), content: v.optional(v.string()), scopeType: v.union(v.literal("company"), v.literal("branch"), v.literal("department"), v.literal("user")), branchIds: v.array(v.id("branches")), departmentIds: v.array(v.id("departments")), userMembershipIds: v.array(v.id("companyMemberships")) },
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireCapability(ctx, args.companyId, "sops:create");
    assertCapability(capabilities, sopManageCapability(args.scopeType));
    const title = nonEmpty(args.title, "Title");
    const content = args.content?.trim() ?? "";
    assertScopeSelection(args);
    await assertTargets(ctx, args.companyId, args);
    await assertManagedTargets(ctx, args.companyId, membership, args, capabilities);
    const now = Date.now();
    const reference = await nextReference(ctx, args.companyId, "sop");
    const id = await ctx.db.insert("sops", { companyId: args.companyId, reference, title, content, scopeType: args.scopeType, creatorMembershipId: membership._id, updatedByMembershipId: membership._id, createdAt: now, updatedAt: now });
    await insertScopeRows(ctx, args.companyId, id, args);
    return id;
  },
});

async function currentSopTargets(ctx: MutationCtx | QueryCtx, sopId: Id<"sops">) {
  const [branchScopes, departmentScopes, userScopes] = await Promise.all([
    ctx.db.query("sopBranchScopes").withIndex("by_sopId_and_branchId", (q) => q.eq("sopId", sopId)).take(500),
    ctx.db.query("sopDepartmentScopes").withIndex("by_sopId_and_departmentId", (q) => q.eq("sopId", sopId)).take(500),
    ctx.db.query("sopUserScopes").withIndex("by_sopId_and_userMembershipId", (q) => q.eq("sopId", sopId)).take(500),
  ]);
  return {
    branchIds: branchScopes.map((r) => r.branchId),
    departmentIds: departmentScopes.map((r) => r.departmentId),
    userMembershipIds: userScopes.map((r) => r.userMembershipId),
  };
}

export const update = mutation({
  args: {
    companyId: v.id("companies"),
    sopId: v.id("sops"),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    scopeType: v.optional(v.union(v.literal("company"), v.literal("branch"), v.literal("department"), v.literal("user"))),
    branchIds: v.optional(v.array(v.id("branches"))),
    departmentIds: v.optional(v.array(v.id("departments"))),
    userMembershipIds: v.optional(v.array(v.id("companyMemberships"))),
  },
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    const sop = await ctx.db.get(args.sopId);
    if (!sop || sop.companyId !== args.companyId || !(await visibleSop(ctx, args.companyId, membership, sop, undefined, capabilities))) throw new ConvexError("SOP not found.");
    assertCapability(capabilities, sopManageCapability(sop.scopeType));
    const currentTargets = await currentSopTargets(ctx, args.sopId);
    await assertManagedTargets(ctx, args.companyId, membership, currentTargets, capabilities);

    const patch: {
      title?: string;
      content?: string;
      scopeType?: Doc<"sops">["scopeType"];
      updatedByMembershipId: Id<"companyMemberships">;
      updatedAt: number;
    } = {
      updatedByMembershipId: membership._id,
      updatedAt: Date.now(),
    };

    if (args.title !== undefined) patch.title = nonEmpty(args.title, "Title");
    if (args.content !== undefined) patch.content = args.content.trim();
    if (args.scopeType !== undefined) {
      assertCapability(capabilities, sopManageCapability(args.scopeType));
      const scopeArgs = { scopeType: args.scopeType, branchIds: args.branchIds ?? [], departmentIds: args.departmentIds ?? [], userMembershipIds: args.userMembershipIds ?? [] };
      assertScopeSelection(scopeArgs);
      await assertTargets(ctx, args.companyId, scopeArgs);
      await assertManagedTargets(ctx, args.companyId, membership, scopeArgs, capabilities);
      await deleteScopeRows(ctx, args.sopId);
      patch.scopeType = args.scopeType;
      await insertScopeRows(ctx, args.companyId, args.sopId, scopeArgs);
    }

    await ctx.db.patch(args.sopId, patch);
    return null;
  },
});

export const updateScope = mutation({
  args: { companyId: v.id("companies"), sopId: v.id("sops"), scopeType: v.union(v.literal("company"), v.literal("branch"), v.literal("department"), v.literal("user")), branchIds: v.array(v.id("branches")), departmentIds: v.optional(v.array(v.id("departments"))), userMembershipIds: v.array(v.id("companyMemberships")) },
  handler: async (ctx, args) => {
    const { membership, capabilities } = await requireMembership(ctx, args.companyId);
    const sop = await ctx.db.get(args.sopId);
    if (!sop || sop.companyId !== args.companyId || !(await visibleSop(ctx, args.companyId, membership, sop, undefined, capabilities))) throw new ConvexError("SOP not found.");
    assertCapability(capabilities, sopManageCapability(sop.scopeType));
    const currentTargets = await currentSopTargets(ctx, args.sopId);
    await assertManagedTargets(ctx, args.companyId, membership, currentTargets, capabilities);

    assertCapability(capabilities, sopManageCapability(args.scopeType));
    const scopeArgs = { scopeType: args.scopeType, branchIds: args.branchIds, departmentIds: args.departmentIds ?? [], userMembershipIds: args.userMembershipIds };
    assertScopeSelection(scopeArgs);
    await assertTargets(ctx, args.companyId, scopeArgs);
    await assertManagedTargets(ctx, args.companyId, membership, scopeArgs, capabilities);
    await deleteScopeRows(ctx, args.sopId);
    await ctx.db.patch(args.sopId, { scopeType: args.scopeType, updatedByMembershipId: membership._id, updatedAt: Date.now() });
    await insertScopeRows(ctx, args.companyId, args.sopId, scopeArgs);
    return null;
  },
});

async function purgeSop(ctx: MutationCtx, companyId: Id<"companies">, sopId: Id<"sops">) {
  const { membership, user, capabilities } = await requireMembership(ctx, companyId);
  const sop = await ctx.db.get(sopId);
  if (!sop || sop.companyId !== companyId || !(await visibleSop(ctx, companyId, membership, sop, undefined, capabilities))) throw new ConvexError("SOP not found.");
  assertCapability(capabilities, sopDeleteCapability(sop.scopeType));
  const currentTargets = await currentSopTargets(ctx, sopId);
  await assertManagedTargets(ctx, companyId, membership, currentTargets, capabilities);
  await deleteScopeRows(ctx, sopId);
  await ctx.db.delete(sopId);
  await ctx.db.insert("auditEvents", { companyId, actorUserId: user._id, action: "sop.delete", targetType: "sop", targetId: sopId, createdAt: Date.now() });
  return null;
}

export const remove = mutation({ args: { companyId: v.id("companies"), sopId: v.id("sops") }, handler: async (ctx, args) => { await purgeSop(ctx, args.companyId, args.sopId); return null; } });

const DELETE_BULK_SOP_LIMIT = 100;

export const removeBulk = mutation({
  args: { companyId: v.id("companies"), sopIds: v.array(v.id("sops")) },
  handler: async (ctx, args) => {
    if (args.sopIds.length > DELETE_BULK_SOP_LIMIT) throw new ConvexError(`Select at most ${DELETE_BULK_SOP_LIMIT} SOPs to delete at once.`);
    for (const sopId of new Set(args.sopIds)) await purgeSop(ctx, args.companyId, sopId);
    return null;
  },
});

// Agent SOP search uses the FTS index for content and a bounded substring scan
// for title/reference (which FTS cannot express). Both paths stop at best-effort
// targets rather than throwing, so a large workspace still returns its
// reachable matches instead of failing on the filtered-scan ceiling.
const AI_SOP_TITLE_TARGET = 24;
const AI_SOP_TITLE_SCAN_BUDGET = 500;
const AI_SOP_CONTENT_TARGET = 24;
const AI_SOP_CONTENT_SCAN_BUDGET = 200;

function aiSopListRow(row: { _id: Id<"sops">; reference: string; title: string; content: string; scopeType: Doc<"sops">["scopeType"]; scopeTargetName: string | null; canUpdate: boolean; canDelete: boolean }) {
  return { id: row._id, reference: row.reference, title: row.title, excerpt: row.content.slice(0, 700), scopeType: row.scopeType, scopeTargetName: row.scopeTargetName, canUpdate: row.canUpdate, canDelete: row.canDelete };
}

export const aiListSops = query({
  args: { companyId: v.id("companies"), query: v.optional(v.string()), scope: v.optional(sopScopeFilterValidator), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 12), 1), 25);
    const scope = args.scope === "all" ? undefined : args.scope;
    const needle = args.query?.trim();
    if (!needle) {
      const rows = await filteredSopRows(ctx, { companyId: args.companyId, view: "all", scope, limit });
      return rows.map(aiSopListRow);
    }
    const { membership, capabilities: caps } = await requireMembership(ctx, args.companyId);
    const company = await ctx.db.get(args.companyId);
    const visibility = await buildSopVisibilityContext(ctx, args.companyId, membership, caps);
    const auth = sopListAuth(ctx, args.companyId, membership, caps);
    const lower = needle.toLowerCase();
    const inScope = (sop: Doc<"sops">) => scope === undefined || sop.scopeType === scope;
    const titleScan = async () =>
      (
        await scanUntil(
          ctx.db.query("sops").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc"),
          AI_SOP_TITLE_SCAN_BUDGET,
          AI_SOP_TITLE_TARGET,
          async (sop) => {
            if (!inScope(sop) || !(sop.reference.toLowerCase().includes(lower) || sop.title.toLowerCase().includes(lower))) return false;
            return await visibleSop(ctx, args.companyId, membership, sop, visibility, caps, undefined, auth);
          },
        )
      ).kept;
    const [contentResult, titleRows] = await Promise.all([
      visibleContentMatches(ctx, args.companyId, needle, membership, caps, visibility, AI_SOP_CONTENT_TARGET, AI_SOP_CONTENT_SCAN_BUDGET, auth),
      titleScan(),
    ]);
    const candidates = new Map<string, Doc<"sops">>();
    for (const sop of titleRows) candidates.set(sop._id, sop);
    for (const sop of contentResult.sops) {
      if (inScope(sop)) candidates.set(sop._id, sop);
    }
    const rows = await Promise.all([...candidates.values()].slice(0, limit).map((sop) => withScopes(ctx, sop, membership, company?.name, caps, auth)));
    return rows.map(aiSopListRow);
  },
});

export const aiGet = query({
  args: { companyId: v.id("companies"), sopId: v.id("sops") },
  handler: async (ctx, args) => {
    const { membership, capabilities: caps } = await requireMembership(ctx, args.companyId);
    const sop = await ctx.db.get(args.sopId);
    if (!sop || sop.companyId !== args.companyId || !(await visibleSop(ctx, args.companyId, membership, sop, undefined, caps))) throw new ConvexError("SOP not found.");
    const company = await ctx.db.get(args.companyId);
    const row = await withScopes(ctx, sop, membership, company?.name, caps);
    return { id: sop._id, reference: sop.reference, title: sop.title, content: sop.content.slice(0, 8000), scopeType: sop.scopeType, scopeTargetName: row.scopeTargetName, canUpdate: row.canUpdate, canDelete: row.canDelete };
  },
});
