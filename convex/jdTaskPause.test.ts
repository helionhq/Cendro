import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { createAuthzFixture } from "./authz.fixture";
import { defaultRoleCapabilities } from "../src/lib/permissions";

const utc = (day: number, hour = 12) => Date.UTC(2026, 5, day, hour);
const paginationOpts = { numItems: 100, cursor: null };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(utc(1)); });
afterEach(() => { vi.useRealTimers(); });

test("pause preserves history and suppresses discovery, counts and cycles; resume skips suspended deadlines on the working calendar", async () => {
  const f = await createAuthzFixture();
  await f.t.run(async (ctx) => {
    await ctx.db.patch(f.companyA, { timeZone: "UTC" });
    await ctx.db.insert("companyCalendars", { companyId: f.companyA, workingDays: [1, 2, 3, 4, 5], updatedAt: utc(1) });
  });
  const admin = f.asUser("adminA");
  const companyId = f.companyA;
  const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Daily check", recurrence: "daily", assigneeMembershipIds: [f.employee1M] });
  await admin.mutation(api.tasks.completeJd, { companyId, taskId, note: "Keep this history" });
  await admin.mutation(api.tasks.addComment, { companyId, taskType: "jd", taskId, body: "Keep this discussion" });
  vi.setSystemTime(utc(3));
  await admin.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [taskId], paused: true });
  // Recurrence changes can retire a pre-pause completion before the delayed
  // old-grid snapshot runs. That completed work must not become missed.
  await admin.mutation(api.tasks.updateJdFields, { companyId, taskId, recurrence: "weekly" });
  await admin.mutation(api.tasks.updateJdFields, { companyId, taskId, recurrence: "daily" });
  // Retrying pause must not add events or advance the suspension timestamp.
  await admin.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [taskId], paused: true });
  expect((await admin.query(api.tasks.listJdRows, { companyId, paginationOpts })).page).toEqual([]);
  const paused = await admin.query(api.tasks.listJdRows, { companyId, paused: true, paginationOpts });
  expect(paused.page).toMatchObject([{ _id: taskId, canResume: true, state: { status: "Inactive", dueAt: null, isOverdue: false } }]);
  expect((await admin.query(api.analytics.summary, { companyId })).jdTaskCount).toBe(0);
  expect((await admin.query(api.tasks.searchJd, { companyId, query: "Daily" })).tasks).toEqual([]);
  // Exports keep inactive rows and flag them instead of hiding them.
  expect((await admin.query(api.tasks.exportRows, { companyId, kind: "jd", paginationOpts })).page).toMatchObject([{ title: "Daily check", isActive: false }]);
  expect((await admin.query(api.tasks.aiListVisible, { companyId, kind: "jd", status: "all", limit: 30 })).rows).toEqual([]);
  await expect(f.asUser("employeeA1").mutation(api.tasks.completeJd, { companyId, taskId })).rejects.toThrow("Make this task active");
  const pausedDashboard = await admin.query(api.analytics.dashboard, { companyId, now: utc(3), period: { unit: "month", date: "2026-06-03" } });
  expect(pausedDashboard.jd).toMatchObject({ due: 0, missed: 0 });
  vi.setSystemTime(utc(20)); // Saturday: next working occurrence is Monday June 22.
  await f.t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
  await f.t.mutation(internal.tasks.catchUpMissedJdCycles, { taskId });
  await admin.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [taskId], paused: false });
  // Even the pre-pause scheduled work executing after resume is frozen at June 3.
  await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());
  let records = await admin.query(api.tasks.listJdCycleRecords, { companyId, taskId });
  expect(records.map((row) => row.cycleStart)).toEqual([utc(2, 0)]);
  const detail = await admin.query(api.tasks.getJd, { companyId, taskId });
  expect(detail.task).toMatchObject({ cycleStartedAt: utc(22, 0), state: { currentCycleStart: utc(22, 0), rawStatus: "due", isOverdue: false } });
  expect(detail.task.pausedAt).toBeUndefined();
  expect((await admin.query(api.tasks.listComments, { companyId, taskType: "jd", taskId, paginationOpts })).page[0].body).toBe("Keep this discussion");
  const completions = await f.t.run((ctx) => ctx.db.query("jdTaskCompletions").collect());
  expect(completions).toMatchObject([{ jdTaskId: taskId, cycleStart: utc(1, 0), note: "Keep this history" }]);
  vi.setSystemTime(utc(23));
  await f.t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
  records = await admin.query(api.tasks.listJdCycleRecords, { companyId, taskId });
  expect(records.map((row) => row.cycleStart)).toEqual([utc(22, 0), utc(2, 0)]);
  const events = await f.t.run((ctx) => ctx.db.query("taskActivityLogs").collect());
  expect(events.filter((event) => event.event === "paused")).toHaveLength(1);
  expect(events.filter((event) => event.event === "resumed")).toHaveLength(1);
});

test("pause and resume permissions are independent, scoped on every row and atomic across tenants", async () => {
  const f = await createAuthzFixture();
  const admin = f.asUser("adminA"), manager = f.asUser("managerA");
  const companyId = f.companyA;
  const create = (assigneeMembershipIds: typeof f.employee1M[]) => admin.mutation(api.tasks.createJd, { companyId, title: "Check", recurrence: "weekly", assigneeMembershipIds });
  const own = await create([f.employee1M]), outside = await create([f.employee2M]), shared = await create([f.employee1M, f.employee2M]);
  const foreign = await f.asUser("adminB").mutation(api.tasks.createJd, { companyId: f.companyB, title: "Other tenant", recurrence: "weekly", assigneeMembershipIds: [f.employeeBM] });
  const pause = (taskIds: typeof own[], paused = true) => manager.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds, paused });
  await expect(pause([own])).rejects.toThrow("access");
  await f.setRoleCapabilities(companyId, "Manager", [...defaultRoleCapabilities.Manager, "tasks:jd:pause", "tasks:jd:view:any"]);
  for (const forbidden of [outside, shared, foreign]) {
    await expect(pause([own, forbidden])).rejects.toThrow();
    expect((await admin.query(api.tasks.getJd, { companyId, taskId: own })).task.pausedAt).toBeUndefined();
  }
  await pause([own]);
  const rows = await manager.query(api.tasks.listJdRows, { companyId, paused: true, paginationOpts });
  expect(rows.page).toMatchObject([{ _id: own, canPause: false, canResume: false }]);
  await expect(pause([own], false)).rejects.toThrow("access");
  await f.setRoleCapabilities(companyId, "Manager", [...defaultRoleCapabilities.Manager, "tasks:jd:resume"]);
  await expect(pause([outside])).rejects.toThrow("access");
  await pause([own], false);
  await admin.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [own, outside], paused: true });
  // The paused filter keeps the viewer's existing managed/self visibility.
  expect((await manager.query(api.tasks.listJdRows, { companyId, paused: true, paginationOpts })).page.map((row) => row._id)).toEqual([own]);
  expect((await f.asUser("employeeA2").query(api.tasks.listJdRows, { companyId, paused: true, paginationOpts })).page.map((row) => row._id)).toEqual([outside]);
  await expect(pause([own, own], false)).rejects.toThrow("unique");
});

test("a pre-pause recurrence snapshot never misses a shifted deadline during suspension, even after later resumes", async () => {
  const f = await createAuthzFixture();
  const admin = f.asUser("adminA"), companyId = f.companyA;
  await f.t.run(async (ctx) => {
    await ctx.db.patch(companyId, { timeZone: "UTC" });
    await ctx.db.insert("companyCalendars", { companyId, workingDays: [1, 2, 3, 4, 5], updatedAt: utc(1) });
    await ctx.db.insert("companyHolidays", { companyId, name: "Closed Monday", startDate: "2026-06-08", endDate: "2026-06-08", createdAt: utc(1) });
  });
  const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Shifted deadline", recurrence: "weekly", assigneeMembershipIds: [f.employee1M] });
  vi.setSystemTime(utc(8));
  // Last week's Sunday deadline shifts to the end of Tuesday June 9.
  await admin.mutation(api.tasks.updateJdFields, { companyId, taskId, recurrence: "daily" });
  vi.setSystemTime(utc(8, 13));
  await admin.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [taskId], paused: true });
  vi.setSystemTime(utc(10));
  await admin.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [taskId], paused: false });
  // Delayed jobs may not run until after more lifecycle transitions.
  vi.setSystemTime(utc(11));
  await admin.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [taskId], paused: true });
  vi.setSystemTime(utc(12));
  await admin.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [taskId], paused: false });
  await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());
  const records = await admin.query(api.tasks.listJdCycleRecords, { companyId, taskId });
  expect(records.map((row) => row.cycleStart)).toEqual([utc(10, 0)]);
});

test("paused rows cannot consume the active AI scan or dashboard task budget", async () => {
  const f = await createAuthzFixture();
  const admin = f.asUser("adminA"), companyId = f.companyA;
  const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Active check", recurrence: "daily", assigneeMembershipIds: [f.employee1M] });
  await f.t.run(async (ctx) => {
    const active = (await ctx.db.get(taskId))!;
    for (let index = 0; index < 501; index++) {
      await ctx.db.insert("jdTasks", { companyId, reference: `PAUSED-${index}`, title: "Suspended", recurrence: "daily", assigneeMembershipIds: active.assigneeMembershipIds, createdByMembershipId: f.adminM, createdAt: utc(1), updatedAt: utc(1), pausedAt: utc(1), cycleStartedAt: utc(1), status: "due" });
    }
  });
  const list = await admin.query(api.tasks.aiListVisible, { companyId, kind: "jd", status: "all", limit: 30 });
  expect(list).toMatchObject({ rows: [{ reference: "JD-001", title: "Active check" }], truncated: false });
  expect((await admin.query(api.analytics.summary, { companyId })).jdTaskCount).toBe(1);
  // Inactive rows ride along in exports even though they are hidden elsewhere.
  const exported = await admin.query(api.tasks.exportRows, { companyId, kind: "jd", paginationOpts: { numItems: 600, cursor: null } });
  expect(exported.page).toHaveLength(502);
  expect(exported.page.filter((row) => "isActive" in row && row.isActive)).toMatchObject([{ reference: "JD-001" }]);
  expect(exported.page.filter((row) => "isActive" in row && !row.isActive)).toHaveLength(501);
});

test("resuming onto a new grid keeps old misses separate from the new current cycle", async () => {
  const f = await createAuthzFixture();
  const admin = f.asUser("adminA"), companyId = f.companyA;
  await f.t.run(async (ctx) => {
    await ctx.db.patch(companyId, { timeZone: "UTC" });
    await ctx.db.insert("companyCalendars", { companyId, workingDays: [0, 1, 2, 3, 4, 5, 6], updatedAt: utc(1) });
  });
  const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "History and current work", recurrence: "daily", assigneeMembershipIds: [f.employee1M] });
  vi.setSystemTime(utc(3));
  await f.t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
  await admin.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [taskId], paused: true });
  await admin.mutation(api.tasks.updateJdFields, { companyId, taskId, recurrence: "monthly" });
  vi.setSystemTime(utc(20));
  await admin.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [taskId], paused: false });
  await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());
  vi.setSystemTime(utc(30));
  const dashboard = await admin.query(api.analytics.dashboard, { companyId, now: utc(30), period: { unit: "month", date: "2026-06-30" } });
  // Two genuinely missed daily occurrences; the monthly cycle is due after
  // today, so it is not counted yet.
  expect(dashboard.jd).toMatchObject({ due: 2, missed: 2 });
  expect(await admin.query(api.tasks.listJdCycleRecords, { companyId, taskId })).toHaveLength(2);
  vi.setSystemTime(Date.UTC(2026, 6, 2, 12));
  await f.t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});
  expect(await admin.query(api.tasks.listJdCycleRecords, { companyId, taskId })).toHaveLength(3);
});

test("retired completion and missed rows count as one old cycle without completing the new grid", async () => {
  const f = await createAuthzFixture();
  const admin = f.asUser("adminA"), companyId = f.companyA;
  await f.t.run(async (ctx) => {
    await ctx.db.patch(companyId, { timeZone: "UTC" });
    await ctx.db.insert("companyCalendars", { companyId, workingDays: [0, 1, 2, 3, 4, 5, 6], updatedAt: utc(1) });
  });
  const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Completed history", recurrence: "weekly", assigneeMembershipIds: [f.employee1M] });
  await admin.mutation(api.tasks.completeJd, { companyId, taskId });
  vi.setSystemTime(utc(8));
  // Legacy data can contain a stale missed record alongside the actual
  // completion. The edit must retain both rows, but count the work only once.
  await f.t.run(async (ctx) => {
    await ctx.db.insert("jdTaskCycleRecords", { companyId, jdTaskId: taskId, cycleStart: utc(1, 0), cycleEnd: utc(8, 0), status: "missed", recordedAt: utc(8) });
  });
  await admin.mutation(api.tasks.updateJdFields, { companyId, taskId, recurrence: "monthly" });
  await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());
  vi.setSystemTime(utc(30));
  const dashboard = await admin.query(api.analytics.dashboard, { companyId, now: utc(30), period: { unit: "month", date: "2026-06-30" } });
  // One completed weekly cycle; the new monthly cycle is not due until July.
  expect(dashboard.jd).toMatchObject({ due: 1, done: 1, missed: 0 });
  expect(dashboard.buckets.reduce((sum, bucket) => sum + bucket.jd.due, 0)).toBe(1);
  expect((await admin.query(api.tasks.getJd, { companyId, taskId })).task.state.rawStatus).toBe("due");
  expect(await admin.query(api.tasks.listJdCycleRecords, { companyId, taskId })).toMatchObject([{ retiredAt: utc(8) }]);
});

test("preserved paused ledgers cannot exhaust the active dashboard report budget", { timeout: 30_000 }, async () => {
  const f = await createAuthzFixture();
  const admin = f.asUser("adminA"), companyId = f.companyA;
  await f.t.run(async (ctx) => {
    await ctx.db.patch(companyId, { timeZone: "UTC" });
    for (let index = 0; index < 9; index++) {
      await ctx.db.insert("jdTasks", { companyId, reference: `ACTIVE-${index}`, title: "Active", recurrence: "daily", cycleStartedAt: utc(1), status: "due", assigneeMembershipIds: [f.employee1M], createdByMembershipId: f.adminM, createdAt: utc(1), updatedAt: utc(1) });
    }
  });
  // Forty paused year-old schedules retain genuine history exceeding the
  // former company-wide scan cap; none belongs to these nine active ledgers.
  for (let index = 0; index < 40; index++) {
    await f.t.run(async (ctx) => {
      const taskId = await ctx.db.insert("jdTasks", { companyId, reference: `PAUSED-${index}`, title: "Paused history", recurrence: "daily", cycleStartedAt: utc(1), status: "due", pausedAt: utc(1), assigneeMembershipIds: [f.employee1M], createdByMembershipId: f.adminM, createdAt: utc(1) - 350 * 86_400_000, updatedAt: utc(1) });
      for (let day = 1; day <= 350; day++) {
        const cycleStart = utc(1, 0) - day * 86_400_000;
        await ctx.db.insert("jdTaskCompletions", { companyId, jdTaskId: taskId, cycleStart, cycleEnd: cycleStart + 86_400_000, completedAt: cycleStart + 43_200_000 });
      }
    });
  }
  // Move past June 1 so each active daily task has one elapsed cycle to report.
  vi.setSystemTime(utc(2));
  const dashboard = await admin.query(api.analytics.dashboard, { companyId, now: utc(2), period: { unit: "year", date: "2026-06-02" } });
  expect(dashboard).toMatchObject({ jd: { due: 9, done: 0, missed: 9 }, isTruncated: false });
});

test("self-scoped lifecycle grants apply to assigned shared tasks but never to other people's tasks", async () => {
  const f = await createAuthzFixture();
  const admin = f.asUser("adminA"), employee = f.asUser("employeeA1"), companyId = f.companyA;
  const shared = await admin.mutation(api.tasks.createJd, { companyId, title: "Shared task", recurrence: "weekly", assigneeMembershipIds: [f.employee1M, f.employee2M] });
  const outside = await admin.mutation(api.tasks.createJd, { companyId, title: "Outside task", recurrence: "weekly", assigneeMembershipIds: [f.employee2M] });
  await f.setRoleCapabilities(companyId, "Employee", [...defaultRoleCapabilities.Employee, "tasks:jd:pause", "tasks:jd:resume"]);
  const rows = await employee.query(api.tasks.listJdRows, { companyId, paginationOpts });
  expect(rows.page).toMatchObject([{ _id: shared, canPause: true, canResume: false }]);
  await employee.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [shared], paused: true });
  await employee.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [shared], paused: false });
  await expect(employee.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [outside], paused: true })).rejects.toThrow("Task not found");
});

test("paused title and reference matches cannot consume the palette candidate budget", async () => {
  const f = await createAuthzFixture();
  const admin = f.asUser("adminA"), companyId = f.companyA;
  const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Restock pantry", recurrence: "daily", assigneeMembershipIds: [f.employee1M] });
  await f.t.run(async (ctx) => {
    await ctx.db.patch(taskId, { reference: "JD-999" });
    for (let index = 0; index < 160; index++) {
      await ctx.db.insert("jdTasks", { companyId, reference: `JD-${String(index + 1).padStart(3, "0")}`, title: "Restock pantry", recurrence: "daily", pausedAt: utc(1), cycleStartedAt: utc(1), status: "due", assigneeMembershipIds: [f.employee1M], createdByMembershipId: f.adminM, createdAt: utc(1), updatedAt: utc(1) });
    }
  });
  for (const query of ["restock", "JD"]) {
    expect(await admin.query(api.tasks.searchJd, { companyId, query })).toMatchObject({ tasks: [{ _id: taskId }], truncated: false });
  }
});

test("release backfill enables lifecycle defaults only for untouched Admin roles", async () => {
  const f = await createAuthzFixture();
  const previous = defaultRoleCapabilities.Admin.filter((cap) => cap !== "tasks:jd:pause" && cap !== "tasks:jd:resume");
  await f.setRoleCapabilities(f.companyA, "Admin", previous);
  await f.setRoleCapabilities(f.companyB, "Admin", ["tasks:jd:view:any"]);
  expect(await f.t.mutation(internal.roles.enableJdLifecycleDefaults, {})).toBe(1);
  expect(await f.t.mutation(internal.roles.enableJdLifecycleDefaults, {})).toBe(0);
  expect((await f.asUser("adminA").query(api.tasks.listJdRows, { companyId: f.companyA, paused: true, paginationOpts })).page).toEqual([]);
  const caps = await f.t.run(async (ctx) => (await ctx.db.query("roles").withIndex("by_company_and_name", (q) => q.eq("companyId", f.companyA).eq("name", "Admin")).unique())!.capabilities);
  expect(caps).toEqual(expect.arrayContaining(["tasks:jd:pause", "tasks:jd:resume"]));
  const customized = await f.t.run(async (ctx) => (await ctx.db.query("roles").withIndex("by_company_and_name", (q) => q.eq("companyId", f.companyB).eq("name", "Admin")).unique())!.capabilities);
  expect(customized).toEqual(["tasks:jd:view:any"]);
});

test("same-cycle resume and recurrence edits while paused never erase completions", async () => {
  const f = await createAuthzFixture();
  const admin = f.asUser("adminA"), companyId = f.companyA;
  await f.t.run(async (ctx) => {
    await ctx.db.patch(companyId, { timeZone: "UTC" });
    await ctx.db.insert("companyCalendars", { companyId, workingDays: [0, 1, 2, 3, 4, 5, 6], updatedAt: utc(1) });
  });
  const taskId = await admin.mutation(api.tasks.createJd, { companyId, title: "Review", recurrence: "weekly", assigneeMembershipIds: [f.employee1M] });
  await admin.mutation(api.tasks.completeJd, { companyId, taskId });
  await admin.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [taskId], paused: true });
  await admin.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [taskId], paused: false });
  expect((await admin.query(api.tasks.getJd, { companyId, taskId })).task.state.rawStatus).toBe("completed");
  await admin.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [taskId], paused: true });
  await admin.mutation(api.tasks.updateJdFields, { companyId, taskId, recurrence: "monthly" });
  await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());
  expect(await f.t.run((ctx) => ctx.db.query("jdTaskCompletions").collect())).toMatchObject([{ retiredAt: expect.any(Number) }]);
  await admin.mutation(api.tasks.setJdPausedBulk, { companyId, taskIds: [taskId], paused: false });
  expect((await admin.query(api.tasks.getJd, { companyId, taskId })).task.state.rawStatus).toBe("due");
  // A new completion can coexist with the preserved old-grid completion at
  // the same start, and analytics must not merge the two schedules.
  vi.setSystemTime(utc(30));
  const dashboard = await admin.query(api.analytics.dashboard, { companyId, now: utc(30), period: { unit: "month", date: "2026-06-30" } });
  expect(dashboard.jd).toMatchObject({ done: 1, due: 1 });
  await admin.mutation(api.tasks.completeJd, { companyId, taskId });
  expect((await admin.query(api.tasks.getJd, { companyId, taskId })).task.state.rawStatus).toBe("completed");
  expect(await f.t.run((ctx) => ctx.db.query("jdTaskCompletions").collect())).toHaveLength(2);
  const completedDashboard = await admin.query(api.analytics.dashboard, { companyId, now: utc(30), period: { unit: "month", date: "2026-06-30" } });
  expect(completedDashboard.jd).toMatchObject({ done: 2, due: 2 });
});
