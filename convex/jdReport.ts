import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./functions";
import { currentJdCycle, nextJdCycleStart } from "./taskCycles";
import { loadWorkCalendar, occurrenceDeadline } from "./workCalendar";

/**
 * Dashboard JD totals, maintained from the ledger instead of rebuilt per read.
 *
 * Every cycle outcome a task's ledger rows describe is counted once, by its
 * deadline's week-within-month segment, in a jdReportTotals row keyed by the
 * task's assignee set. Refreshes recompute one task's cycles starting in one
 * month straight from the ledger and swap the old contribution for the new,
 * so the totals always equal a fresh merge no matter which write changed
 * what. jdReportTriggers.ts notes every write to the ledger, the task, or the
 * company time zone, and functions.ts applies them before the writing
 * mutation commits.
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

/**
 * Merges one task's stored ledger rows into one outcome per cycle. Callers
 * pass every row stored at each cycle start they cover.
 */
export function jdLedgerOutcomes(
  task: Pick<Doc<"jdTasks">, "recurrence" | "status" | "statusCycleStart">,
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

  return [...cycles.values()].map((cycle) => {
    const completed = cycle.completed || (!cycle.retired && task.status === "completed" && task.statusCycleStart === cycle.start);
    return { start: cycle.start, dueAt: cycle.dueAt, retired: cycle.retired, status: completed ? "done" : pendingStarts.has(cycle.start) ? "waiting" : "missed" };
  });
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
  // Legacy tasks completed before the completion ledger existed: the stamp is
  // the only record of a cycle still on the task's grid. The missed-cycle job
  // turns it into a row before the floor moves past it.
  const stamp = task.statusCycleStart;
  if (task.status === "completed" && stamp !== undefined && stamp >= monthStart && stamp <= monthEnd && !outcomes.some((outcome) => outcome.start === stamp && !outcome.retired)) {
    const calendar = await loadWorkCalendar(ctx, task.companyId);
    const deadline = occurrenceDeadline(calendar, task.recurrence, nextJdCycleStart(stamp, task.recurrence, timeZone), timeZone);
    if (deadline !== null && stamp >= currentJdCycle(task.recurrence, task.cycleStartedAt, timeZone).start) {
      outcomes.push({ start: stamp, dueAt: deadline - 1, retired: false, status: "done" });
    }
  }

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

/**
 * Recomputes every month of one task's report. Existing contributions are
 * removed first rather than refreshed: after a time-zone change their month
 * keys no longer match the ledger's month boundaries.
 */
export async function rebuildJdTaskReport(ctx: MutationCtx, jdTaskId: Id<"jdTasks">) {
  const previous = await ctx.db.query("jdReportTaskMonths").withIndex("by_jdTaskId_and_monthStart", (q) => q.eq("jdTaskId", jdTaskId)).take(ledgerMonthLimit);
  for (const contribution of previous) {
    await addToTotals(ctx, contribution.companyId, contribution.assigneeMembershipIds, contribution.counts, -1);
    await ctx.db.delete(contribution._id);
  }
  const task = await ctx.db.get(jdTaskId);
  if (!task || task.pausedAt !== undefined) return;
  const timeZone = await companyTimeZone(ctx, task.companyId);
  const ends = await Promise.all((["asc", "desc"] as const).flatMap((order) => [
    ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", jdTaskId)).order(order).first(),
    ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", jdTaskId)).order(order).first(),
    ctx.db.query("taskConfirmationRequests").withIndex("by_taskType_and_taskId_and_cycleStart", (q) => q.eq("taskType", "jd").eq("taskId", jdTaskId).gte("cycleStart", 0)).order(order).first(),
  ]));
  const starts = ends.flatMap((row) => (row?.cycleStart === undefined ? [] : [row.cycleStart]));
  if (task.status === "completed" && task.statusCycleStart !== undefined) starts.push(task.statusCycleStart);
  if (starts.length === 0) return;
  const last = Math.max(...starts);
  for (let monthStart = currentJdCycle("monthly", Math.min(...starts), timeZone).start; monthStart <= last; monthStart = nextJdCycleStart(monthStart, "monthly", timeZone)) {
    await refreshTaskMonth(ctx, jdTaskId, monthStart);
  }
}

// One transaction's share of report work; the rest continues in a single
// follow-up job. A month costs a few dozen ledger reads, a task rebuild that
// for every month of its history.
const inlineMonthRefreshes = 25;
const inlineTaskRebuilds = 4;
const monthsValidator = v.array(v.object({ jdTaskId: v.id("jdTasks"), monthStart: v.number() }));

async function refreshMonths(ctx: MutationCtx, months: { jdTaskId: Id<"jdTasks">; monthStart: number }[]) {
  for (const { jdTaskId, monthStart } of months.slice(0, inlineMonthRefreshes)) await refreshTaskMonth(ctx, jdTaskId, monthStart);
  if (months.length > inlineMonthRefreshes) await ctx.scheduler.runAfter(0, internal.jdReport.refreshMonthsLater, { months: months.slice(inlineMonthRefreshes) });
}

async function rebuildTasks(ctx: MutationCtx, jdTaskIds: Id<"jdTasks">[]) {
  for (const jdTaskId of jdTaskIds.slice(0, inlineTaskRebuilds)) await rebuildJdTaskReport(ctx, jdTaskId);
  if (jdTaskIds.length > inlineTaskRebuilds) await ctx.scheduler.runAfter(0, internal.jdReport.rebuildTasksLater, { jdTaskIds: jdTaskIds.slice(inlineTaskRebuilds) });
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
  args: { jdTaskIds: v.array(v.id("jdTasks")) },
  handler: async (ctx, args) => {
    await rebuildTasks(ctx, args.jdTaskIds);
    return null;
  },
});

/** Rebuilds every JD task of a company a page per transaction. Idempotent; safe to rerun. */
export const rebuildCompany = internalMutation({
  args: { companyId: v.id("companies"), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("jdTasks").withIndex("by_company", (q) => q.eq("companyId", args.companyId)).paginate({ numItems: rebuildPageSize, cursor: args.cursor ?? null });
    for (const task of page.page) await rebuildJdTaskReport(ctx, task._id);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.jdReport.rebuildCompany, { companyId: args.companyId, cursor: page.continueCursor });
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
