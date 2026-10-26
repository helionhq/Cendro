import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import { analyticsScopedMembershipIds, assertAnalyticsViewAccess, buildSopVisibilityContext, requireMembership, sopListScopeAuth, taskHasVisibleAssignee, visibleAssigneeMembershipIds, visibleSop } from "./permissions";
import { currentJdCycle, localDateField, nextJdCycleStart } from "./taskCycles";
import { jdOccurrencesDueBetween, loadWorkCalendar, maxHolidaySpanDays, occurrenceDeadline } from "./workCalendar";
import { bucketIndexFor, buildDashboardBuckets, dashboardRangeValidator, resolveDashboardRange } from "./dashboardTime";
import type { Doc, Id } from "./_generated/dataModel";
import { takeWithOverflow } from "./queryLimits";

type DashboardScope = "company" | "managed" | "self";

type Person = {
  _id: Id<"companyMemberships">;
  role: Doc<"companyMemberships">["role"];
  name: string;
  firstName: string;
  imageUrl: string | null;
};

const dashboardTakeLimit = 500;

// Convex bounds a transaction to ~32k document reads; a shared budget keeps a
// workspace with many tasks and cycle records degrading to a truncated report
// instead of a failed query.
const dashboardReadBudget = 24_000;

// Any JD cycle whose deadline lands inside a dashboard range started at most
// ~366 days earlier (the longest recurrence is annual), plus slack, plus the
// longest contiguous holiday span a deadline could have shifted through.
const jdCompletionLookbackDays = 368 + 7;

type QueryCompleteness = { isTruncated: boolean; truncatedReads: number; remaining: number };

// takeBudgetedRows reserves its full allowance before yielding, so a fan-out
// of N items can reserve the whole ledger before any refund lands. Waves bound
// the in-flight reservations so refunds return before the next wave starts.
const BUDGET_WAVE = 8;

async function mapInWaves<T, R>(items: readonly T[], fn: (item: T) => Promise<R>) {
  const out: R[] = [];
  for (let index = 0; index < items.length; index += BUDGET_WAVE) {
    out.push(...await Promise.all(items.slice(index, index + BUDGET_WAVE).map(fn)));
  }
  return out;
}

// All dashboard reads share the read budget so one query stays inside Convex's
// transaction limit; the worst-case scan allowance is reserved before yielding
// so concurrent callers split the budget instead of double-spending it. Scope
// and filter metadata is authoritative: when it truncates, callers surface an
// explicit incomplete-scope state instead of validating filters against it.
async function takeBudgetedRows<T>(
  completeness: QueryCompleteness,
  take: (limit: number) => Promise<T[]>,
) {
  if (completeness.remaining <= 0) {
    completeness.isTruncated = true;
    completeness.truncatedReads++;
    return [];
  }
  const limit = Math.min(dashboardTakeLimit, completeness.remaining);
  completeness.remaining -= limit + 1;
  const result = await takeWithOverflow(take, limit);
  completeness.remaining += limit + 1 - (result.isTruncated ? limit + 1 : result.rows.length);
  if (result.isTruncated) {
    completeness.isTruncated = true;
    completeness.truncatedReads++;
  }
  return result.rows;
}

function firstName(membership: { firstName?: string } | null | undefined, user: Doc<"appUsers">) {
  return membership?.firstName?.trim() || user.firstName.trim() || "Unknown";
}

function fullName(membership: { firstName?: string; secondName?: string } | null | undefined, user: Doc<"appUsers">) {
  const first = firstName(membership, user);
  const second = membership?.secondName !== undefined ? membership.secondName.trim() : (user.secondName?.trim() ?? "");
  return [first === "Unknown" ? "" : first, second].filter(Boolean).join(" ") || first;
}

function safeRate(part: number, total: number) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

async function dashboardAccess(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  completeness: QueryCompleteness,
) {
  const { membership, company, capabilities: caps } = await requireMembership(ctx, companyId);
  assertAnalyticsViewAccess(caps);

  const dashboardScope: DashboardScope = caps.has("analytics:view:company") ? "company" : caps.has("analytics:view:managed_scope") ? "managed" : "self";
  const scopedIds = await analyticsScopedMembershipIds(
    ctx,
    companyId,
    membership,
    caps,
    () => { completeness.isTruncated = true; },
  );
  return { membership, company, caps, dashboardScope, scopedIds };
}

async function loadPeople(ctx: QueryCtx, membershipIds: Set<Id<"companyMemberships">>, completeness: QueryCompleteness) {
  const people = new Map<Id<"companyMemberships">, Person>();
  const ids = [...membershipIds];
  // Each membership costs up to two point reads; keep them inside the budget.
  const affordable = Math.floor(completeness.remaining / 2);
  if (affordable < ids.length) {
    completeness.isTruncated = true;
    completeness.truncatedReads++;
  }
  const toLoad = ids.slice(0, Math.max(0, affordable));
  completeness.remaining -= toLoad.length * 2;
  const memberships = await Promise.all(toLoad.map((membershipId) => ctx.db.get(membershipId)));
  const activeMemberships = memberships.filter((m): m is Doc<"companyMemberships"> => Boolean(m?.active));
  const users = await Promise.all(activeMemberships.map((m) => ctx.db.get(m.userId)));
  // Refund the allowance reserved for user reads that were never needed.
  completeness.remaining += toLoad.length - activeMemberships.length;
  for (let index = 0; index < activeMemberships.length; index += 1) {
    const membership = activeMemberships[index];
    const user = users[index];
    if (!user) continue;
    people.set(membership._id, {
      _id: membership._id,
      role: membership.role,
      name: fullName(membership, user),
      firstName: firstName(membership, user),
      imageUrl: user.imageUrl ?? null,
    });
  }
  return people;
}

async function loadAssignments(
  ctx: QueryCtx,
  membershipIds: Set<Id<"companyMemberships">>,
  completeness: QueryCompleteness,
) {
  // takeBudgetedRows reserves its allowance before yielding; waves bound the
  // in-flight reservations so refunds settle before the next wave starts.
  const entries = await mapInWaves([...membershipIds], async (membershipId) => {
    const [membershipBranches, membershipDepartments] = await Promise.all([
      takeBudgetedRows(
        completeness,
        (limit) => ctx.db.query("userBranchAssignments").withIndex("by_membershipId_and_branchId", (q) => q.eq("membershipId", membershipId)).take(limit),
      ),
      takeBudgetedRows(
        completeness,
        (limit) => ctx.db.query("userDepartmentAssignments").withIndex("by_membershipId_and_departmentId", (q) => q.eq("membershipId", membershipId)).take(limit),
      ),
    ]);
    return [membershipId, {
      branchIds: new Set(membershipBranches.map((row) => row.branchId)),
      departmentIds: new Set(membershipDepartments.map((row) => row.departmentId)),
    }] as const;
  });
  return { byMembership: new Map(entries) };
}

async function loadOrg(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  completeness: QueryCompleteness,
) {
  const [branches, departments] = await Promise.all([
    takeBudgetedRows(
      completeness,
      (limit) => ctx.db.query("branches").withIndex("by_company", (q) => q.eq("companyId", companyId)).take(limit),
    ),
    takeBudgetedRows(
      completeness,
      (limit) => ctx.db.query("departments").withIndex("by_company", (q) => q.eq("companyId", companyId)).take(limit),
    ),
  ]);
  branches.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  departments.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  return {
    branches,
    departments,
    branchById: new Map(branches.map((branch) => [branch._id, branch])),
    departmentById: new Map(departments.map((department) => [department._id, department])),
  };
}

/**
 * Loads everything the dashboard endpoints share: the caller's analytics
 * scope, the people and org units inside it, and the branch/department
 * options the caller is allowed to filter by. Branch options never expand
 * through department scopes — only direct manager branch scopes apply.
 */
async function resolveDashboardScope(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  completeness: QueryCompleteness,
) {
  const { membership, company, dashboardScope, scopedIds } = await dashboardAccess(ctx, companyId, completeness);
  // Each authority source is tracked separately: membership-scope truncation
  // only relaxes the employee check, and option-list truncation only relaxes
  // branch/department checks, so unrelated exhaustion cannot widen access.
  const scopedIdsComplete = !completeness.isTruncated;
  const optionsBudgetAlive = completeness.remaining > 0;
  // Option lists are complete only when the budget was still alive for this
  // phase and no read truncated inside it; earlier unrelated truncation alone
  // does not disqualify them. The option phase shares the remaining ledger but
  // tracks truncation separately so concurrent people/assignment exhaustion
  // cannot disqualify option lists that loaded fine.
  const optionPhase: QueryCompleteness = {
    get remaining() { return completeness.remaining; },
    set remaining(value) { completeness.remaining = value; },
    isTruncated: false,
    truncatedReads: 0,
  };
  // People, assignments, and org data are independent reads; the budget ledger
  // is shared and each read reserves before yielding, so they run concurrently.
  const [people, assignments, org] = await Promise.all([
    loadPeople(ctx, scopedIds, completeness),
    loadAssignments(ctx, scopedIds, completeness),
    loadOrg(ctx, companyId, optionPhase),
  ]);

  const memberBranchIds = new Map<Id<"companyMemberships">, Set<Id<"branches">>>();
  const memberDepartmentIds = new Map<Id<"companyMemberships">, Set<Id<"departments">>>();
  for (const [membershipId, assigned] of assignments.byMembership) {
    const branchIds = new Set(assigned.branchIds);
    for (const departmentId of assigned.departmentIds) {
      const department = org.departmentById.get(departmentId);
      if (department) branchIds.add(department.branchId);
    }
    memberBranchIds.set(membershipId, branchIds);
    memberDepartmentIds.set(membershipId, new Set(assigned.departmentIds));
  }

  let branchOptions: Doc<"branches">[] = [];
  let departmentOptions: Doc<"departments">[] = [];
  if (dashboardScope === "company") {
    branchOptions = org.branches;
    departmentOptions = org.departments;
  } else if (dashboardScope === "managed") {
    const [managedBranches, managedDepartments] = await Promise.all([
      takeBudgetedRows(
        optionPhase,
        (limit) => ctx.db.query("managerBranchScopes").withIndex("by_managerMembershipId_and_branchId", (q) => q.eq("managerMembershipId", membership._id)).take(limit),
      ),
      takeBudgetedRows(
        optionPhase,
        (limit) => ctx.db.query("managerDepartmentScopes").withIndex("by_managerMembershipId_and_departmentId", (q) => q.eq("managerMembershipId", membership._id)).take(limit),
      ),
    ]);
    const branchScope = new Set(managedBranches.filter((row) => row.companyId === companyId).map((row) => row.branchId));
    const departmentScope = new Set(managedDepartments.filter((row) => row.companyId === companyId).map((row) => row.departmentId));
    branchOptions = org.branches.filter((branch) => branchScope.has(branch._id));
    departmentOptions = org.departments.filter((department) => branchScope.has(department.branchId) || departmentScope.has(department._id));
  }
  // Propagate after every option-phase read — the managed-scope reads above
  // can still truncate, and callers read completeness from the shared flag.
  if (optionPhase.isTruncated) completeness.isTruncated = true;
  const optionsComplete = optionsBudgetAlive && !optionPhase.isTruncated;

  return { membership, company, dashboardScope, scopedIds, people, assignments, org, branchOptions, departmentOptions, memberBranchIds, memberDepartmentIds, scopedIdsComplete, optionsComplete };
}

export const dashboardFilters = query({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const completeness: QueryCompleteness = { isTruncated: false, truncatedReads: 0, remaining: dashboardReadBudget };
    const scope = await resolveDashboardScope(ctx, args.companyId, completeness);
    const users = scope.dashboardScope === "self"
      ? []
      : Array.from(scope.people.values())
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((person) => ({
            _id: person._id,
            name: person.name,
            branchIds: Array.from(scope.memberBranchIds.get(person._id) ?? []),
            departmentIds: Array.from(scope.memberDepartmentIds.get(person._id) ?? []),
          }));
    return {
      viewer: { membershipId: scope.membership._id },
      branches: scope.branchOptions.map((branch) => ({ _id: branch._id, name: branch.name })),
      departments: scope.departmentOptions.map((department) => ({ _id: department._id, name: department.name, branchId: department.branchId })),
      users,
      isTruncated: completeness.isTruncated,
    };
  },
});

type WorkItem = {
  kind: "jd" | "task";
  at: number;
  completed: boolean;
  overdue: boolean;
  assigneeIds: Id<"companyMemberships">[];
};

export const dashboard = query({
  args: {
    companyId: v.id("companies"),
    now: v.number(),
    range: dashboardRangeValidator,
    branchId: v.optional(v.id("branches")),
    departmentId: v.optional(v.id("departments")),
    membershipId: v.optional(v.id("companyMemberships")),
  },
  handler: async (ctx, args) => {
    // args.now stays in the signature so its rotation re-runs the query, but
    // all accounting uses server time: a skewed client clock can neither pull
    // reporting into the future nor shrink it into the past.
    const now = Date.now();
    const completeness: QueryCompleteness = { isTruncated: false, truncatedReads: 0, remaining: dashboardReadBudget };
    const scope = await resolveDashboardScope(ctx, args.companyId, completeness);
    const timeZone = scope.company.timeZone ?? null;

    if (scope.dashboardScope === "self" && (args.branchId || args.departmentId)) {
      throw new ConvexError("Team filters are not available for your dashboard.");
    }
    // Scope metadata loaded under the read budget may be incomplete; a check
    // only runs when its own authority source loaded completely. Filters that
    // cannot be verified are allowed through, and the effective-scope
    // intersection still confines results to the viewer's memberships.
    if (scope.scopedIdsComplete && args.membershipId && !scope.scopedIds.has(args.membershipId)) {
      throw new ConvexError("Employee filter is outside your analytics scope.");
    }
    const branchOptionIds = new Set(scope.branchOptions.map((branch) => branch._id));
    const departmentOptionsById = new Map(scope.departmentOptions.map((department) => [department._id, department]));
    if (scope.optionsComplete && args.branchId && !branchOptionIds.has(args.branchId)) {
      throw new ConvexError("Branch filter is outside your analytics scope.");
    }
    const filteredDepartment = args.departmentId ? departmentOptionsById.get(args.departmentId) : undefined;
    if (scope.optionsComplete && args.departmentId && !filteredDepartment) {
      throw new ConvexError("Department filter is outside your analytics scope.");
    }
    if (args.branchId && filteredDepartment && filteredDepartment.branchId !== args.branchId) {
      throw new ConvexError("Department filter is outside your analytics scope.");
    }

    const effectiveIds = new Set<Id<"companyMemberships">>();
    for (const id of scope.scopedIds) {
      if (args.branchId && !scope.memberBranchIds.get(id)?.has(args.branchId)) continue;
      if (args.departmentId && !scope.memberDepartmentIds.get(id)?.has(args.departmentId)) continue;
      if (args.membershipId && id !== args.membershipId) continue;
      effectiveIds.add(id);
    }

    const range = resolveDashboardRange(args.range, now, timeZone);
    const buckets = buildDashboardBuckets(range, timeZone);
    const calendar = await loadWorkCalendar(ctx, args.companyId);
    const jdCompletionLookbackMs = (jdCompletionLookbackDays + maxHolidaySpanDays(calendar)) * 86_400_000;

    const items: WorkItem[] = [];

    const [jdTasks, oneTimeTasks] = await Promise.all([
      takeBudgetedRows(
        completeness,
        (limit) => ctx.db.query("jdTasks").withIndex("by_companyId_and_pausedAt", (q) => q.eq("companyId", args.companyId).eq("pausedAt", undefined)).take(limit),
      ),
      takeBudgetedRows(
        completeness,
        (limit) => ctx.db.query("oneTimeTasks").withIndex("by_companyId_and_createdAt", (q) => q.eq("companyId", args.companyId).gte("createdAt", range.start).lte("createdAt", range.end)).take(limit),
      ),
    ]);
    // Visibility is a JS-only check, so resolve it before touching the ledger
    // tables. The ledger fan-out below then only reads rows for tasks the
    // viewer can actually see.
    const visibleJdTasks = jdTasks
      .filter((task) => task.pausedAt === undefined)
      .map((task) => ({ task, assignees: visibleAssigneeMembershipIds(task.assigneeMembershipIds, effectiveIds) }))
      .filter((entry) => entry.assignees.length > 0);

    // Read only active, visible task ledgers. Company-wide scans also include
    // preserved paused history, which must not consume the active report budget.
    type TaskLedger = { completions: Doc<"jdTaskCompletions">[]; missed: Doc<"jdTaskCycleRecords">[]; pending: Doc<"taskConfirmationRequests">[]; truncated: boolean };
    const ledgersByTask = new Map<Id<"jdTasks">, TaskLedger>();
    await mapInWaves(visibleJdTasks, async ({ task }) => {
      // Reserve before yielding and keep each task's completeness separate:
      // incomplete history must never silently misreport completed work.
      const taskPhase: QueryCompleteness = {
        get remaining() { return completeness.remaining; },
        set remaining(value) { completeness.remaining = value; },
        isTruncated: false,
        truncatedReads: 0,
      };
      const [completions, missed, pending] = await Promise.all([
        takeBudgetedRows(
          taskPhase,
          (limit) => ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", task._id).gte("cycleStart", range.start - jdCompletionLookbackMs).lte("cycleStart", range.end)).order("desc").take(limit),
        ),
        takeBudgetedRows(
          taskPhase,
          (limit) => ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleEnd", (q) => q.eq("jdTaskId", task._id).gte("cycleEnd", range.start + 1).lte("cycleEnd", range.end + 1)).take(limit),
        ),
        takeBudgetedRows(
          taskPhase,
          (limit) => ctx.db.query("taskConfirmationRequests").withIndex("by_taskType_and_taskId_and_cycleStart", (q) => q.eq("taskType", "jd").eq("taskId", task._id)).take(limit),
        ),
      ]);
      ledgersByTask.set(task._id, { completions, missed, pending, truncated: taskPhase.isTruncated });
    });

    const jdItemGroups = visibleJdTasks.map(({ task, assignees }) => {
      const ledger = ledgersByTask.get(task._id)!;
      if (ledger.truncated) {
        completeness.isTruncated = true;
        return [];
      }
      const { completions, missed, pending } = ledger;
      const pendingStarts = new Set(pending.flatMap((request) => request.cycleStart === undefined ? [] : [request.cycleStart]));

      const cycles = new Map<string, { start: number; retired: boolean; dueAt: number; completed: boolean; stored: boolean }>();
      // Group rows by grid lifetime as well as start: retired work must not
      // complete a reset grid, but its completion and miss still count once.
      // Completed rows own their stored deadlines; reconstruction or a stale
      // missed record must not rewrite completed history.
      const put = (start: number, dueAt: number, completed: boolean, stored: boolean, retiredAt?: number) => {
        const key = `${start}:${retiredAt ?? "current"}`;
        const existing = cycles.get(key);
        cycles.set(key, {
          start,
          retired: retiredAt !== undefined,
          dueAt: existing && ((existing.stored && !stored) || (existing.completed && !completed)) ? existing.dueAt : dueAt,
          completed: (existing?.completed ?? false) || completed,
          stored: (existing?.stored ?? false) || stored,
        });
      };

      // A cycle that ends inside the range started at most ~366 days before it
      // (the longest recurrence is annual), so this lookback covers every
      // completion that could still be due in range. Newer completions record
      // their own cycleEnd; legacy rows fall back to the current grid.
      // Missed records store their own deadline, so they stay exact across
      // recurrence and timezone changes; match on that deadline directly.
      const taskItems: WorkItem[] = [];
      for (const completion of completions) {
        // Legacy rows predate cycleEnd. When the stored start no longer sits on
        // the task's grid the recurrence or timezone changed since, so the
        // reconstructed deadline is unreliable and the recorded completion
        // time is the only trustworthy instant inside that cycle.
        const end = completion.cycleEnd ?? (
          currentJdCycle(task.recurrence, completion.cycleStart, timeZone).start === completion.cycleStart
            ? nextJdCycleStart(completion.cycleStart, task.recurrence, timeZone)
            : completion.completedAt + 1
        );
        put(completion.cycleStart, end - 1, true, true, completion.retiredAt);
      }

      for (const record of missed) {
        put(record.cycleStart, record.cycleEnd - 1, false, true, record.retiredAt);
      }

      // Skipped occurrences (non-working due dates on daily/alternate cycles)
      // never enter the ledger; other recurrences report their shifted
      // deadline, matching what the missed-record writer stores.
      const elapsed = jdOccurrencesDueBetween(calendar, task.recurrence, task.cycleStartedAt, now, range.start, range.end, 200, timeZone);
      if (elapsed.truncated) completeness.isTruncated = true;
      for (const cycle of elapsed.occurrences) put(cycle.start, cycle.deadline - 1, false, false);

      const current = currentJdCycle(task.recurrence, now, timeZone);
      const currentDeadline = occurrenceDeadline(calendar, task.recurrence, current.end, timeZone);
      if (currentDeadline !== null && current.start >= currentJdCycle(task.recurrence, task.cycleStartedAt, timeZone).start) put(current.start, currentDeadline - 1, false, false);

      for (const cycle of cycles.values()) {
        if (cycle.start <= now && cycle.dueAt >= range.start && cycle.dueAt <= range.end) {
          const completed = cycle.completed || (!cycle.retired && task.status === "completed" && task.statusCycleStart === cycle.start);
          // A cycle waiting on its confirmer is neither completed nor missed.
          const overdue = !completed && !pendingStarts.has(cycle.start) && cycle.dueAt < now;
          taskItems.push({ kind: "jd", at: cycle.dueAt, completed, overdue, assigneeIds: assignees });
        }
      }
      return taskItems;
    });
    for (const group of jdItemGroups) items.push(...group);
    for (const task of oneTimeTasks) {
      const assignees = visibleAssigneeMembershipIds(task.assigneeMembershipIds, effectiveIds);
      if (!assignees.length) continue;
      const completed = task.status === "completed";
      const overdue = !completed && (task.overdueAt !== undefined || (task.status !== "awaiting_confirmation" && task.dueDate !== undefined && task.dueDate < now));
      items.push({ kind: "task", at: task.createdAt, completed, overdue, assigneeIds: assignees });
    }

    let jdDue = 0;
    let jdCompleted = 0;
    let jdOverdue = 0;
    let tasksAssigned = 0;
    let tasksCompleted = 0;
    let tasksOverdue = 0;
    const trend = buckets.map((bucket) => ({
      bucketStart: bucket.start,
      label: bucket.label,
      jdDue: 0,
      jdCompleted: 0,
      tasksAssigned: 0,
      tasksCompleted: 0,
    }));
    for (const item of items) {
      const bucketIndex = bucketIndexFor(buckets, item.at);
      const bucket = bucketIndex === -1 ? undefined : trend[bucketIndex];
      if (item.kind === "jd") {
        jdDue += 1;
        if (item.completed) jdCompleted += 1;
        if (item.overdue) jdOverdue += 1;
        if (bucket) {
          bucket.jdDue += 1;
          if (item.completed) bucket.jdCompleted += 1;
        }
      } else {
        tasksAssigned += 1;
        if (item.completed) tasksCompleted += 1;
        if (item.overdue) tasksOverdue += 1;
        if (bucket) {
          bucket.tasksAssigned += 1;
          if (item.completed) bucket.tasksCompleted += 1;
        }
      }
    }

    const singleMember = scope.scopedIds.size <= 1 || scope.dashboardScope === "self";
    let level: "company" | "branch" | "department" | "user";
    let groupKind: "branch" | "department" | null = null;
    let groupCandidates: (Doc<"branches"> | Doc<"departments">)[] = [];
    if (args.membershipId || singleMember) {
      level = "user";
    } else if (args.departmentId) {
      level = "department";
    } else {
      const branchCandidates = args.branchId ? [] : scope.branchOptions;
      if (branchCandidates.length >= 2) {
        level = "company";
        groupKind = "branch";
        groupCandidates = branchCandidates;
      } else {
        const departmentCandidates = scope.departmentOptions.filter((department) => !args.branchId || department.branchId === args.branchId);
        if (departmentCandidates.length >= 2) {
          level = "branch";
          groupKind = "department";
          groupCandidates = departmentCandidates;
        } else {
          level = "department";
        }
      }
    }

    const employeeTotals = new Map<Id<"companyMemberships">, { id: Id<"companyMemberships">; name: string; jdDue: number; jdCompleted: number; tasksAssigned: number; tasksCompleted: number }>();
    if (level !== "user") {
      for (const id of effectiveIds) {
        const person = scope.people.get(id);
        if (person) employeeTotals.set(id, { id, name: person.name, jdDue: 0, jdCompleted: 0, tasksAssigned: 0, tasksCompleted: 0 });
      }
      for (const item of items) {
        for (const assigneeId of item.assigneeIds) {
          const row = employeeTotals.get(assigneeId);
          if (!row) continue;
          if (item.kind === "jd") {
            row.jdDue += 1;
            if (item.completed) row.jdCompleted += 1;
          } else {
            row.tasksAssigned += 1;
            if (item.completed) row.tasksCompleted += 1;
          }
        }
      }
    }
    const employees = Array.from(employeeTotals.values())
      .map((row) => {
        const total = row.jdDue + row.tasksAssigned;
        const completed = row.jdCompleted + row.tasksCompleted;
        return { ...row, total, completed, completionRate: safeRate(completed, total) };
      })
      .filter((row) => row.total > 0)
      .sort((a, b) => b.completionRate - a.completionRate || b.total - a.total || a.name.localeCompare(b.name))
      .slice(0, 5);

    let groups: { kind: "branch" | "department"; rows: { id: string; name: string; total: number; completed: number; completionRate: number }[] } | null = null;
    if (groupKind) {
      const memberSets: ReadonlyMap<Id<"companyMemberships">, ReadonlySet<string>> = groupKind === "branch" ? scope.memberBranchIds : scope.memberDepartmentIds;
      const candidateIds = new Set(groupCandidates.map((candidate) => candidate._id as string));
      // Single pass over items: each item counts once per group via any of its
      // assignees, instead of rescanning every item per group.
      const totals = new Map<string, { total: number; completed: number }>();
      for (const item of items) {
        const hit = new Set<string>();
        for (const assigneeId of item.assigneeIds) {
          for (const groupId of memberSets.get(assigneeId) ?? []) {
            if (candidateIds.has(groupId)) hit.add(groupId);
          }
        }
        for (const groupId of hit) {
          const row = totals.get(groupId) ?? { total: 0, completed: 0 };
          row.total += 1;
          if (item.completed) row.completed += 1;
          totals.set(groupId, row);
        }
      }
      const rows = groupCandidates
        .map((candidate) => {
          const tally = totals.get(candidate._id) ?? { total: 0, completed: 0 };
          return { id: candidate._id as string, name: candidate.name, total: tally.total, completed: tally.completed, completionRate: safeRate(tally.completed, tally.total) };
        })
        .filter((row) => row.total > 0)
        .sort((a, b) => b.completionRate - a.completionRate || b.total - a.total || a.name.localeCompare(b.name))
        .slice(0, 5);
      groups = { kind: groupKind, rows };
    }

    return {
      isTruncated: completeness.isTruncated,
      level,
      today: localDateField(now, timeZone),
      range: {
        start: range.start,
        end: range.end,
        grouping: range.grouping,
        startDate: localDateField(range.start, timeZone),
        endDate: localDateField(range.end, timeZone),
      },
      jd: { due: jdDue, completed: jdCompleted, overdue: jdOverdue, completionRate: safeRate(jdCompleted, jdDue) },
      tasks: { assigned: tasksAssigned, completed: tasksCompleted, overdue: tasksOverdue, completionRate: safeRate(tasksCompleted, tasksAssigned) },
      trend,
      rankings: { employees, groups },
    };
  },
});

async function analyticsSummary(ctx: QueryCtx, args: { companyId: Id<"companies"> }) {
  const { membership, capabilities: caps } = await requireMembership(ctx, args.companyId);
  assertAnalyticsViewAccess(caps);
  const completeness: QueryCompleteness = { isTruncated: false, truncatedReads: 0, remaining: dashboardReadBudget };
  const scoped = await analyticsScopedMembershipIds(
    ctx,
    args.companyId,
    membership,
    caps,
    () => { completeness.isTruncated = true; },
  );
  const [jd, one, sops, recentRows] = await Promise.all([
    takeBudgetedRows(
      completeness,
      (limit) => ctx.db.query("jdTasks").withIndex("by_companyId_and_pausedAt", (q) => q.eq("companyId", args.companyId).eq("pausedAt", undefined)).take(limit),
    ),
    takeBudgetedRows(
      completeness,
      (limit) => ctx.db.query("oneTimeTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(limit),
    ),
    takeBudgetedRows(
      completeness,
      (limit) => ctx.db.query("sops").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).take(limit),
    ),
    caps.has("company:view_audit_log")
      ? ctx.db.query("auditEvents").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).order("desc").take(8)
      : Promise.resolve([]),
  ]);
  const visibleJd = jd.filter((task) => task.pausedAt === undefined && taskHasVisibleAssignee(task, scoped));
  const visibleOne = one.filter((task) => taskHasVisibleAssignee(task, scoped));
  const overdueOne = visibleOne.filter((t) => t.status !== "completed" && (t.overdueAt || (t.status !== "awaiting_confirmation" && t.dueDate && t.dueDate < Date.now()))).length;
  const completedOne = visibleOne.filter((t) => t.status === "completed").length;
  const markTruncated = () => { completeness.isTruncated = true; };
  const sopVisibility = sops.length
    ? await buildSopVisibilityContext(ctx, args.companyId, membership, caps, markTruncated)
    : null;
  const scopeAuth = sopListScopeAuth(ctx, args.companyId, membership._id);
  const sopFlags = await Promise.all(sops.map((sop) => visibleSop(ctx, args.companyId, membership, sop, sopVisibility, caps, markTruncated, scopeAuth)));
  const sopCount = sopFlags.filter(Boolean).length;
  const recent = recentRows.map((event) => ({ _id: event._id, action: event.action, targetType: event.targetType, createdAt: event.createdAt }));
  return {
    role: membership.role,
    scopeSize: scoped.size,
    jdTaskCount: visibleJd.length,
    oneTimeTaskCount: visibleOne.length,
    overdueTasks: overdueOne,
    completionRate: visibleOne.length ? Math.round(completedOne / visibleOne.length * 100) : 100,
    sopCount,
    recent,
    isTruncated: completeness.isTruncated,
    isComplete: !completeness.isTruncated,
  };
}

export const summary = query({
  args: { companyId: v.id("companies") },
  handler: analyticsSummary,
});

export const aiSummary = query({
  args: { companyId: v.id("companies") },
  handler: analyticsSummary,
});
