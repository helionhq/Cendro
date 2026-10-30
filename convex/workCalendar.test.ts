/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildWorkCalendar, maxHolidaySpanDays } from "./workCalendar";

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
    const adminUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", firstName: "Admin", secondName: "", createdAt: now, updatedAt: now });
    const adminMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: adminUserId, role: "Admin", active: true, createdAt: now, updatedAt: now });
    const employeeUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|employee", email: "employee@example.com", firstName: "Employee", secondName: "", createdAt: now, updatedAt: now });
    const employeeMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: employeeUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });
    return { companyId, adminMembershipId, employeeMembershipId };
  });
  return { t, ...ids };
}

async function missedCycleStarts(t: Awaited<ReturnType<typeof seedCompany>>["t"], taskId: Id<"jdTasks">) {
  const records = await t.run(async (ctx) =>
    await ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId)).collect()
  );
  return records.map((record) => record.cycleStart).sort();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("work calendar settings", () => {
  test("defaults to Monday through Saturday with no holidays", async () => {
    const { t, companyId } = await seedCompany();
    const calendar = await t.withIdentity(identity("admin")).query(api.workCalendar.get, { companyId });
    expect(calendar.workingDays).toEqual([1, 2, 3, 4, 5, 6]);
    expect(calendar.holidays).toEqual([]);
  });

  test("admin can set working days and manage holidays; employee cannot", async () => {
    const { t, companyId } = await seedCompany();
    await t.withIdentity(identity("admin")).mutation(api.workCalendar.setWorkingDays, { companyId, workingDays: [0, 1, 2, 3, 4, 5] });
    const holidayId = await t.withIdentity(identity("admin")).mutation(api.workCalendar.addHoliday, { companyId, name: "Office closed", startDate: "2026-12-24", endDate: "2026-12-31" });

    const calendar = await t.withIdentity(identity("admin")).query(api.workCalendar.get, { companyId });
    expect(calendar.workingDays).toEqual([0, 1, 2, 3, 4, 5]);
    expect(calendar.holidays).toEqual([{ _id: holidayId, name: "Office closed", startDate: "2026-12-24", endDate: "2026-12-31", recursYearly: false }]);

    await t.withIdentity(identity("admin")).mutation(api.workCalendar.removeHoliday, { companyId, holidayId });
    expect((await t.withIdentity(identity("admin")).query(api.workCalendar.get, { companyId })).holidays).toEqual([]);

    await expect(
      t.withIdentity(identity("employee")).mutation(api.workCalendar.setWorkingDays, { companyId, workingDays: [1] })
    ).rejects.toThrow();
    await expect(
      t.withIdentity(identity("employee")).mutation(api.workCalendar.addHoliday, { companyId, name: "Nope", startDate: "2026-01-01", endDate: "2026-01-01" })
    ).rejects.toThrow();
    await expect(
      t.withIdentity(identity("admin")).mutation(api.workCalendar.setWorkingDays, { companyId, workingDays: [] })
    ).rejects.toThrow();
  });

  test("updateHoliday edits fields and normalizes a reversed one-time range", async () => {
    const { t, companyId } = await seedCompany();
    const holidayId = await t.withIdentity(identity("admin")).mutation(api.workCalendar.addHoliday, { companyId, name: "Office closed", startDate: "2026-12-24", endDate: "2026-12-24" });

    await t.withIdentity(identity("admin")).mutation(api.workCalendar.updateHoliday, { companyId, holidayId, name: "Winter break", startDate: "2026-12-31", endDate: "2026-12-24", recursYearly: false });
    let calendar = await t.withIdentity(identity("admin")).query(api.workCalendar.get, { companyId });
    expect(calendar.holidays).toEqual([{ _id: holidayId, name: "Winter break", startDate: "2026-12-24", endDate: "2026-12-31", recursYearly: false }]);

    // Repeating ranges keep their entered order so they can wrap the year.
    await t.withIdentity(identity("admin")).mutation(api.workCalendar.updateHoliday, { companyId, holidayId, name: "Winter break", startDate: "2026-12-24", endDate: "2026-01-06", recursYearly: true });
    calendar = await t.withIdentity(identity("admin")).query(api.workCalendar.get, { companyId });
    expect(calendar.holidays).toEqual([{ _id: holidayId, name: "Winter break", startDate: "2026-12-24", endDate: "2026-01-06", recursYearly: true }]);

    await expect(
      t.withIdentity(identity("employee")).mutation(api.workCalendar.updateHoliday, { companyId, holidayId, name: "Nope", startDate: "2026-01-01", endDate: "2026-01-01" })
    ).rejects.toThrow();
    await expect(
      t.withIdentity(identity("admin")).mutation(api.workCalendar.updateHoliday, { companyId, holidayId, name: "Too long", startDate: "2026-01-01", endDate: "2028-01-01" })
    ).rejects.toThrow();

    // A holiday id belonging to another company is rejected.
    const otherHolidayId = await t.run(async (ctx) => {
      const otherCompanyId = await ctx.db.insert("companies", { name: "Other", timeZone: "UTC", createdAt: Date.now() });
      return await ctx.db.insert("companyHolidays", { companyId: otherCompanyId, name: "Theirs", startDate: "2026-01-01", endDate: "2026-01-01", recursYearly: false, createdAt: Date.now() });
    });
    await expect(
      t.withIdentity(identity("admin")).mutation(api.workCalendar.updateHoliday, { companyId, holidayId: otherHolidayId, name: "Other company", startDate: "2026-01-01", endDate: "2026-01-01" })
    ).rejects.toThrow();
  });
});

describe("JD tasks on a work calendar", () => {
  test("daily task skips Sundays: no missed occurrence and no overdue record for the off day", async () => {
    // Jan 2 2026 is a Friday; Jan 3 Sat, Jan 4 Sun, Jan 5 Mon. Default calendar
    // makes Sunday a non-working day.
    vi.setSystemTime(utc(2026, 1, 2, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Daily check", description: "", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });

    vi.setSystemTime(utc(2026, 1, 5, 12));
    await t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Friday and Saturday elapsed as ordinary misses; the Sunday cycle never
    // existed as an occurrence, so it produces no record.
    expect(await missedCycleStarts(t, taskId)).toEqual([utc(2026, 1, 2), utc(2026, 1, 3)]);
  });

  test("every-other-day task skips a non-working due date and keeps its two-day cadence", async () => {
    // dayIndex(2026-01-03) is even, so the 2-day windows are [Jan3-Jan4],
    // [Jan5-Jan6], … and [Jan3-Jan4] is due Sunday Jan 4 → skipped.
    vi.setSystemTime(utc(2026, 1, 1, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Alternate check", description: "", recurrence: "every_other_day", assigneeMembershipIds: [adminMembershipId] });

    vi.setSystemTime(utc(2026, 1, 7, 12));
    await t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // [Jan1-Jan2] due Fri, [Jan3-Jan4] due Sun (skipped), [Jan5-Jan6] due Tue.
    // The cadence is untouched: missed records sit on the unchanged grid.
    expect(await missedCycleStarts(t, taskId)).toEqual([utc(2026, 1, 1), utc(2026, 1, 5)]);
  });

  test("weekly task due on Sunday is due at the end of the next working day", async () => {
    // Weekly cycles are Monday-anchored: [Mon Jan 19 → Mon Jan 26) is due
    // Sunday Jan 25, which shifts to the end of Monday Jan 26.
    vi.setSystemTime(utc(2026, 1, 22, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Weekly review", description: "", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });

    const detail = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });
    expect(detail.task.state.currentCycleStart).toBe(utc(2026, 1, 19));
    expect(detail.task.state.dueAt).toBe(utc(2026, 1, 27));

    // The cycle has grid-ended but its shifted deadline is still pending:
    // it stays the open occurrence all of Monday, and nothing is missed yet.
    vi.setSystemTime(utc(2026, 1, 26, 12));
    const pending = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });
    expect(pending.task.state.currentCycleStart).toBe(utc(2026, 1, 19));
    expect(pending.task.state.dueAt).toBe(utc(2026, 1, 27));
    await t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await missedCycleStarts(t, taskId)).toEqual([]);

    // Once the shifted deadline passes, the miss is recorded under the
    // unchanged grid key with the shifted deadline as its stored end.
    vi.setSystemTime(utc(2026, 1, 27, 12));
    await t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const records = await t.run(async (ctx) =>
      await ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId)).collect()
    );
    expect(records).toMatchObject([{ cycleStart: utc(2026, 1, 19), cycleEnd: utc(2026, 1, 27), status: "missed" }]);
  });

  test("a holiday moves the shifted due date further to the next working day", async () => {
    vi.setSystemTime(utc(2026, 1, 22, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Weekly review", description: "", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });
    await t.withIdentity(identity("admin")).mutation(api.workCalendar.addHoliday, { companyId, name: "Founders' day", startDate: "2026-01-26", endDate: "2026-01-26" });

    // Due Sunday Jan 25 → Monday Jan 26 is a holiday → due end of Tuesday Jan 27.
    const detail = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });
    expect(detail.task.state.dueAt).toBe(utc(2026, 1, 28));
  });

  test("completing while a shifted deadline is pending counts toward that occurrence", async () => {
    // Same Sunday-due weekly; on the shifted Monday the previous week is
    // still the open occurrence, so the completion writes its cycle start and
    // nothing is missed once the deadline passes.
    vi.setSystemTime(utc(2026, 1, 22, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Weekly review", description: "", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });

    vi.setSystemTime(utc(2026, 1, 26, 12));
    await t.withIdentity(identity("admin")).mutation(api.tasks.completeJd, { companyId, taskId });
    const completions = await t.run(async (ctx) =>
      await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId)).collect()
    );
    expect(completions).toMatchObject([{ cycleStart: utc(2026, 1, 19), cycleEnd: utc(2026, 1, 27) }]);

    vi.setSystemTime(utc(2026, 1, 27, 12));
    await t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await missedCycleStarts(t, taskId)).toEqual([]);
  });

  test("completing during a closure that spans several cycles credits the earliest open occurrence", async () => {
    // A 3-week holiday makes four consecutive weekly due dates shift to the
    // same next working day: all four occurrences stay open until the shared
    // deadline, and a completion settles the earliest open one first.
    vi.setSystemTime(utc(2026, 1, 22, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Weekly review", description: "", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });
    await t.withIdentity(identity("admin")).mutation(api.workCalendar.addHoliday, { companyId, name: "Shutdown", startDate: "2026-01-26", endDate: "2026-02-15" });

    vi.setSystemTime(utc(2026, 2, 16, 12));
    const detail = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });
    expect(detail.task.state.currentCycleStart).toBe(utc(2026, 1, 19));
    expect(detail.task.state.dueAt).toBe(utc(2026, 2, 17));

    await t.withIdentity(identity("admin")).mutation(api.tasks.completeJd, { companyId, taskId });
    const completions = await t.run(async (ctx) =>
      await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId)).collect()
    );
    expect(completions).toMatchObject([{ cycleStart: utc(2026, 1, 19), cycleEnd: utc(2026, 2, 17) }]);
  });

  test("an occurrence pending when the recurrence changes is still recorded", async () => {
    // On the shifted Monday the old weekly deadline is still pending; a
    // recurrence change moves the task to a new grid, so the pending
    // occurrence needs its own follow-up check after the deadline passes.
    vi.setSystemTime(utc(2026, 1, 22, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Weekly review", description: "", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });

    vi.setSystemTime(utc(2026, 1, 26, 12));
    await t.withIdentity(identity("admin")).mutation(api.tasks.updateJdFields, { companyId, taskId, recurrence: "monthly" });

    vi.setSystemTime(utc(2026, 1, 28, 12));
    await t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const records = await t.run(async (ctx) =>
      await ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId)).collect()
    );
    expect(records).toMatchObject([{ cycleStart: utc(2026, 1, 19), cycleEnd: utc(2026, 1, 27), status: "missed" }]);
  });

  test("a calendar edit cannot turn completed old-grid work into a delayed miss", async () => {
    vi.setSystemTime(utc(2026, 6, 2, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const admin = t.withIdentity(identity("admin"));
    const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Completed weekly review", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });
    await admin.mutation(api.tasks.completeJd, { companyId, taskId });

    // Sunday June 7 is off, so the completion stores Monday's deadline.
    vi.setSystemTime(utc(2026, 6, 8, 12));
    await admin.mutation(api.tasks.updateJdFields, { companyId, taskId, recurrence: "monthly" });
    await admin.mutation(api.workCalendar.setWorkingDays, { companyId, workingDays: [0, 1, 2, 3, 4, 5, 6] });
    vi.setSystemTime(utc(2026, 6, 10, 12));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await admin.query(api.tasks.listJdCycleRecords, { companyId, taskId })).toEqual([]);
    const completions = await t.run(async (ctx) => await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId)).collect());
    expect(completions).toMatchObject([{ cycleStart: utc(2026, 6, 1), cycleEnd: utc(2026, 6, 9), retiredAt: utc(2026, 6, 8, 12) }]);
  });

  test("delayed catch-up cannot credit a completion retired before its grid began", async () => {
    vi.setSystemTime(utc(2026, 6, 2, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const admin = t.withIdentity(identity("admin"));
    const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Repeated weekly grid", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });
    await admin.mutation(api.tasks.completeJd, { companyId, taskId });
    vi.setSystemTime(utc(2026, 6, 2, 13));
    await admin.mutation(api.tasks.updateJdFields, { companyId, taskId, recurrence: "monthly" });
    vi.setSystemTime(utc(2026, 6, 3, 12));
    await admin.mutation(api.tasks.updateJdFields, { companyId, taskId, recurrence: "weekly" });

    // The second weekly grid shares the first one's start and deadline,
    // but was never completed. A later replay must not credit that old work.
    vi.setSystemTime(utc(2026, 6, 9, 12));
    await admin.mutation(api.tasks.updateJdFields, { companyId, taskId, recurrence: "monthly" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await admin.query(api.tasks.listJdCycleRecords, { companyId, taskId })).toMatchObject([
      { cycleStart: utc(2026, 6, 1), cycleEnd: utc(2026, 6, 9), status: "missed" },
    ]);
  });

  test("a recurrence change during a multi-cycle pending window stops the old schedule at the change", async () => {
    // Same 3-week shutdown: the weekly schedule's pending occurrences share a
    // deadline after the recurrence change. The re-check records every
    // pre-change occurrence that went undone but never evaluates cycles that
    // only existed after the switch.
    vi.setSystemTime(utc(2026, 1, 22, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Weekly review", description: "", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });
    await t.withIdentity(identity("admin")).mutation(api.workCalendar.addHoliday, { companyId, name: "Shutdown", startDate: "2026-01-26", endDate: "2026-02-15" });

    vi.setSystemTime(utc(2026, 2, 16, 12));
    await t.withIdentity(identity("admin")).mutation(api.tasks.updateJdFields, { companyId, taskId, recurrence: "monthly" });

    vi.setSystemTime(utc(2026, 2, 18, 12));
    await t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const records = await t.run(async (ctx) =>
      await ctx.db.query("jdTaskCycleRecords").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId)).collect()
    );
    // The monthly [Jan 1→Feb 1) occurrence was itself pending at the switch
    // (its Jan 31 due date sat inside the closure), so the new schedule owes
    // it too; the weekly records cover exactly the four pre-change
    // occurrences and no cycle that only existed afterwards.
    expect(records.map((record) => record.cycleStart)).toEqual([utc(2026, 1, 1), utc(2026, 1, 19), utc(2026, 1, 26), utc(2026, 2, 2), utc(2026, 2, 9)]);
    expect(records.every((record) => record.cycleEnd === utc(2026, 2, 17))).toBe(true);
  });

  test("a merged holiday closure longer than the scan cap still finds the next working day", async () => {
    // Two adjacent year-long holidays merge into a ~2-year closure; a due
    // date just before it must shift to the first working day after it
    // (Friday Jan 28, 2028), not an unchecked day inside the closure.
    vi.setSystemTime(utc(2026, 1, 22, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Weekly review", description: "", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });
    await t.withIdentity(identity("admin")).mutation(api.workCalendar.addHoliday, { companyId, name: "Shutdown A", startDate: "2026-01-26", endDate: "2027-01-26" });
    await t.withIdentity(identity("admin")).mutation(api.workCalendar.addHoliday, { companyId, name: "Shutdown B", startDate: "2027-01-27", endDate: "2028-01-27" });

    const detail = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });
    expect(detail.task.state.dueAt).toBe(utc(2028, 1, 29));
  });

  test("a yearly holiday moves due dates in every year without being re-added", async () => {
    // Monthly cycles [1st→1st) are due on the month's last day. A yearly
    // shutdown covering Jan 31 – Feb 2 pushes the January due date to the
    // first working day after it — in 2026 and again in 2027.
    vi.setSystemTime(utc(2026, 1, 15, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Month-end close", description: "", recurrence: "monthly", assigneeMembershipIds: [adminMembershipId] });
    await t.withIdentity(identity("admin")).mutation(api.workCalendar.addHoliday, { companyId, name: "Annual shutdown", startDate: "2026-01-31", endDate: "2026-02-02", recursYearly: true });

    // Jan 31 + Feb 1-2 are non-working (Feb 1 is also a Sunday) → due end of
    // Tuesday Feb 3.
    const first = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });
    expect(first.task.state.dueAt).toBe(utc(2026, 2, 4));

    // A year later with no second entry: Jan 31 2027 is a Sunday, Feb 1-2 are
    // yearly holidays → due end of Wednesday Feb 3 2027.
    vi.setSystemTime(utc(2027, 1, 15, 12));
    const next = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });
    expect(next.task.state.dueAt).toBe(utc(2027, 2, 4));
  });

  test("a yearly Feb 29 holiday clamps to Feb 28 in non-leap years", async () => {
    // Feb 28 2026 is a Saturday — a working day on the default calendar —
    // but the yearly Feb 29 holiday clamps onto it, so the February monthly
    // due date moves to the next working day. In leap years it covers Feb 29
    // itself.
    vi.setSystemTime(utc(2026, 2, 10, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Month-end close", description: "", recurrence: "monthly", assigneeMembershipIds: [adminMembershipId] });
    await t.withIdentity(identity("admin")).mutation(api.workCalendar.addHoliday, { companyId, name: "Leap day", startDate: "2028-02-29", endDate: "2028-02-29", recursYearly: true });

    // Feb 28 (clamped holiday) + Mar 1 (Sunday) → due end of Monday Mar 2.
    const nonLeap = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });
    expect(nonLeap.task.state.dueAt).toBe(utc(2026, 3, 3));

    // Feb 29 2028 is a Tuesday → due end of Wednesday Mar 1.
    vi.setSystemTime(utc(2028, 2, 10, 12));
    const leap = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });
    expect(leap.task.state.dueAt).toBe(utc(2028, 3, 2));
  });

  test("a yearly range wrapping the year boundary recurs as one range", async () => {
    // A Dec 24 – Jan 6 shutdown repeats yearly: a weekly cycle due Sunday
    // Dec 27 2026 lands inside it and shifts past Jan 6 2027, and a cycle due
    // Sunday Jan 2 2028 shifts past Jan 6 2028 the same way.
    vi.setSystemTime(utc(2026, 12, 22, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Weekly review", description: "", recurrence: "weekly", assigneeMembershipIds: [adminMembershipId] });
    await t.withIdentity(identity("admin")).mutation(api.workCalendar.addHoliday, { companyId, name: "Holiday shutdown", startDate: "2026-12-24", endDate: "2027-01-06", recursYearly: true });

    // Cycle [Mon Dec 21 → Mon Dec 28) due Sunday Dec 27 → covered through
    // Wednesday Jan 6 2027 → due end of Thursday Jan 7.
    const first = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });
    expect(first.task.state.dueAt).toBe(utc(2027, 1, 8));

    // [Mon Dec 27 2027 → Mon Jan 3 2028) due Sunday Jan 2 → covered through
    // Thursday Jan 6 2028 → due end of Friday Jan 7.
    vi.setSystemTime(utc(2027, 12, 29, 12));
    const next = await t.withIdentity(identity("admin")).query(api.tasks.getJd, { companyId, taskId });
    expect(next.task.state.dueAt).toBe(utc(2028, 1, 8));
  });

  test("completing a daily task on Sunday counts toward Monday's occurrence", async () => {
    vi.setSystemTime(utc(2026, 1, 2, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createJd, { companyId, title: "Daily check", description: "", recurrence: "daily", assigneeMembershipIds: [adminMembershipId] });

    vi.setSystemTime(utc(2026, 1, 4, 12));
    await t.withIdentity(identity("admin")).mutation(api.tasks.completeJd, { companyId, taskId });

    // On the skipped Sunday, the effective current occurrence is Monday's, so
    // the completion is recorded against that cycle start.
    const completions = await t.run(async (ctx) =>
      await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId)).collect()
    );
    expect(completions).toMatchObject([{ cycleStart: utc(2026, 1, 5) }]);

    vi.setSystemTime(utc(2026, 1, 7, 12));
    await t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
    // Run the immediate catch-ups at Wednesday noon; fast-forwarding to later
    // timers (the report recounts Monday's early completion once Monday
    // starts) would move "now" past the day under test.
    await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0));
    // Fri and Sat missed, Sun skipped, Mon completed via the off-day click,
    // Tue elapsed untouched — a genuine miss.
    expect(await missedCycleStarts(t, taskId)).toEqual([utc(2026, 1, 2), utc(2026, 1, 3), utc(2026, 1, 6)]);
  });

  test("the closure bound covers a one-time range joining yearly closures", () => {
    // Yearly Dec 24 – Jan 6 and Jan 20 – 31 joined by a one-time Jan 6–20
    // bridge make one contiguous Dec 24 2026 – Jan 31 2027 shutdown (39
    // days). The analytics lookback bound must cover the whole join, not
    // just the longest span of each kind.
    const calendar = buildWorkCalendar([1, 2, 3, 4, 5, 6], [
      { startDate: "2026-12-24", endDate: "2027-01-06", recursYearly: true },
      { startDate: "2027-01-06", endDate: "2027-01-20" },
      { startDate: "2027-01-20", endDate: "2027-01-31", recursYearly: true },
    ]);
    expect(maxHolidaySpanDays(calendar)).toBeGreaterThanOrEqual(39);
  });

  test("one-time tasks ignore the calendar entirely", async () => {
    vi.setSystemTime(utc(2026, 1, 2, 12));
    const { t, companyId, adminMembershipId } = await seedCompany();
    const taskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, {
      companyId,
      title: "One-off",
      description: "",
      priority: "medium",
      dueDate: utc(2026, 1, 4), // Sunday — explicitly chosen, must not move.
      assigneeMembershipIds: [adminMembershipId],
    });
    const detail = await t.withIdentity(identity("admin")).query(api.tasks.getOneTime, { companyId, taskId });
    expect(detail.task.dueDate).toBe(utc(2026, 1, 4));
  });
});
