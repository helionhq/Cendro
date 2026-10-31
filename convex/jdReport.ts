import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./functions";
import { currentJdCycle, nextJdCycleStart } from "./taskCycles";

/**
 * Dashboard JD totals, maintained from the ledger instead of rebuilt per read.
 *
 * Every cycle outcome a task's ledger rows describe is counted once, by its
 * deadline's week-within-month segment, in a jdReportTotals row keyed by the
 * task's assignee set. Refreshes recompute one task's cycles starting in one
 * month straight from the ledger and swap the old contribution for the new,
 * so the totals always equal a fresh merge no matter which write changed
 * what. jdReportTriggers.ts notes every write to the ledger, the task, the
 * company time zone, and functions.ts applies them before the writing
 * mutation commits. Every completion writes a ledger row, so the task's
 * status stamp and the work calendar never enter a stored count: deadlines
 * come from the rows themselves.
 *
 * The one input the totals do not cover is time: an elapsed cycle nobody
 * recorded yet. The hourly missed-cycle job records those, and until it runs
 * the dashboard reconstructs them live from each task's cycle floor.
 */

export type JdLedgerRows = {
  completions: Doc<"jdTaskCompletions">[];
  missed: Doc<"jdTaskCycleRecords">[];
  pending: Doc<"taskConfirmationRequests">[];
};
export type JdOutcome = { start: number; dueAt: number; retired: boolean; status: "done" | "missed" | "waiting" };
type JdReportCount = Doc<"jdReportTotals">["counts"][number];
type JdReportMonthCount = Doc<"jdReportTaskMonths">["counts"][number];

// A task's cycles in one month are at most a few dozen rows per table; this
// only guards against a runaway ledger, and a refresh fails loudly past it
// rather than storing a partial count.
const ledgerMonthLimit = 2_000;
const rebuildPageSize = 4;
// A rebuild refreshes this many months per transaction. A company page covers
// rebuildPageSize tasks, so even when every one continues that is about the
// inline month-refresh budget below; each month costs a few dozen ledger
// reads, and the first page also removes the task's stored contributions.
const rebuildMonthsPerPage = 6;

/**
 * Merges one task's stored ledger rows into one outcome per cycle. Callers
 * pass every row stored at each cycle start they cover.
 */
export function jdLedgerOutcomes(
  task: Pick<Doc<"jdTasks">, "recurrence">,
  timeZone: string | null,
  rows: JdLedgerRows,
): JdOutcome[] {
  const cycles = new Map<string, { start: number; retired: boolean; dueAt: number; completed: boolean }>();
  // Group rows by grid lifetime as well as start: retired work must not
  // complete a reset grid, but its completion and miss still count once.
  // Completed rows own their stored deadlines; a stale missed record must not
  // rewrite completed history.
  const put = (start: number, dueAt: number, completed: boolean, retiredAt?: number) => {
    const key = `${start}:${retiredAt ?? "current"}`;
    const existing = cycles.get(key);
    cycles.set(key, {
      start,
      retired: retiredAt !== undefined,
      dueAt: existing?.completed && !completed ? existing.dueAt : dueAt,
      completed: (existing?.completed ?? false) || completed,
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
  for (const request of rows.pending) {
    if (request.cycleStart === undefined || request.recurrence !== task.recurrence) continue;
    pendingStarts.add(request.cycleStart);
    put(request.cycleStart, cycleEndAt(request.cycleEnd, request.cycleStart, request.submittedAt) - 1, false);
  }
  // Newer completions record their own cycleEnd; legacy rows fall back to
  // the current grid. Missed records store their own deadline, so they stay
  // exact across recurrence and timezone changes.
  for (const completion of rows.completions) {
    put(completion.cycleStart, cycleEndAt(completion.cycleEnd, completion.cycleStart, completion.completedAt) - 1, true, completion.retiredAt);
  }
  for (const record of rows.missed) put(record.cycleStart, record.cycleEnd - 1, false, record.retiredAt);

  return [...cycles.values()].map((cycle) => ({
    start: cycle.start,
    dueAt: cycle.dueAt,
    retired: cycle.retired,
    status: cycle.completed ? "done" : pendingStarts.has(cycle.start) ? "waiting" : "missed",
  }));
}

/**
 * Work counts once it is done, waiting for approval, or past its deadline, so
 * done + missed + waiting always equals due; nothing counts before its cycle
 * starts.
 */
export function jdOutcomeCountableAt(outcome: Pick<JdOutcome, "start" | "dueAt" | "status">) {
  return outcome.status === "missed" ? Math.max(outcome.start, outcome.dueAt + 1) : outcome.start;
}

function jdReportSegment(at: number, timeZone: string | null) {
  const monthStart = currentJdCycle("monthly", at, timeZone).start;
  return { monthStart, segmentStart: Math.max(monthStart, currentJdCycle("weekly", at, timeZone).start) };
}

async function companyTimeZone(ctx: MutationCtx, companyId: Id<"companies">) {
  return (await ctx.db.get(companyId))?.timeZone ?? null;
}

async function ledgerRowsStartingBetween(ctx: MutationCtx, jdTaskId: Id<"jdTasks">, from: number, to: number): Promise<JdLedgerRows> {
  const bounded = async <T>(rows: Promise<T[]>) => {
    const loaded = await rows;
    if (loaded.length > ledgerMonthLimit) throw new Error(`JD task ${jdTaskId} has more than ${ledgerMonthLimit} ledger rows in one month.`);
    return loaded;
  };
  const [completions, missed, pending] = await Promise.all([
    bounded(ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", jdTaskId).gte("cycleStart", from).lte("cycleStart", to)).take(ledgerMonthLimit + 1)),
    bounded(ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", jdTaskId).gte("cycleStart", from).lte("cycleStart", to)).take(ledgerMonthLimit + 1)),
    bounded(ctx.db.query("taskConfirmationRequests").withIndex("by_taskType_and_taskId_and_cycleStart", (q) => q.eq("taskType", "jd").eq("taskId", jdTaskId).gte("cycleStart", from).lte("cycleStart", to)).take(ledgerMonthLimit + 1)),
  ]);
  return { completions, missed, pending };
}

/** What one task's cycles starting in one month count, and when the next of them becomes countable. */
async function taskMonthCounts(ctx: MutationCtx, task: Doc<"jdTasks">, timeZone: string | null, monthStart: number, now: number) {
  const monthEnd = nextJdCycleStart(monthStart, "monthly", timeZone) - 1;
  const outcomes = jdLedgerOutcomes(task, timeZone, await ledgerRowsStartingBetween(ctx, task._id, monthStart, monthEnd));

  const bySegment = new Map<number, JdReportMonthCount>();
  let nextCountableAt: number | null = null;
  for (const outcome of outcomes) {
    const countableAt = jdOutcomeCountableAt(outcome);
    if (countableAt > now) {
      nextCountableAt = Math.min(nextCountableAt ?? countableAt, countableAt);
      continue;
    }
    const segment = jdReportSegment(outcome.dueAt, timeZone);
    let entry = bySegment.get(segment.segmentStart);
    if (!entry) {
      entry = { monthStart: segment.monthStart, count: { segmentStart: segment.segmentStart, recurrence: task.recurrence, done: 0, missed: 0, waiting: 0 } };
      bySegment.set(segment.segmentStart, entry);
    }
    entry.count[outcome.status] += 1;
  }
  return { counts: [...bySegment.values()].sort((a, b) => a.count.segmentStart - b.count.segmentStart), nextCountableAt };
}

async function addToTotals(ctx: MutationCtx, companyId: Id<"companies">, assigneeIds: readonly Id<"companyMemberships">[], counts: readonly JdReportMonthCount[], sign: 1 | -1) {
  if (assigneeIds.length === 0 || counts.length === 0) return;
  const assigneeMembershipIds = [...new Set(assigneeIds)].sort();
  const assigneeKey = assigneeMembershipIds.join(",");
  const byMonth = new Map<number, JdReportCount[]>();
  for (const { monthStart, count } of counts) byMonth.set(monthStart, [...(byMonth.get(monthStart) ?? []), count]);
  for (const [monthStart, monthCounts] of byMonth) {
    const row = await ctx.db.query("jdReportTotals").withIndex("by_companyId_and_monthStart_and_assigneeKey", (q) => q.eq("companyId", companyId).eq("monthStart", monthStart).eq("assigneeKey", assigneeKey)).unique();
    const merged = new Map((row?.counts ?? []).map((count) => [`${count.segmentStart}:${count.recurrence}`, { ...count }]));
    for (const count of monthCounts) {
      const key = `${count.segmentStart}:${count.recurrence}`;
      const total = merged.get(key) ?? { segmentStart: count.segmentStart, recurrence: count.recurrence, done: 0, missed: 0, waiting: 0 };
      total.done += sign * count.done;
      total.missed += sign * count.missed;
      total.waiting += sign * count.waiting;
      merged.set(key, total);
    }
    const next = [...merged.values()].filter((count) => count.done || count.missed || count.waiting);
    if (row && next.length) await ctx.db.patch(row._id, { counts: next });
    else if (row) await ctx.db.delete(row._id);
    else if (next.length) await ctx.db.insert("jdReportTotals", { companyId, monthStart, assigneeKey, assigneeMembershipIds, counts: next });
  }
}

async function refreshTaskMonth(ctx: MutationCtx, jdTaskId: Id<"jdTasks">, monthStart: number) {
  const now = Date.now();
  const [task, previous] = await Promise.all([
    ctx.db.get(jdTaskId),
    ctx.db.query("jdReportTaskMonths").withIndex("by_jdTaskId_and_monthStart", (q) => q.eq("jdTaskId", jdTaskId).eq("monthStart", monthStart)).unique(),
  ]);
  const timeZone = task ? await companyTimeZone(ctx, task.companyId) : null;
  // A refresh queued before a time-zone change carries the old zone's month
  // key; the change rebuilds the task under the new keys, so counting it here
  // would add the same cycles a second time.
  if (task && currentJdCycle("monthly", monthStart, timeZone).start !== monthStart) return;
  // Paused and deleted tasks drop out of the report, as they do from the task list.
  const next = task && task.pausedAt === undefined
    ? await taskMonthCounts(ctx, task, timeZone, monthStart, now)
    : { counts: [], nextCountableAt: null };
  if (next.nextCountableAt !== null) {
    await ctx.scheduler.runAfter(next.nextCountableAt - now, internal.jdReport.refreshMonthsLater, { months: [{ jdTaskId, monthStart }] });
  }
  const assigneeMembershipIds = task?.assigneeMembershipIds ?? [];
  if (previous && JSON.stringify([previous.assigneeMembershipIds, previous.counts]) === JSON.stringify([assigneeMembershipIds, next.counts])) return;
  if (previous) await addToTotals(ctx, previous.companyId, previous.assigneeMembershipIds, previous.counts, -1);
  if (task) await addToTotals(ctx, task.companyId, assigneeMembershipIds, next.counts, 1);
  if (task && next.counts.length) {
    const doc = { companyId: task.companyId, jdTaskId, monthStart, assigneeMembershipIds, counts: next.counts };
    if (previous) await ctx.db.replace(previous._id, doc);
    else await ctx.db.insert("jdReportTaskMonths", doc);
  } else if (previous) {
    await ctx.db.delete(previous._id);
  }
}

async function removeTaskContributions(ctx: MutationCtx, jdTaskId: Id<"jdTasks">) {
  const previous = await ctx.db.query("jdReportTaskMonths").withIndex("by_jdTaskId_and_monthStart", (q) => q.eq("jdTaskId", jdTaskId)).take(ledgerMonthLimit);
  for (const contribution of previous) {
    await addToTotals(ctx, contribution.companyId, contribution.assigneeMembershipIds, contribution.counts, -1);
    await ctx.db.delete(contribution._id);
  }
}

/**
 * Rebuilds one bounded page of a task's report, returning the next month to
 * refresh or null when its history is done. The first page also removes the
 * task's existing contributions first rather than refreshing them: after a
 * time-zone change their month keys no longer match the ledger's month
 * boundaries, and refreshTaskMonth skips misaligned keys instead of replacing
 * stale rows.
 */
export async function rebuildJdTaskReportPage(ctx: MutationCtx, jdTaskId: Id<"jdTasks">, cursor?: number): Promise<number | null> {
  if (cursor === undefined) await removeTaskContributions(ctx, jdTaskId);
  const task = await ctx.db.get(jdTaskId);
  // Paused and deleted tasks keep no contribution. A rebuild queued by the
  // pause or delete trigger removes it on its own first page.
  if (!task || task.pausedAt !== undefined) return null;
  const timeZone = await companyTimeZone(ctx, task.companyId);
  // Recompute the range each page so the cursor stays one month; ledger rows
  // written mid-rebuild are refreshed by their own triggers and can only
  // extend it.
  const ends = await Promise.all((["asc", "desc"] as const).flatMap((order) => [
    ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", jdTaskId)).order(order).first(),
    ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", jdTaskId)).order(order).first(),
    ctx.db.query("taskConfirmationRequests").withIndex("by_taskType_and_taskId_and_cycleStart", (q) => q.eq("taskType", "jd").eq("taskId", jdTaskId).gte("cycleStart", 0)).order(order).first(),
  ]));
  const starts = ends.flatMap((row) => (row?.cycleStart === undefined ? [] : [row.cycleStart]));
  if (starts.length === 0) return null;
  const last = Math.max(...starts);
  let monthStart = cursor ?? currentJdCycle("monthly", Math.min(...starts), timeZone).start;
  for (let refreshed = 0; refreshed < rebuildMonthsPerPage && monthStart <= last; refreshed++) {
    await refreshTaskMonth(ctx, jdTaskId, monthStart);
    monthStart = nextJdCycleStart(monthStart, "monthly", timeZone);
  }
  return monthStart <= last ? monthStart : null;
}

// One transaction's share of report work; the rest continues in a single
// follow-up job. A month costs a few dozen ledger reads; a task rebuild costs
// one bounded page of them.
const inlineMonthRefreshes = 25;
const inlineTaskRebuilds = 4;
const monthsValidator = v.array(v.object({ jdTaskId: v.id("jdTasks"), monthStart: v.number() }));

async function refreshMonths(ctx: MutationCtx, months: { jdTaskId: Id<"jdTasks">; monthStart: number }[]) {
  for (const { jdTaskId, monthStart } of months.slice(0, inlineMonthRefreshes)) await refreshTaskMonth(ctx, jdTaskId, monthStart);
  if (months.length > inlineMonthRefreshes) await ctx.scheduler.runAfter(0, internal.jdReport.refreshMonthsLater, { months: months.slice(inlineMonthRefreshes) });
}

/**
 * Rebuilds one page of each task in turn, stopping at the first task whose
 * history outlasts its page. The continuation resumes that task with the same
 * queue, so one job keeps writing the totals rows rather than fanning out.
 */
async function rebuildTaskQueue(ctx: MutationCtx, jdTaskIds: Id<"jdTasks">[], cursor?: number): Promise<{ remaining: Id<"jdTasks">[]; monthStart?: number }> {
  let remaining = jdTaskIds;
  let next = cursor;
  for (let rebuilt = 0; rebuilt < inlineTaskRebuilds && remaining.length > 0; rebuilt++) {
    const monthStart = await rebuildJdTaskReportPage(ctx, remaining[0], next);
    if (monthStart !== null) return { remaining, monthStart };
    remaining = remaining.slice(1);
    next = undefined;
  }
  return { remaining };
}

async function rebuildTasks(ctx: MutationCtx, jdTaskIds: Id<"jdTasks">[], cursor?: number) {
  const { remaining, monthStart } = await rebuildTaskQueue(ctx, jdTaskIds, cursor);
  if (remaining.length === 0) return;
  await ctx.scheduler.runAfter(0, internal.jdReport.rebuildTasksLater, { jdTaskIds: remaining, ...(monthStart === undefined ? {} : { monthStart }) });
}

/**
 * Brings the report up to date with one mutation's writes, inside that
 * mutation's transaction (see functions.ts). Overflow continues in one
 * sequential job, so a bulk change never fans out into concurrent writers of
 * the same totals rows.
 */
export const applyLedgerWrites = internalMutation({
  args: { months: monthsValidator, tasks: v.array(v.id("jdTasks")), companies: v.array(v.id("companies")) },
  handler: async (ctx, args) => {
    const rebuilt = new Set(args.tasks);
    await refreshMonths(ctx, args.months.filter((month) => !rebuilt.has(month.jdTaskId)));
    await rebuildTasks(ctx, args.tasks);
    for (const companyId of args.companies) await ctx.scheduler.runAfter(0, internal.jdReport.rebuildCompany, { companyId });
    return null;
  },
});

export const refreshMonthsLater = internalMutation({
  args: { months: monthsValidator },
  handler: async (ctx, args) => {
    await refreshMonths(ctx, args.months);
    return null;
  },
});

export const rebuildTasksLater = internalMutation({
  args: { jdTaskIds: v.array(v.id("jdTasks")), monthStart: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await rebuildTasks(ctx, args.jdTaskIds, args.monthStart);
    return null;
  },
});

/**
 * Rebuilds every JD task of a company a page of tasks per transaction, with
 * each task's months paged too. A carried task finishes before the next
 * company page starts, so the job stays sequential. Idempotent; safe to rerun.
 */
export const rebuildCompany = internalMutation({
  args: { companyId: v.id("companies"), cursor: v.optional(v.union(v.string(), v.null())), jdTaskIds: v.optional(v.array(v.id("jdTasks"))), monthStart: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (args.jdTaskIds?.length) {
      const { remaining, monthStart } = await rebuildTaskQueue(ctx, args.jdTaskIds, args.monthStart);
      if (remaining.length > 0) {
        await ctx.scheduler.runAfter(0, internal.jdReport.rebuildCompany, { companyId: args.companyId, cursor: args.cursor ?? null, jdTaskIds: remaining, ...(monthStart === undefined ? {} : { monthStart }) });
      } else {
        // The carried tasks are done; fetch the next company page in a fresh
        // transaction rather than extending this one.
        await ctx.scheduler.runAfter(0, internal.jdReport.rebuildCompany, { companyId: args.companyId, cursor: args.cursor ?? null });
      }
      return null;
    }
    const page = await ctx.db.query("jdTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).paginate({ numItems: rebuildPageSize, cursor: args.cursor ?? null });
    const { remaining, monthStart } = await rebuildTaskQueue(ctx, page.page.map((task) => task._id));
    if (remaining.length > 0) {
      await ctx.scheduler.runAfter(0, internal.jdReport.rebuildCompany, { companyId: args.companyId, cursor: page.continueCursor, jdTaskIds: remaining, ...(monthStart === undefined ? {} : { monthStart }) });
    } else if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.jdReport.rebuildCompany, { companyId: args.companyId, cursor: page.continueCursor });
    }
    return null;
  },
});

/** Backfill: `npx convex run jdReport:rebuildAll` once after deploying the report tables. */
export const rebuildAll = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("companies").paginate({ numItems: 50, cursor: args.cursor ?? null });
    for (const company of page.page) await ctx.scheduler.runAfter(0, internal.jdReport.rebuildCompany, { companyId: company._id });
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.jdReport.rebuildAll, { cursor: page.continueCursor });
    return null;
  },
});
