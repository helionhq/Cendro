import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import { analyticsScopedMembershipIds, assertAnalyticsViewAccess, buildSopVisibilityContext, requireMembership, sopListScopeAuth, taskHasVisibleAssignee, visibleAssigneeMembershipIds, visibleSop } from "./permissions";
import { currentJdCycle, jdRecurrences, localDateField, localDayIndexAt, type JdRecurrence } from "./taskCycles";
import { jdOccurrencesDueBetween, effectiveCurrentJdCycle, loadWorkCalendar, maxHolidaySpanDays, occurrenceDeadline } from "./workCalendar";
import { bucketIndexFor, dashboardPeriodValidator, resolveDashboardPeriod, type DashboardPeriod } from "./dashboardTime";
import type { Doc, Id } from "./_generated/dataModel";
import { takeWithOverflow } from "./queryLimits";
import { jdLedgerOutcomes, jdOutcomeCountableAt, type JdOutcome } from "./jdReport";

type DashboardScope = "company" | "managed" | "self";

type Person = {
  _id: Id<"companyMemberships">;
  role: Doc<"companyMemberships">["role"];
  name: string;
  firstName: string;
  imageUrl: string | null;
};

const dashboardTakeLimit = 500;
// The dashboard reads every active JD task and every one-time task created in
// the window. These are the report's explicit ceilings; past them it flags
// itself incomplete.
export const dashboardTaskLimit = 4_000;
// Pre-counted JD totals: one row per due month and assignee set. A year view
// reads 24 months, so this covers ~400 distinct assignee sets.
const dashboardJdTotalsLimit = 10_000;
// Lists show the newest unfinished work; the card totals stay exact.
const dashboardListLimit = 200;

// Convex bounds a transaction to ~32k document reads; a shared budget keeps a
// workspace past the ceilings degrading to a truncated report instead of a
// failed query.
const dashboardReadBudget = 24_000;

// A cycle's deadline trails its start by at most one recurrence length plus
// the longest contiguous holiday shift a deadline could have moved through.
const maxJdCycleDays: Record<JdRecurrence, number> = {
  daily: 1,
  every_other_day: 2,
  weekly: 7,
  semimonthly: 16,
  monthly: 31,
  quarterly: 92,
  semiannually: 184,
  annually: 366,
};

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
  maxRows = dashboardTakeLimit,
) {
  if (completeness.remaining <= 0) {
    completeness.isTruncated = true;
    completeness.truncatedReads++;
    return [];
  }
  const limit = Math.min(maxRows, completeness.remaining);
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

function rate(part: number, total: number) {
  return total > 0 ? Math.round((part / total) * 100) : null;
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
    return {
      viewer: { membershipId: scope.membership._id },
      branches: scope.branchOptions.map((branch) => ({ _id: branch._id, name: branch.name })),
      departments: scope.departmentOptions.map((department) => ({ _id: department._id, name: department.name, branchId: department.branchId })),
      isTruncated: completeness.isTruncated,
    };
  },
});

type JdItem = {
  taskId: Id<"jdTasks">;
  title: string;
  reference: string;
  recurrence: JdRecurrence;
  at: number;
  status: "done" | "missed" | "waiting";
  assigneeIds: Id<"companyMemberships">[];
};

type OneTimeItem = {
  taskId: Id<"oneTimeTasks">;
  title: string;
  reference: string;
  priority: Doc<"oneTimeTasks">["priority"];
  at: number;
  dueDate?: number;
  status: "done" | "overdue" | "waiting" | "not_due";
  assigneeIds: Id<"companyMemberships">[];
};

// Outcomes counted together at one instant: a totals segment or one live cycle.
type JdCount = { at: number; recurrence: JdRecurrence; assigneeIds: Id<"companyMemberships">[]; done: number; missed: number; waiting: number };
const jdCountDue = (count: JdCount) => count.done + count.missed + count.waiting;

type BucketState = "past" | "current" | "future";

/**
 * The newest unfinished cycles due in the period, for a person view. Missed
 * records are read one bucket at a time, newest first, so a long period stops
 * reading once the list is full instead of scanning its whole ledger. Each
 * bucket's records merge with the completions and requests at the same cycle
 * starts, so the list agrees with the counted outcomes.
 */
async function loadJdNotDone(
  ctx: QueryCtx,
  tasks: { task: Doc<"jdTasks"> }[],
  period: DashboardPeriod,
  now: number,
  timeZone: string | null,
  holidaySpanDays: number,
  unrecorded: JdItem[],
  completeness: QueryCompleteness,
) {
  const items = new Map<string, JdItem>();
  const add = (task: Doc<"jdTasks">, outcome: JdOutcome) => {
    if (outcome.status === "done" || outcome.dueAt < period.start || outcome.dueAt > period.end || jdOutcomeCountableAt(outcome) > now) return;
    items.set(`${task._id}:${outcome.start}:${outcome.retired}`, { taskId: task._id, title: task.title, reference: task.reference, recurrence: task.recurrence, at: outcome.dueAt, status: outcome.status, assigneeIds: [] });
  };
  const completionsStartingBetween = (task: Doc<"jdTasks">, from: number, to: number) => takeBudgetedRows(
    completeness,
    (limit) => ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", task._id).gte("cycleStart", from).lte("cycleStart", to)).take(limit),
  );

  // A cycle that started up to one recurrence plus a holiday shift before the
  // period can still be due inside it.
  const pendingByTask = new Map(await mapInWaves(tasks, async ({ task }) => {
    const from = period.start - (maxJdCycleDays[task.recurrence] + holidaySpanDays + 1) * 86_400_000;
    return [task._id, await takeBudgetedRows(
      completeness,
      (limit) => ctx.db.query("taskConfirmationRequests").withIndex("by_taskType_and_taskId_and_cycleStart", (q) => q.eq("taskType", "jd").eq("taskId", task._id).gte("cycleStart", from).lte("cycleStart", period.end)).take(limit),
    )] as const;
  }));
  const mergedRequests = new Set<Id<"taskConfirmationRequests">>();
  for (const bucket of period.buckets.filter((bucket) => bucket.start >= period.start).reverse()) {
    await mapInWaves(tasks, async ({ task }) => {
      const missed = await takeBudgetedRows(
        completeness,
        (limit) => ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleEnd", (q) => q.eq("jdTaskId", task._id).gte("cycleEnd", bucket.start + 1).lte("cycleEnd", bucket.end + 1)).take(limit),
      );
      if (missed.length === 0) return;
      const from = Math.min(...missed.map((row) => row.cycleStart));
      const to = Math.max(...missed.map((row) => row.cycleStart));
      const pending = (pendingByTask.get(task._id) ?? []).filter((request) => request.cycleStart !== undefined && request.cycleStart >= from && request.cycleStart <= to);
      for (const request of pending) mergedRequests.add(request._id);
      for (const outcome of jdLedgerOutcomes(task, timeZone, { completions: await completionsStartingBetween(task, from, to), missed, pending })) add(task, outcome);
    });
    // Every bucket left is older than every item listed so far.
    if (items.size >= dashboardListLimit) break;
  }
  // Requests without a missed record in the buckets read: work still waiting.
  await mapInWaves(tasks, async ({ task }) => {
    const pending = (pendingByTask.get(task._id) ?? []).filter((request) => request.cycleStart !== undefined && !mergedRequests.has(request._id));
    if (pending.length === 0) return;
    const starts = pending.map((request) => request.cycleStart!);
    const completions = await completionsStartingBetween(task, Math.min(...starts), Math.max(...starts));
    for (const outcome of jdLedgerOutcomes(task, timeZone, { completions, missed: [], pending })) add(task, outcome);
  });
  const rows = [...items.values(), ...unrecorded.filter((item) => item.at >= period.start && item.at <= period.end)];
  return rows.sort((a, b) => b.at - a.at || a.title.localeCompare(b.title)).slice(0, dashboardListLimit);
}

export const dashboard = query({
  args: {
    companyId: v.id("companies"),
    now: v.number(),
    period: dashboardPeriodValidator,
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

    const period = resolveDashboardPeriod(args.period, now, timeZone);
    const todayEnd = currentJdCycle("daily", now, timeZone).end - 1;
    // The reads reach far enough back for the earliest bucket and the previous
    // period, and never past the end of today: a stored row only exists for
    // work that has happened. Counted totals use the full period bound for
    // done and waiting work, which can carry a deadline later this period.
    const windowStart = Math.min(period.buckets[0].start, period.previous.start);
    const windowEnd = Math.min(period.end, todayEnd);
    const calendar = await loadWorkCalendar(ctx, args.companyId);

    const [jdTasks, oneTimeTasks, jdTotals] = await Promise.all([
      takeBudgetedRows(
        completeness,
        (limit) => ctx.db.query("jdTasks").withIndex("by_companyId_and_pausedAt", (q) => q.eq("companyId", args.companyId).eq("pausedAt", undefined)).take(limit),
        dashboardTaskLimit,
      ),
      takeBudgetedRows(
        completeness,
        (limit) => ctx.db.query("oneTimeTasks").withIndex("by_companyId_and_createdAt", (q) => q.eq("companyId", args.companyId).gte("createdAt", windowStart).lte("createdAt", windowEnd)).take(limit),
        dashboardTaskLimit,
      ),
      // Recorded JD outcomes arrive pre-counted (see jdReport.ts), so the read
      // stays a few rows per month however long the ledger grows.
      takeBudgetedRows(
        completeness,
        (limit) => ctx.db.query("jdReportTotals").withIndex("by_companyId_and_monthStart_and_assigneeKey", (q) => q.eq("companyId", args.companyId).gte("monthStart", currentJdCycle("monthly", windowStart, timeZone).start).lte("monthStart", period.end)).take(limit),
        dashboardJdTotalsLimit,
      ),
    ]);
    const visibleJdTasks = jdTasks
      .map((task) => ({ task, assignees: visibleAssigneeMembershipIds(task.assigneeMembershipIds, effectiveIds) }))
      .filter((entry) => entry.assignees.length > 0);

    // Totals rows are keyed by the task's whole assignee set, so a shared task
    // counts once for the team and once for each visible assignee.
    const jdCounts: JdCount[] = [];
    for (const row of jdTotals) {
      const assigneeIds = visibleAssigneeMembershipIds(row.assigneeMembershipIds, effectiveIds);
      if (assigneeIds.length === 0) continue;
      for (const count of row.counts) {
        if (count.segmentStart < windowStart || count.segmentStart > period.end) continue;
        jdCounts.push({ at: count.segmentStart, recurrence: count.recurrence, assigneeIds, done: count.done, missed: count.missed, waiting: count.waiting });
      }
    }

    // An elapsed cycle nobody recorded yet is missed, but the hourly
    // missed-cycle job has not written it into the ledger (or the totals).
    // Reconstruct those from each task's cycle floor, skipping any cycle that
    // already has a row; the completion stamp's cycle is counted in the totals.
    const unrecordedJdItems: JdItem[] = [];
    await mapInWaves(visibleJdTasks, async ({ task, assignees }) => {
      const elapsed = jdOccurrencesDueBetween(calendar, task.recurrence, task.cycleStartedAt, now, windowStart, windowEnd, 200, timeZone);
      if (elapsed.truncated) completeness.isTruncated = true;
      const candidates = elapsed.occurrences.filter((cycle) => cycle.deadline - 1 < now && !(task.status === "completed" && task.statusCycleStart === cycle.start));
      if (candidates.length === 0) return;
      const from = Math.min(...candidates.map((cycle) => cycle.start));
      // Track this task's reads separately: an absent row only proves a cycle
      // unrecorded when the whole range loaded. Otherwise its outcome may
      // already be in the totals, so the reconstruction must not add a miss.
      const taskPhase: QueryCompleteness = {
        get remaining() { return completeness.remaining; },
        set remaining(value) { completeness.remaining = value; },
        isTruncated: false,
        truncatedReads: 0,
      };
      const [completions, missed, pending] = await Promise.all([
        takeBudgetedRows(taskPhase, (limit) => ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", task._id).gte("cycleStart", from)).take(limit)),
        takeBudgetedRows(taskPhase, (limit) => ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", task._id).gte("cycleStart", from)).take(limit)),
        takeBudgetedRows(taskPhase, (limit) => ctx.db.query("taskConfirmationRequests").withIndex("by_taskType_and_taskId_and_cycleStart", (q) => q.eq("taskType", "jd").eq("taskId", task._id).gte("cycleStart", from)).take(limit)),
      ]);
      if (taskPhase.isTruncated) {
        completeness.isTruncated = true;
        completeness.truncatedReads += taskPhase.truncatedReads;
        return;
      }
      const recorded = new Set<number>();
      for (const row of [...completions, ...missed]) if (row.retiredAt === undefined) recorded.add(row.cycleStart);
      for (const request of pending) if (request.cycleStart !== undefined && request.recurrence === task.recurrence) recorded.add(request.cycleStart);
      for (const cycle of candidates) {
        if (recorded.has(cycle.start)) continue;
        unrecordedJdItems.push({ taskId: task._id, title: task.title, reference: task.reference, recurrence: task.recurrence, at: cycle.deadline - 1, status: "missed", assigneeIds: assignees });
      }
    });
    for (const item of unrecordedJdItems) jdCounts.push({ at: item.at, recurrence: item.recurrence, assigneeIds: item.assigneeIds, done: 0, missed: 1, waiting: 0 });

    // A current period also reports work that is due before it closes, so a
    // running month can say "3 JDs due on the 31st" instead of a bare zero.
    // The open cycle carries a still-pending shifted deadline: on Monday
    // morning the default calendar's weekly deadline belongs to last week's
    // grid cycle, not the raw cycle that started that day. Completing or
    // submitting a cycle stamps it on the task.
    const upcomingByRecurrence = new Map<JdRecurrence, number[]>();
    if (period.isCurrent) {
      for (const { task } of visibleJdTasks) {
        const open = effectiveCurrentJdCycle(calendar, task.recurrence, now, timeZone);
        const openDeadline = occurrenceDeadline(calendar, task.recurrence, open.end, timeZone);
        if (openDeadline === null || open.start < currentJdCycle(task.recurrence, task.cycleStartedAt, timeZone).start) continue;
        if (task.statusCycleStart === open.start && (task.status === "completed" || task.status === "awaiting_confirmation")) continue;
        const deadline = openDeadline - 1;
        if (now <= deadline && deadline <= period.end) upcomingByRecurrence.set(task.recurrence, [...(upcomingByRecurrence.get(task.recurrence) ?? []), deadline]);
      }
    }
    const taskItems: OneTimeItem[] = [];
    for (const task of oneTimeTasks) {
      const assignees = visibleAssigneeMembershipIds(task.assigneeMembershipIds, effectiveIds);
      if (!assignees.length) continue;
      const done = task.status === "completed";
      const overdue = !done && (task.overdueAt !== undefined || (task.status !== "awaiting_confirmation" && task.dueDate !== undefined && task.dueDate < now));
      const waiting = !done && !overdue && task.status === "awaiting_confirmation";
      taskItems.push({
        taskId: task._id,
        title: task.title,
        reference: task.reference,
        priority: task.priority,
        at: task.createdAt,
        dueDate: task.dueDate,
        status: done ? "done" : overdue ? "overdue" : waiting ? "waiting" : "not_due",
        assigneeIds: assignees,
      });
    }

    const inPeriod = (at: number) => at >= period.start && at <= period.end;
    const inPrevious = (at: number) => at >= period.previous.start && at <= period.previous.end;

    let jdDone = 0;
    let jdMissed = 0;
    let jdWaiting = 0;
    let previousJdDue = 0;
    let previousJdDone = 0;
    for (const count of jdCounts) {
      if (inPeriod(count.at)) {
        jdDone += count.done;
        jdMissed += count.missed;
        jdWaiting += count.waiting;
      }
      if (inPrevious(count.at)) {
        previousJdDue += jdCountDue(count);
        previousJdDone += count.done;
      }
    }
    const jdDue = jdDone + jdMissed + jdWaiting;

    let tasksAssigned = 0;
    let tasksDone = 0;
    let tasksOverdue = 0;
    let tasksWaiting = 0;
    let tasksNotDueYet = 0;
    let previousTasksAssigned = 0;
    let previousTasksDone = 0;
    for (const item of taskItems) {
      if (inPeriod(item.at)) {
        tasksAssigned += 1;
        if (item.status === "done") tasksDone += 1;
        else if (item.status === "overdue") tasksOverdue += 1;
        else if (item.status === "waiting") tasksWaiting += 1;
        else tasksNotDueYet += 1;
      }
      if (inPrevious(item.at)) {
        previousTasksAssigned += 1;
        if (item.status === "done") previousTasksDone += 1;
      }
    }

    const bucketRows: Array<{
      startDate: string;
      endDate: string;
      state: BucketState;
      jd: { due: number; done: number; completionRate: number | null };
      tasks: { assigned: number; done: number; completionRate: number | null };
    }> = period.buckets.map((bucket) => ({
      startDate: localDateField(bucket.start, timeZone),
      endDate: localDateField(bucket.end, timeZone),
      state: now < bucket.start ? "future" : now <= bucket.end ? "current" : "past",
      jd: { due: 0, done: 0, completionRate: null },
      tasks: { assigned: 0, done: 0, completionRate: null },
    }));
    for (const count of jdCounts) {
      const index = bucketIndexFor(period.buckets, count.at);
      if (index === -1) continue;
      bucketRows[index].jd.due += jdCountDue(count);
      bucketRows[index].jd.done += count.done;
    }
    for (const item of taskItems) {
      const index = bucketIndexFor(period.buckets, item.at);
      if (index === -1) continue;
      bucketRows[index].tasks.assigned += 1;
      if (item.status === "done") bucketRows[index].tasks.done += 1;
    }
    for (const row of bucketRows) {
      row.jd.completionRate = rate(row.jd.done, row.jd.due);
      row.tasks.completionRate = rate(row.tasks.done, row.tasks.assigned);
    }

    const viewScope: "team" | "self" = scope.dashboardScope === "self" || args.membershipId ? "self" : "team";
    const departmentNames = (membershipId: Id<"companyMemberships">) =>
      [...(scope.memberDepartmentIds.get(membershipId) ?? [])]
        .map((departmentId) => scope.org.departmentById.get(departmentId)?.name)
        .filter((name): name is string => Boolean(name))
        .sort()
        .join(", ");
    const branchNames = (membershipId: Id<"companyMemberships">) =>
      [...(scope.memberBranchIds.get(membershipId) ?? [])]
        .map((branchId) => scope.org.branchById.get(branchId)?.name)
        .filter((name): name is string => Boolean(name))
        .sort()
        .join(", ");

    const jdCountByRecurrence = new Map<JdRecurrence, number>();
    for (const { task } of visibleJdTasks) jdCountByRecurrence.set(task.recurrence, (jdCountByRecurrence.get(task.recurrence) ?? 0) + 1);
    const byFrequency = jdRecurrences.map((recurrence) => {
      let due = 0;
      let done = 0;
      let missed = 0;
      let waiting = 0;
      for (const count of jdCounts) {
        if (count.recurrence !== recurrence || !inPeriod(count.at)) continue;
        due += jdCountDue(count);
        done += count.done;
        missed += count.missed;
        waiting += count.waiting;
      }
      const upcomingDeadlines = upcomingByRecurrence.get(recurrence) ?? [];
      const upcoming = period.isCurrent && upcomingDeadlines.length > 0
        ? { count: upcomingDeadlines.length, dueDate: localDateField(Math.min(...upcomingDeadlines), timeZone) }
        : null;
      return { recurrence, jdCount: jdCountByRecurrence.get(recurrence) ?? 0, due, done, missed, waiting, completionRate: rate(done, due), upcoming };
    });

    const jdEmployeeTotals = new Map<Id<"companyMemberships">, { membershipId: Id<"companyMemberships">; name: string; departments: string; due: number; done: number; missed: number; waiting: number }>();
    if (viewScope === "team") {
      for (const count of jdCounts) {
        if (!inPeriod(count.at)) continue;
        for (const assigneeId of count.assigneeIds) {
          const person = scope.people.get(assigneeId);
          if (!person) continue;
          let row = jdEmployeeTotals.get(assigneeId);
          if (!row) {
            row = { membershipId: assigneeId, name: person.name, departments: departmentNames(assigneeId), due: 0, done: 0, missed: 0, waiting: 0 };
            jdEmployeeTotals.set(assigneeId, row);
          }
          row.due += jdCountDue(count);
          row.done += count.done;
          row.missed += count.missed;
          row.waiting += count.waiting;
        }
      }
    }
    const jdEmployees = [...jdEmployeeTotals.values()]
      .map((row) => ({ ...row, completionRate: Math.round((row.done / row.due) * 100) }))
      .sort((a, b) => b.completionRate - a.completionRate || b.due - a.due || a.name.localeCompare(b.name));

    const taskEmployeeTotals = new Map<Id<"companyMemberships">, { membershipId: Id<"companyMemberships">; name: string; departments: string; assigned: number; done: number; overdue: number }>();
    if (viewScope === "team") {
      for (const item of taskItems) {
        if (!inPeriod(item.at)) continue;
        for (const assigneeId of item.assigneeIds) {
          const person = scope.people.get(assigneeId);
          if (!person) continue;
          let row = taskEmployeeTotals.get(assigneeId);
          if (!row) {
            row = { membershipId: assigneeId, name: person.name, departments: departmentNames(assigneeId), assigned: 0, done: 0, overdue: 0 };
            taskEmployeeTotals.set(assigneeId, row);
          }
          row.assigned += 1;
          if (item.status === "done") row.done += 1;
          if (item.status === "overdue") row.overdue += 1;
        }
      }
    }
    const taskEmployees = [...taskEmployeeTotals.values()]
      .map((row) => ({ ...row, completionRate: Math.round((row.done / row.assigned) * 100) }))
      .sort((a, b) => b.completionRate - a.completionRate || b.assigned - a.assigned || a.name.localeCompare(b.name));

    const selfJdNotDone = viewScope === "self"
      ? await loadJdNotDone(ctx, visibleJdTasks, period, now, timeZone, maxHolidaySpanDays(calendar), unrecordedJdItems, completeness)
      : [];
    const jdNotDone = selfJdNotDone.map((item) => ({
      taskId: item.taskId,
      reference: item.reference,
      title: item.title,
      recurrence: item.recurrence,
      dueDate: localDateField(item.at, timeZone),
      status: item.status as "missed" | "waiting",
    }));

    const taskNotDoneRows = taskItems
      .filter((item): item is OneTimeItem & { status: "overdue" | "waiting" } => inPeriod(item.at) && (item.status === "overdue" || item.status === "waiting"))
      .map((item) => ({
        taskId: item.taskId,
        reference: item.reference,
        title: item.title,
        priority: item.priority,
        status: item.status,
        dueDate: item.dueDate === undefined ? null : localDateField(item.dueDate, timeZone),
        daysLate: item.status === "overdue" && item.dueDate !== undefined ? Math.max(0, localDayIndexAt(now, timeZone) - localDayIndexAt(item.dueDate, timeZone)) : null,
        assignees: item.assigneeIds
          .map((assigneeId) => scope.people.get(assigneeId)?.name)
          .filter((name): name is string => name !== undefined)
          .sort(),
      }))
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === "overdue" ? -1 : 1;
        if (a.status === "overdue") return (b.daysLate ?? 0) - (a.daysLate ?? 0) || a.title.localeCompare(b.title);
        return a.title.localeCompare(b.title);
      });
    const taskNotDone = taskNotDoneRows.slice(0, dashboardListLimit);

    const priorityOrder = ["critical", "high", "medium", "low"] as const;
    const byPriority = priorityOrder.map((priority) => {
      let assigned = 0;
      let done = 0;
      let overdue = 0;
      let waiting = 0;
      for (const item of taskItems) {
        if (item.priority !== priority || !inPeriod(item.at)) continue;
        assigned += 1;
        if (item.status === "done") done += 1;
        else if (item.status === "overdue") overdue += 1;
        else if (item.status === "waiting") waiting += 1;
      }
      return { priority, assigned, done, overdue, waiting, completionRate: rate(done, assigned) };
    });

    type EmployeeDetail = { membershipId: Id<"companyMemberships">; name: string; departments: string; branches: string };
    let employee: EmployeeDetail | null = null;
    if (args.membershipId) {
      const person = scope.people.get(args.membershipId);
      if (person) employee = { membershipId: args.membershipId, name: person.name, departments: departmentNames(args.membershipId), branches: branchNames(args.membershipId) };
    }

    return {
      isTruncated: completeness.isTruncated,
      today: localDateField(now, timeZone),
      scope: viewScope,
      period: {
        unit: period.unit,
        startDate: localDateField(period.start, timeZone),
        endDate: localDateField(period.end, timeZone),
        isCurrent: period.isCurrent,
        previousDate: localDateField(period.previous.start, timeZone),
        nextDate: period.next ? localDateField(period.next.start, timeZone) : null,
      },
      employee,
      buckets: bucketRows,
      jd: {
        due: jdDue,
        done: jdDone,
        missed: jdMissed,
        waiting: jdWaiting,
        completionRate: rate(jdDone, jdDue),
        previousCompletionRate: rate(previousJdDone, previousJdDue),
        byFrequency,
        employees: jdEmployees,
        notDone: jdNotDone,
      },
      tasks: {
        assigned: tasksAssigned,
        done: tasksDone,
        overdue: tasksOverdue,
        waiting: tasksWaiting,
        notDueYet: tasksNotDueYet,
        completionRate: rate(tasksDone, tasksAssigned),
        previousCompletionRate: rate(previousTasksDone, previousTasksAssigned),
        byPriority,
        notDone: taskNotDone,
        employees: taskEmployees,
      },
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
