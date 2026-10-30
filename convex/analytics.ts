import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import { analyticsScopedMembershipIds, assertAnalyticsViewAccess, buildSopVisibilityContext, requireMembership, sopListScopeAuth, taskHasVisibleAssignee, visibleAssigneeMembershipIds, visibleSop } from "./permissions";
import { currentJdCycle, jdRecurrences, localDateField, localDayIndexAt, nextJdCycleStart, type JdRecurrence } from "./taskCycles";
import { jdOccurrencesDueBetween, effectiveCurrentJdCycle, loadWorkCalendar, maxHolidaySpanDays, occurrenceDeadline } from "./workCalendar";
import { bucketIndexFor, dashboardPeriodValidator, resolveDashboardPeriod } from "./dashboardTime";
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

// A cycle's deadline trails its start by at most one recurrence length plus
// the longest contiguous holiday shift a deadline could have moved through.
// Reading only that far back covers every completion that could still be due
// in a window, while keeping a daily ledger inside one bounded read instead of
// scanning the annual worst case for every task.
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

type BucketState = "past" | "current" | "future";

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
    // work that has happened. The item filter below uses the full period bound
    // for done and waiting work, which can carry a deadline later this period.
    const windowStart = Math.min(period.buckets[0].start, period.previous.start);
    const windowEnd = Math.min(period.end, todayEnd);
    const calendar = await loadWorkCalendar(ctx, args.companyId);
    const holidaySpanDays = maxHolidaySpanDays(calendar);

    const [jdTasks, oneTimeTasks] = await Promise.all([
      takeBudgetedRows(
        completeness,
        (limit) => ctx.db.query("jdTasks").withIndex("by_companyId_and_pausedAt", (q) => q.eq("companyId", args.companyId).eq("pausedAt", undefined)).take(limit),
      ),
      takeBudgetedRows(
        completeness,
        (limit) => ctx.db.query("oneTimeTasks").withIndex("by_companyId_and_createdAt", (q) => q.eq("companyId", args.companyId).gte("createdAt", windowStart).lte("createdAt", windowEnd)).take(limit),
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
      // A cycle's deadline trails its start by at most this task's own
      // recurrence length plus the holiday shift, so that is the only
      // backstop these reads need.
      const cycleLookbackMs = (maxJdCycleDays[task.recurrence] + holidaySpanDays + 1) * 86_400_000;
      // Read the previous and current periods as separate bounded ranges: one
      // annual span fits the per-read cap even for a daily ledger, while the
      // union covers every cycle due in either period. The ranges are disjoint
      // by cycleStart, so no row is counted twice.
      const previousFrom = windowStart - cycleLookbackMs;
      const currentFrom = period.start - cycleLookbackMs;
      const [previousCompletions, previousMissed, previousPending] = await Promise.all([
        takeBudgetedRows(
          taskPhase,
          (limit) => ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", task._id).gte("cycleStart", previousFrom).lte("cycleStart", currentFrom - 1)).order("desc").take(limit),
        ),
        takeBudgetedRows(
          taskPhase,
          (limit) => ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleEnd", (q) => q.eq("jdTaskId", task._id).gte("cycleEnd", windowStart + 1).lte("cycleEnd", period.start)).order("desc").take(limit),
        ),
        takeBudgetedRows(
          taskPhase,
          (limit) => ctx.db.query("taskConfirmationRequests").withIndex("by_taskType_and_taskId_and_cycleStart", (q) => q.eq("taskType", "jd").eq("taskId", task._id).gte("cycleStart", previousFrom).lte("cycleStart", currentFrom - 1)).order("desc").take(limit),
        ),
      ]);
      const [currentCompletions, currentMissed, currentPending] = await Promise.all([
        takeBudgetedRows(
          taskPhase,
          (limit) => ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", task._id).gte("cycleStart", currentFrom).lte("cycleStart", windowEnd)).order("desc").take(limit),
        ),
        takeBudgetedRows(
          taskPhase,
          (limit) => ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleEnd", (q) => q.eq("jdTaskId", task._id).gte("cycleEnd", period.start + 1).lte("cycleEnd", windowEnd + 1)).order("desc").take(limit),
        ),
        takeBudgetedRows(
          taskPhase,
          (limit) => ctx.db.query("taskConfirmationRequests").withIndex("by_taskType_and_taskId_and_cycleStart", (q) => q.eq("taskType", "jd").eq("taskId", task._id).gte("cycleStart", currentFrom).lte("cycleStart", windowEnd)).order("desc").take(limit),
        ),
      ]);
      ledgersByTask.set(task._id, {
        completions: [...previousCompletions, ...currentCompletions],
        missed: [...previousMissed, ...currentMissed],
        pending: [...previousPending, ...currentPending],
        truncated: taskPhase.isTruncated,
      });
    });

    const jdItemGroups = visibleJdTasks.map(({ task, assignees }) => {
      const ledger = ledgersByTask.get(task._id)!;
      // Stored rows are individually complete, so a truncated read still
      // reports what it loaded. Reconstruction needs the whole range instead:
      // it cannot tell an unrecorded cycle from one whose completion row fell
      // outside the read, so it must not be allowed to fabricate misses.
      if (ledger.truncated) completeness.isTruncated = true;
      const { completions, missed, pending } = ledger;

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

      // Legacy rows predate cycleEnd. When the stored start no longer sits on
      // the task's grid the recurrence or timezone changed since, so the
      // recorded instant is the only trustworthy point inside that cycle.
      const cycleEndAt = (storedEnd: number | undefined, start: number, fallbackAt: number) =>
        storedEnd ?? (
          currentJdCycle(task.recurrence, start, timeZone).start === start
            ? nextJdCycleStart(start, task.recurrence, timeZone)
            : fallbackAt + 1
        );

      // A request from a superseded recurrence is history, not a live hold on
      // the current grid's cycle. A live request owns its cycle's dates: the
      // missed-cycle writer advances the task floor past a pending cycle
      // without recording it, so the cycle must come from the request row.
      const pendingStarts = new Set<number>();
      for (const request of pending) {
        if (request.cycleStart === undefined || request.recurrence !== task.recurrence) continue;
        pendingStarts.add(request.cycleStart);
        put(request.cycleStart, cycleEndAt(request.cycleEnd, request.cycleStart, request.submittedAt) - 1, false, true);
      }

      // Newer completions record their own cycleEnd; legacy rows fall back to
      // the current grid. Missed records store their own deadline, so they stay
      // exact across recurrence and timezone changes; match on it directly.
      for (const completion of completions) {
        put(completion.cycleStart, cycleEndAt(completion.cycleEnd, completion.cycleStart, completion.completedAt) - 1, true, true, completion.retiredAt);
      }
      for (const record of missed) {
        put(record.cycleStart, record.cycleEnd - 1, false, true, record.retiredAt);
      }

      // Skipped occurrences (non-working due dates on daily/alternate cycles)
      // never enter the ledger; other recurrences report their shifted
      // deadline, matching what the missed-record writer stores.
      if (!ledger.truncated) {
        const elapsed = jdOccurrencesDueBetween(calendar, task.recurrence, task.cycleStartedAt, now, windowStart, windowEnd, 200, timeZone);
        if (elapsed.truncated) completeness.isTruncated = true;
        for (const cycle of elapsed.occurrences) put(cycle.start, cycle.deadline - 1, false, false);
      }

      const taskItems: JdItem[] = [];
      const current = currentJdCycle(task.recurrence, now, timeZone);
      const currentDeadline = occurrenceDeadline(calendar, task.recurrence, current.end, timeZone);
      const onCurrentGrid = current.start >= currentJdCycle(task.recurrence, task.cycleStartedAt, timeZone).start;
      if (currentDeadline !== null && onCurrentGrid) put(current.start, currentDeadline - 1, false, false);

      for (const cycle of cycles.values()) {
        // Completed and waiting work counts wherever its deadline falls in the
        // selected period; unfinished work still ahead of now does not.
        if (cycle.start > now || cycle.dueAt < windowStart || cycle.dueAt > period.end) continue;
        const completed = cycle.completed || (!cycle.retired && task.status === "completed" && task.statusCycleStart === cycle.start);
        const waiting = !completed && pendingStarts.has(cycle.start);
        // Work counts once it is done, waiting for approval, or past its
        // deadline, so done + missed + waiting always equals due.
        if (!completed && !waiting && cycle.dueAt >= now) continue;
        taskItems.push({
          taskId: task._id,
          title: task.title,
          reference: task.reference,
          recurrence: task.recurrence,
          at: cycle.dueAt,
          status: completed ? "done" : waiting ? "waiting" : "missed",
          assigneeIds: assignees,
        });
      }

      // A current period also reports work that is due before it closes, so a
      // running month can say "3 JDs due on the 31st" instead of a bare zero.
      // The open cycle carries a still-pending shifted deadline: on Monday
      // morning the default calendar's weekly deadline belongs to last week's
      // grid cycle, not the raw cycle that started that day.
      let upcomingDeadline: number | null = null;
      if (period.isCurrent) {
        const open = effectiveCurrentJdCycle(calendar, task.recurrence, now, timeZone);
        const openDeadline = occurrenceDeadline(calendar, task.recurrence, open.end, timeZone);
        const onOpenGrid = open.start >= currentJdCycle(task.recurrence, task.cycleStartedAt, timeZone).start;
        if (openDeadline !== null && onOpenGrid) {
          const openCycle = cycles.get(`${open.start}:current`);
          const openCompleted = (openCycle?.completed ?? false) || (openCycle?.retired !== true && task.status === "completed" && task.statusCycleStart === open.start);
          const openWaiting = !openCompleted && pendingStarts.has(open.start);
          const deadline = openDeadline - 1;
          if (!openCompleted && !openWaiting && now <= deadline && deadline <= period.end) upcomingDeadline = deadline;
        }
      }
      return { items: taskItems, recurrence: task.recurrence, upcomingDeadline };
    });
    const jdItems: JdItem[] = [];
    const upcomingByRecurrence = new Map<JdRecurrence, number[]>();
    for (const group of jdItemGroups) {
      jdItems.push(...group.items);
      if (group.upcomingDeadline !== null) {
        const deadlines = upcomingByRecurrence.get(group.recurrence) ?? [];
        deadlines.push(group.upcomingDeadline);
        upcomingByRecurrence.set(group.recurrence, deadlines);
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

    let jdDue = 0;
    let jdDone = 0;
    let jdMissed = 0;
    let jdWaiting = 0;
    let previousJdDue = 0;
    let previousJdDone = 0;
    for (const item of jdItems) {
      if (inPeriod(item.at)) {
        jdDue += 1;
        if (item.status === "done") jdDone += 1;
        else if (item.status === "missed") jdMissed += 1;
        else jdWaiting += 1;
      }
      if (inPrevious(item.at)) {
        previousJdDue += 1;
        if (item.status === "done") previousJdDone += 1;
      }
    }

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
    for (const item of jdItems) {
      const index = bucketIndexFor(period.buckets, item.at);
      if (index === -1) continue;
      bucketRows[index].jd.due += 1;
      if (item.status === "done") bucketRows[index].jd.done += 1;
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
      for (const item of jdItems) {
        if (item.recurrence !== recurrence || !inPeriod(item.at)) continue;
        due += 1;
        if (item.status === "done") done += 1;
        else if (item.status === "missed") missed += 1;
        else waiting += 1;
      }
      const upcomingDeadlines = upcomingByRecurrence.get(recurrence) ?? [];
      const upcoming = period.isCurrent && upcomingDeadlines.length > 0
        ? { count: upcomingDeadlines.length, dueDate: localDateField(Math.min(...upcomingDeadlines), timeZone) }
        : null;
      return { recurrence, jdCount: jdCountByRecurrence.get(recurrence) ?? 0, due, done, missed, waiting, completionRate: rate(done, due), upcoming };
    });

    const jdEmployeeTotals = new Map<Id<"companyMemberships">, { membershipId: Id<"companyMemberships">; name: string; departments: string; due: number; done: number; missed: number; waiting: number }>();
    if (viewScope === "team") {
      for (const item of jdItems) {
        if (!inPeriod(item.at)) continue;
        for (const assigneeId of item.assigneeIds) {
          const person = scope.people.get(assigneeId);
          if (!person) continue;
          let row = jdEmployeeTotals.get(assigneeId);
          if (!row) {
            row = { membershipId: assigneeId, name: person.name, departments: departmentNames(assigneeId), due: 0, done: 0, missed: 0, waiting: 0 };
            jdEmployeeTotals.set(assigneeId, row);
          }
          row.due += 1;
          if (item.status === "done") row.done += 1;
          else if (item.status === "missed") row.missed += 1;
          else row.waiting += 1;
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

    let isTruncated = completeness.isTruncated;
    const selfJdNotDone = viewScope === "self"
      ? jdItems
          .filter((item): item is JdItem & { status: "missed" | "waiting" } => inPeriod(item.at) && item.status !== "done")
          .sort((a, b) => a.at - b.at || a.title.localeCompare(b.title))
      : [];
    const jdNotDone = selfJdNotDone.slice(0, 200).map((item) => ({
      taskId: item.taskId,
      reference: item.reference,
      title: item.title,
      recurrence: item.recurrence,
      dueDate: localDateField(item.at, timeZone),
      status: item.status,
    }));
    if (selfJdNotDone.length > 200) isTruncated = true;

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
    const taskNotDone = taskNotDoneRows.slice(0, 200);
    if (taskNotDoneRows.length > 200) isTruncated = true;

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
      isTruncated,
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
