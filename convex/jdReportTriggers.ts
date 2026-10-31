import type { Triggers } from "convex-helpers/server/triggers";
import type { DataModel, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { currentJdCycle } from "./taskCycles";

// Kept apart from jdReport.ts: functions.ts loads these triggers before any
// mutation module, so this file must not import one.

export type JdReportWork = {
  months: { jdTaskId: Id<"jdTasks">; monthStart: number }[];
  tasks: Id<"jdTasks">[];
  companies: Id<"companies">[];
};

type PendingWork = {
  months: Map<string, { jdTaskId: Id<"jdTasks">; monthStart: number }>;
  tasks: Set<Id<"jdTasks">>;
  companies: Set<Id<"companies">>;
  timeZones: Map<Id<"companies">, string | null>;
};

// A mutation can write many rows of one task-month (the missed-cycle job
// records a batch at once), so triggers only note what changed and the report
// is refreshed once, when the mutation finishes. Keyed by the mutation's own
// scheduler, which every trigger ctx and the finished ctx share.
const pendingByMutation = new WeakMap<object, PendingWork>();

function pending(ctx: MutationCtx) {
  let work = pendingByMutation.get(ctx.scheduler);
  if (!work) {
    work = { months: new Map(), tasks: new Set(), companies: new Set(), timeZones: new Map() };
    pendingByMutation.set(ctx.scheduler, work);
  }
  return work;
}

/** The report work this mutation's writes created, or null when there is none. */
export function takeJdReportWork(ctx: MutationCtx): JdReportWork | null {
  const work = pendingByMutation.get(ctx.scheduler);
  pendingByMutation.delete(ctx.scheduler);
  if (!work || (work.months.size === 0 && work.tasks.size === 0 && work.companies.size === 0)) return null;
  return { months: [...work.months.values()], tasks: [...work.tasks], companies: [...work.companies] };
}

async function noteCycle(ctx: MutationCtx, companyId: Id<"companies">, jdTaskId: Id<"jdTasks">, cycleStart: number) {
  const work = pending(ctx);
  if (!work.timeZones.has(companyId)) work.timeZones.set(companyId, (await ctx.db.get(companyId))?.timeZone ?? null);
  const monthStart = currentJdCycle("monthly", cycleStart, work.timeZones.get(companyId)).start;
  work.months.set(`${jdTaskId}:${monthStart}`, { jdTaskId, monthStart });
}

export function registerJdReportTriggers(triggers: Triggers<DataModel>) {
  triggers.register("jdTaskCompletions", async (ctx, change) => {
    for (const row of [change.oldDoc, change.newDoc]) if (row) await noteCycle(ctx, row.companyId, row.jdTaskId, row.cycleStart);
  });
  triggers.register("jdTaskCycleRecords", async (ctx, change) => {
    for (const row of [change.oldDoc, change.newDoc]) if (row) await noteCycle(ctx, row.companyId, row.jdTaskId, row.cycleStart);
  });
  triggers.register("taskConfirmationRequests", async (ctx, change) => {
    for (const row of [change.oldDoc, change.newDoc]) {
      const jdTaskId = row?.taskType === "jd" ? ctx.db.normalizeId("jdTasks", row.taskId) : null;
      if (row && jdTaskId && row.cycleStart !== undefined) await noteCycle(ctx, row.companyId, jdTaskId, row.cycleStart);
    }
  });
  triggers.register("jdTasks", async (ctx, change) => {
    const { oldDoc, newDoc } = change;
    // A new task has no ledger yet.
    if (!oldDoc) return;
    // Pausing, recurrence, and assignees reshape the whole history.
    if (!newDoc || oldDoc.pausedAt !== newDoc.pausedAt || oldDoc.recurrence !== newDoc.recurrence || oldDoc.assigneeMembershipIds.join() !== newDoc.assigneeMembershipIds.join()) {
      pending(ctx).tasks.add(change.id);
      return;
    }
    // The completion stamp and the cycle floor decide the stamped cycle.
    if (oldDoc.status === newDoc.status && oldDoc.statusCycleStart === newDoc.statusCycleStart && oldDoc.cycleStartedAt === newDoc.cycleStartedAt) return;
    for (const task of [oldDoc, newDoc]) {
      if (task.statusCycleStart !== undefined) await noteCycle(ctx, task.companyId, change.id, task.statusCycleStart);
    }
  });
  // Months and week segments are company-local.
  triggers.register("companies", async (ctx, change) => {
    if (change.oldDoc && change.newDoc && change.oldDoc.timeZone !== change.newDoc.timeZone) pending(ctx).companies.add(change.id);
  });
  // Calendar edits move the deadline of a legacy completion stamp, so the
  // company's whole report is rebuilt.
  triggers.register("companyCalendars", async (ctx, change) => {
    const row = change.newDoc ?? change.oldDoc;
    if (row) pending(ctx).companies.add(row.companyId);
  });
  triggers.register("companyHolidays", async (ctx, change) => {
    const row = change.newDoc ?? change.oldDoc;
    if (row) pending(ctx).companies.add(row.companyId);
  });
}
