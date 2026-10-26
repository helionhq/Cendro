/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { currentJdCycle, nextJdCycleStart, previousJdCycleStart } from "./taskCycles";

const modules = import.meta.glob("./**/*.ts");

function identity(key: string, email = `${key}@example.com`) {
  return { tokenIdentifier: `clerk|${key}`, subject: key, issuer: "https://clerk.test", email, name: key };
}

function utc(year: number, month: number, day: number, hour = 0, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute);
}

async function seedCompany(timeZone = "UTC") {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const companyId = await ctx.db.insert("companies", { name: "Acme", timeZone, createdAt: now });
    // These tests assert the raw recurrence grid; an all-week calendar keeps
    // the work-calendar overlay out of the picture.
    await ctx.db.insert("companyCalendars", { companyId, workingDays: [0, 1, 2, 3, 4, 5, 6], updatedAt: now });
    const adminUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", firstName: "Admin", secondName: "", createdAt: now, updatedAt: now });
    const adminMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: adminUserId, role: "Admin", active: true, createdAt: now, updatedAt: now });
    return { companyId, adminMembershipId };
  });
  return { t, ...ids };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("JD task cycle behavior", () => {
  test("weekly JD task created on Thursday uses the fixed Monday-to-Monday cycle", async () => {
    vi.setSystemTime(utc(2026, 6, 25, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();

    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Weekly review", description: "", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });
    const detail = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });

    expect(detail.task.state.rawStatus).toBe("due");
    expect(detail.task.state.currentCycleStart).toBe(utc(2026, 6, 22));
    expect(detail.task.state.currentCycleEnd).toBe(utc(2026, 6, 29));
  });

  test("semi-monthly JD task created after the 15th uses the second half of the month", async () => {
    vi.setSystemTime(utc(2026, 6, 25, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();

    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Semi-monthly review", description: "", recurrence: "semimonthly", assigneeMembershipIds: [adminMembershipId] });
    const detail = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });
    const rows = await t.withIdentity(identity("admin")).query(api.tasks.listJdRows, { companyId, frequency: "semimonthly", paginationOpts: { numItems: 10, cursor: null } });

    expect(detail.task.state.rawStatus).toBe("due");
    expect(detail.task.state.currentCycleStart).toBe(utc(2026, 6, 16));
    expect(detail.task.state.currentCycleEnd).toBe(utc(2026, 7, 1));
    expect(rows.page.find((row) => row._id === taskId)?.recurrence).toBe("semimonthly");
  });

  test("daily JD task uses the company time zone across local midnight", async () => {
    vi.setSystemTime(utc(2026, 6, 26, 3, 30));
    const { t, companyId, adminMembershipId } = await seedCompany("America/New_York");

    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Daily check", description: "", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    const beforeMidnight = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });

    expect(beforeMidnight.task.state.currentCycleStart).toBe(utc(2026, 6, 25, 4));
    expect(beforeMidnight.task.state.currentCycleEnd).toBe(utc(2026, 6, 26, 4));

    vi.setSystemTime(utc(2026, 6, 26, 4));
    const afterMidnight = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });

    expect(afterMidnight.task.state.currentCycleStart).toBe(utc(2026, 6, 26, 4));
  });

  test("weekly JD task rolls into the next Monday cycle and resets to pending", async () => {
    vi.setSystemTime(utc(2026, 6, 25, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Weekly review", description: "", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });
    await t.withIdentity(identity("admin")).mutation(api.tasks.updateJdStatus, { companyId, taskId, status: "in_progress" });

    vi.setSystemTime(utc(2026, 6, 29));
    const detail = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });

    expect(detail.task.state.rawStatus).toBe("due");
    expect(detail.task.state.status).toBe("Pending");
    expect(detail.task.state.currentCycleStart).toBe(utc(2026, 6, 29));
  });

  test("daily JD task rolls over at midnight and resets to pending", async () => {
    vi.setSystemTime(utc(2026, 6, 26, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Daily check", description: "", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    await t.withIdentity(identity("admin")).mutation(api.tasks.updateJdStatus, { companyId, taskId, status: "in_progress" });

    vi.setSystemTime(utc(2026, 6, 27));
    const detail = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });

    expect(detail.task.state.rawStatus).toBe("due");
    expect(detail.task.state.currentCycleStart).toBe(utc(2026, 6, 27));
  });

  test("missed previous JD cycle is recorded historically but current task is not overdue", async () => {
    vi.setSystemTime(utc(2026, 6, 25, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Weekly review", description: "", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });
    await t.withIdentity(identity("admin")).mutation(api.tasks.updateJdStatus, { companyId, taskId, status: "in_progress" });

    vi.setSystemTime(utc(2026, 6, 29));
    await t.withIdentity(identity("admin")).mutation(api.tasks.updateJd, { companyId, taskId, title: "Weekly review", description: "", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });
    // Missed-cycle catch-up runs as a scheduled mutation off the edit path.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const detail = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });
    const rows = await t.withIdentity(identity("admin")).query(api.tasks.listJdRows, { companyId, frequency: "weekly", paginationOpts: { numItems: 10, cursor: null } });
    const records = await t.withIdentity(identity("admin")).query(api.tasks.listJdCycleRecords, { companyId, taskId });

    expect(detail.task.state.rawStatus).toBe("due");
    expect(detail.task.state.isOverdue).toBe(false);
    expect(rows.page.find((row) => row._id === taskId)?.state.rawStatus).toBe("due");
    expect(records).toMatchObject([{ cycleStart: utc(2026, 6, 22), cycleEnd: utc(2026, 6, 29), status: "missed" }]);
  });

  test("changing recurrence still records the old schedule's elapsed cycles", async () => {
    vi.setSystemTime(utc(2026, 6, 1, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Weekly review", description: "", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });

    vi.setSystemTime(utc(2026, 6, 29, 12));
    await t.withIdentity(identity("admin")).mutation(api.tasks.updateJd, { companyId, taskId, title: "Weekly review", description: "", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    // Deferred catch-up reconstructs the old weekly grid from the snapshot
    // passed by updateJd — by now the task document already says "daily".
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const records = await t.withIdentity(identity("admin")).query(api.tasks.listJdCycleRecords, { companyId, taskId });
    const detail = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });
    expect(detail.task.recurrence).toBe("daily");
    expect(records).toHaveLength(4);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ cycleStart: utc(2026, 6, 1), cycleEnd: utc(2026, 6, 8), status: "missed" }),
      expect.objectContaining({ cycleStart: utc(2026, 6, 22), cycleEnd: utc(2026, 6, 29), status: "missed" }),
    ]));
  });

  test("reads legacy missed-cycle records that carry a schedule generation", async () => {
    vi.setSystemTime(utc(2026, 6, 25, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, {
      companyId,
      title: "Legacy record task",
      recurrence: "daily",
      assigneeMembershipIds: [adminMembershipId],
    });

    await t.run(async (ctx) => {
      await ctx.db.insert("jdTaskCycleRecords", {
        companyId,
        jdTaskId: taskId,
        cycleStart: utc(2026, 6, 24),
        cycleEnd: utc(2026, 6, 25),
        status: "missed",
        recordedAt: utc(2026, 6, 25, 12),
        scheduleGeneration: 1,
      });
    });

    await expect(t.withIdentity(identity("admin")).query(api.tasks.listJdCycleRecords, { companyId, taskId })).resolves.toEqual([
      expect.objectContaining({ scheduleGeneration: 1 }),
    ]);
  });

  test("recordMissedJdCyclesBatch records overdue cycles without changing task status", async () => {
    vi.setSystemTime(utc(2026, 1, 1, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Daily check", description: "", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    await t.withIdentity(identity("admin")).mutation(api.tasks.updateJdStatus, { companyId, taskId, status: "in_progress" });

    vi.setSystemTime(utc(2026, 7, 22, 12));
    const before = await t.run(async (ctx) => await ctx.db.get(taskId));
    await t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
    await t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
    const after = await t.run(async (ctx) => await ctx.db.get(taskId));
    const records = await t.run(async (ctx) => await ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId)).take(250));

    expect(records).toHaveLength(202);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ cycleStart: utc(2026, 1, 1), cycleEnd: utc(2026, 1, 2), status: "missed" }),
      expect.objectContaining({ cycleStart: utc(2026, 7, 21), cycleEnd: utc(2026, 7, 22), status: "missed" }),
    ]));
    expect(after?.status).toBe(before?.status);
    expect(after?.statusCycleStart).toBe(before?.statusCycleStart);
  });

  test("a legacy completed cycle without a completion row is not recorded as missed", async () => {
    vi.setSystemTime(utc(2026, 1, 1, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Daily check", description: "", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    await t.withIdentity(identity("admin")).mutation(api.tasks.completeJd, { companyId, taskId });
    // Simulate pre-ledger data: the stamped status survives, the row is gone.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId)).collect()) {
        await ctx.db.delete(row._id);
      }
    });

    vi.setSystemTime(utc(2026, 1, 4, 12));
    await t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
    const records = await t.run(async (ctx) => await ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId)).collect());

    // Jan 1 stays completed via statusCycleStart; only Jan 2–3 are missed.
    expect(records.map((record) => record.cycleStart).sort()).toEqual([utc(2026, 1, 2), utc(2026, 1, 3)]);

    // The stamped cycle is materialized as a completion row so analytics keep
    // counting it once the task's cycle floor advances past it.
    const completions = await t.run(async (ctx) => await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId)).collect());
    expect(completions).toMatchObject([{ cycleStart: utc(2026, 1, 1), cycleEnd: utc(2026, 1, 2) }]);
  });

  test("a stamped completed cycle with an existing missed record still gains a completion row", async () => {
    vi.setSystemTime(utc(2026, 1, 1, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Daily check", description: "", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });
    await t.withIdentity(identity("admin")).mutation(api.tasks.completeJd, { companyId, taskId });
    // Simulate pre-ledger data: the stamp survives, the completion row is gone,
    // and an older run already recorded the same cycle as missed.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId)).collect()) {
        await ctx.db.delete(row._id);
      }
      await ctx.db.insert("jdTaskCycleRecords", { companyId, jdTaskId: taskId, cycleStart: utc(2026, 1, 1), cycleEnd: utc(2026, 1, 2), status: "missed", recordedAt: utc(2026, 1, 2) });
    });

    vi.setSystemTime(utc(2026, 1, 4, 12));
    await t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
    const completions = await t.run(async (ctx) => await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId)).collect());
    const records = await t.run(async (ctx) => await ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId)).collect());

    // The missed record must not suppress the durable completion row; once the
    // stamp advances, the row is the only evidence the cycle was completed.
    expect(completions).toMatchObject([{ cycleStart: utc(2026, 1, 1), cycleEnd: utc(2026, 1, 2) }]);
    // The stale missed record for that completed cycle is removed; Jan 2–3 are
    // genuinely missed and keep their records.
    expect(records).toMatchObject([
      { cycleStart: utc(2026, 1, 2), status: "missed" },
      { cycleStart: utc(2026, 1, 3), status: "missed" },
    ]);
  });

  test("resetAndClearMissedJdCycles deletes missed cycle records, resets cycleStartedAt to current, and prevents re-recording old cycles", async () => {
    vi.setSystemTime(utc(2026, 1, 1, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Daily check", description: "", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });

    vi.setSystemTime(utc(2026, 1, 15, 12));
    await t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
    const countBefore = await t.query(internal.tasks.countMissedJdCycles, { companyId });
    expect(countBefore.count).toBeGreaterThan(0);

    // Run reset and clear
    await t.mutation(internal.tasks.resetAndClearMissedJdCycles, { companyId, now: utc(2026, 1, 15, 12) });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const countAfter = await t.query(internal.tasks.countMissedJdCycles, { companyId });
    expect(countAfter.count).toBe(0);

    // Verify task still exists and cycleStartedAt was reset
    const taskAfter = await t.run(async (ctx) => await ctx.db.get(taskId));
    expect(taskAfter).not.toBeNull();
    expect(taskAfter?.status).toBe("due");

    // Re-run the hourly cron: it must NOT re-insert old missed records
    await t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
    const countAfterCron = await t.query(internal.tasks.countMissedJdCycles, { companyId });
    expect(countAfterCron.count).toBe(0);
  });

  test("resetJdTaskCyclesBatch spans across multiple pages (>100 tasks) with serialized clearing and prevents cron interleaving recreation", { timeout: 15_000 }, async () => {
    const start = utc(2026, 1, 1, 12);
    vi.setSystemTime(start);
    const { t, companyId, adminMembershipId } = await seedCompany();

    // Create 105 tasks to cross the 100-item batch pagination limit
    await t.run(async (ctx) => {
      for (let i = 0; i < 105; i++) {
        await ctx.db.insert("jdTasks", {
          companyId,
          reference: `JD-${String(i + 1).padStart(3, "0")}`,
          title: `Task ${i + 1}`,
          recurrence: "daily",
          cycleStartedAt: start,
          status: "due",
          statusCycleStart: utc(2026, 1, 1),
          assigneeMembershipIds: [adminMembershipId],
          createdByMembershipId: adminMembershipId,
          createdAt: start,
          updatedAt: start,
        });
      }
    });

    // Advance 4 days so cycles elapse
    const now = utc(2026, 1, 5, 12);
    vi.setSystemTime(now);

    // Record missed cycles across batches
    await t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const countBefore = await t.query(internal.tasks.countMissedJdCycles, { companyId });
    expect(countBefore.count).toBeGreaterThan(100);

    // Start reset and clearing; it must chain across 2 task reset pages, then clear
    await t.mutation(internal.tasks.resetAndClearMissedJdCycles, { companyId, now });

    // Interleave an hourly cron run before finishing all scheduled work
    await t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const countAfter = await t.query(internal.tasks.countMissedJdCycles, { companyId });
    expect(countAfter).toEqual({ count: 0, hasMore: false });

    // Ensure all 105 tasks are reset and none recreated by cron
    await t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const finalCount = await t.query(internal.tasks.countMissedJdCycles, { companyId });
    expect(finalCount).toEqual({ count: 0, hasMore: false });
  });

  test("JD evidence stays bound to the completed cycle after the task rolls over", async () => {
    vi.setSystemTime(utc(2026, 6, 25, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const admin = t.withIdentity(identity("admin"));
    const taskId = await admin.mutation(api.tasks.createJd, {
      companyId,
      title: "Weekly evidence",
      recurrence: "weekly",
      assigneeMembershipIds: [adminMembershipId],
      evidenceRequired: true,
    });
    const firstCycle = await admin.query(api.tasks.getJd, { companyId, taskId });
    const completedCycleStart = firstCycle.task.state.currentCycleStart;
    await admin.mutation(api.tasks.completeJd, { companyId, taskId, evidence: { text: "Cycle A proof" } });

    vi.setSystemTime(utc(2026, 6, 29, 12));
    const current = await admin.query(api.tasks.getJd, { companyId, taskId });
    expect(current.task.state.rawStatus).toBe("due");
    expect(current.task.state.currentCycleStart).toBe(utc(2026, 6, 29));

    const history = await admin.query(api.tasks.getTaskEvidence, {
      companyId,
      taskType: "jd",
      taskId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(history.page).toHaveLength(1);
    expect(history.page[0]).toMatchObject({ text: "Cycle A proof", cycleStart: completedCycleStart });
    expect(history.page[0].cycleStart).not.toBe(current.task.state.currentCycleStart);
  });

  test("completed previous JD cycle starts the new current cycle as pending", async () => {
    vi.setSystemTime(utc(2026, 6, 25, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Weekly review", description: "", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });
    await t.withIdentity(identity("admin")).mutation(api.tasks.completeJd, { companyId, taskId });

    vi.setSystemTime(utc(2026, 6, 29));
    await t.withIdentity(identity("admin")).mutation(api.tasks.updateJd, { companyId, taskId, title: "Weekly review", description: "", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });
    // Missed-cycle catch-up runs as a scheduled mutation off the edit path.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const detail = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });
    const records = await t.withIdentity(identity("admin")).query(api.tasks.listJdCycleRecords, { companyId, taskId });

    expect(detail.task.state.rawStatus).toBe("due");
    expect(records).toEqual([]);
  }, 15000);

  test("one-time task can still become overdue", async () => {
    vi.setSystemTime(utc(2026, 6, 26, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, { companyId, title: "One-time", description: "", dueDate: utc(2026, 6, 26, 13), assigneeMembershipIds: [adminMembershipId], priority: "medium" });

    vi.setSystemTime(utc(2026, 6, 26, 14));
    const detail = await t.withIdentity(identity("admin")).query(api.tasks.getOneTime, { companyId, taskId });

    expect(detail.task.state.rawStatus).toBe("overdue");
    expect(detail.task.state.isOverdue).toBe(true);
  });
});

describe("fixed JD calendar cycle boundaries", () => {
  test("semi-monthly, monthly, six-month, and yearly boundaries use the selected time zone", () => {
    expect(currentJdCycle("semimonthly", utc(2026, 6, 15, 9), "UTC")).toEqual({ start: utc(2026, 6, 1), end: utc(2026, 6, 16) });
    expect(currentJdCycle("semimonthly", utc(2026, 6, 16), "UTC")).toEqual({ start: utc(2026, 6, 16), end: utc(2026, 7, 1) });
    expect(currentJdCycle("monthly", utc(2026, 6, 15, 9), "UTC")).toEqual({ start: utc(2026, 6, 1), end: utc(2026, 7, 1) });
    expect(currentJdCycle("semiannually", utc(2026, 6, 30, 23, 59), "UTC")).toEqual({ start: utc(2026, 1, 1), end: utc(2026, 7, 1) });
    expect(currentJdCycle("semiannually", utc(2026, 7, 1), "UTC")).toEqual({ start: utc(2026, 7, 1), end: utc(2027, 1, 1) });
    expect(currentJdCycle("quarterly", utc(2026, 5, 15, 9), "UTC")).toEqual({ start: utc(2026, 4, 1), end: utc(2026, 7, 1) });
    expect(currentJdCycle("quarterly", utc(2026, 7, 1), "UTC")).toEqual({ start: utc(2026, 7, 1), end: utc(2026, 10, 1) });
    expect(nextJdCycleStart(utc(2026, 4, 1), "quarterly", "UTC")).toBe(utc(2026, 7, 1));
    expect(previousJdCycleStart(utc(2026, 7, 1), "quarterly", "UTC")).toBe(utc(2026, 4, 1));
    expect(currentJdCycle("annually", utc(2026, 12, 31, 23, 59), "UTC")).toEqual({ start: utc(2026, 1, 1), end: utc(2027, 1, 1) });
  });

  test("missing company/browser time zone falls back to GMT+5", () => {
    expect(currentJdCycle("daily", utc(2026, 6, 27))).toEqual({ start: utc(2026, 6, 26, 19), end: utc(2026, 6, 27, 19) });
  });
});
