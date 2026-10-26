/// <reference types="vite/client" />

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { createAuthzFixture } from "./authz.fixture";
import { defaultRoleCapabilities } from "../src/lib/permissions";
import { nextJdCycleStart, previousJdCycleStart } from "./taskCycles";

const dayMs = 86_400_000;
const utc = (day: number, month = 5, hour = 12) => Date.UTC(2026, month, day, hour);

afterEach(() => { vi.useRealTimers(); });

// Keep the recurrence grid raw so a daily and weekly cycle can share a start.
async function useUtcAllWeekCalendar(f: Awaited<ReturnType<typeof createAuthzFixture>>) {
  await f.t.run(async (ctx) => {
    await ctx.db.patch(f.companyA, { timeZone: "UTC" });
    await ctx.db.insert("companyCalendars", { companyId: f.companyA, workingDays: [0, 1, 2, 3, 4, 5, 6], updatedAt: Date.now() });
  });
}

describe("task completion confirmation", () => {
  test("a non-confirmer submission waits, and confirming completes it with the submission time and author", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const manager = f.asUser("managerA");
    const employee = f.asUser("employeeA1");
    const taskId = await admin.mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "Sign off the delivery",
      dueDate: Date.now() + dayMs,
      priority: "medium",
      assigneeMembershipIds: [f.employee1M],
      confirmerMembershipId: f.managerM,
    });

    await employee.mutation(api.tasks.completeOneTime, { companyId: f.companyA, taskId });
    const awaiting = await employee.query(api.tasks.getOneTime, { companyId: f.companyA, taskId });
    expect(awaiting.task.state).toMatchObject({ rawStatus: "awaiting_confirmation", status: "Awaiting confirmation" });
    expect(awaiting.task.completedAt).toBeUndefined();

    const list = await manager.query(api.tasks.listAwaitingConfirmation, { companyId: f.companyA, taskType: "one_time" });
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({ submittedBy: { membership: { _id: f.employee1M } }, cycleStart: null });
    const { _id: requestId, submittedAt } = list.rows[0];

    await manager.mutation(api.tasks.confirmTaskCompletion, { companyId: f.companyA, requestId });

    const completed = await admin.query(api.tasks.getOneTime, { companyId: f.companyA, taskId });
    expect(completed.task.state.rawStatus).toBe("completed");
    expect(completed.task.completedAt).toBe(submittedAt);
    expect(completed.task.completedByMembershipId).toBe(f.employee1M);
    expect((await manager.query(api.tasks.listAwaitingConfirmation, { companyId: f.companyA, taskType: "one_time" })).rows).toHaveLength(0);
  });

  test("an assignee retry after confirmation keeps the task completed and does not reopen a request", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const manager = f.asUser("managerA");
    const employee = f.asUser("employeeA1");
    const taskId = await admin.mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "Retry after sign-off",
      dueDate: Date.now() + dayMs,
      priority: "medium",
      assigneeMembershipIds: [f.employee1M],
      confirmerMembershipId: f.managerM,
    });
    await employee.mutation(api.tasks.completeOneTime, { companyId: f.companyA, taskId });
    const { _id: requestId } = (await manager.query(api.tasks.listAwaitingConfirmation, { companyId: f.companyA, taskType: "one_time" })).rows[0];
    await manager.mutation(api.tasks.confirmTaskCompletion, { companyId: f.companyA, requestId });

    await employee.mutation(api.tasks.completeOneTime, { companyId: f.companyA, taskId });

    const after = await employee.query(api.tasks.getOneTime, { companyId: f.companyA, taskId });
    expect(after.task.state.rawStatus).toBe("completed");
    const requests = await f.t.run(async (ctx) => ctx.db
      .query("taskConfirmationRequests")
      .withIndex("by_taskType_and_taskId_and_cycleStart", (q) => q.eq("taskType", "one_time").eq("taskId", taskId))
      .take(10));
    expect(requests).toEqual([]);
  });

  test("an elapsed JD cycle with a pending submission is not recorded as missed, and confirming credits that cycle", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const manager = f.asUser("managerA");
    const employee = f.asUser("employeeA1");
    const taskId = await admin.mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Daily check",
      recurrence: "daily",
      assigneeMembershipIds: [f.employee1M],
      confirmerMembershipId: f.managerM,
    });
    await employee.mutation(api.tasks.completeJd, { companyId: f.companyA, taskId });

    const list = await manager.query(api.tasks.listAwaitingConfirmation, { companyId: f.companyA, taskType: "jd" });
    expect(list.rows).toHaveLength(1);
    const { _id: requestId, submittedAt } = list.rows[0];
    // Move the submission one cycle back, then let the cron-style catch-up walk
    // the elapsed cycle.
    const cycleStart = previousJdCycleStart(list.rows[0].cycleStart!, "daily");
    await f.t.run(async (ctx) => {
      await ctx.db.patch(taskId, { cycleStartedAt: cycleStart, statusCycleStart: cycleStart });
      await ctx.db.patch(requestId, { cycleStart, cycleEnd: nextJdCycleStart(cycleStart, "daily") });
    });
    await f.t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});

    const missed = await f.t.run(async (ctx) => ctx.db
      .query("jdTaskCycleRecords")
      .withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId).eq("cycleStart", cycleStart))
      .first());
    expect(missed).toBeNull();

    await manager.mutation(api.tasks.confirmTaskCompletion, { companyId: f.companyA, requestId });
    const completion = await f.t.run(async (ctx) => ctx.db
      .query("jdTaskCompletions")
      .withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId).eq("cycleStart", cycleStart))
      .first());
    expect(completion).toMatchObject({ completedAt: submittedAt, completedByMembershipId: f.employee1M });
  });

  test("sending a submission back returns the task to progress and discards its evidence", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const manager = f.asUser("managerA");
    const employee = f.asUser("employeeA1");
    const taskId = await admin.mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "Needs proof",
      dueDate: Date.now() + dayMs,
      priority: "medium",
      assigneeMembershipIds: [f.employee1M],
      evidenceRequired: true,
      confirmerMembershipId: f.managerM,
    });
    await employee.mutation(api.tasks.completeOneTime, { companyId: f.companyA, taskId, evidence: { text: "Draft proof" } });
    const { _id: requestId } = (await manager.query(api.tasks.listAwaitingConfirmation, { companyId: f.companyA, taskType: "one_time" })).rows[0];

    await manager.mutation(api.tasks.sendBackTaskCompletion, { companyId: f.companyA, requestId });

    const returned = await employee.query(api.tasks.getOneTime, { companyId: f.companyA, taskId });
    expect(returned.task.state.rawStatus).toBe("in_progress");
    const evidence = await employee.query(api.tasks.getTaskEvidence, {
      companyId: f.companyA,
      taskType: "one_time",
      taskId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(evidence.page).toEqual([]);
    expect((await manager.query(api.tasks.listAwaitingConfirmation, { companyId: f.companyA, taskType: "one_time" })).rows).toHaveLength(0);
  });

  test("only the designated confirmer who currently holds the capability can confirm", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const manager = f.asUser("managerA");
    const employee = f.asUser("employeeA1");
    const taskId = await admin.mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "Manager's call",
      dueDate: Date.now() + dayMs,
      priority: "medium",
      assigneeMembershipIds: [f.employee1M],
      confirmerMembershipId: f.managerM,
    });
    await employee.mutation(api.tasks.completeOneTime, { companyId: f.companyA, taskId });
    const { _id: requestId } = (await manager.query(api.tasks.listAwaitingConfirmation, { companyId: f.companyA, taskType: "one_time" })).rows[0];

    // Another member holding tasks:confirm is not the designated confirmer.
    await expect(admin.mutation(api.tasks.confirmTaskCompletion, { companyId: f.companyA, requestId }))
      .rejects.toThrow("Confirmation request not found.");

    // The designated confirmer must still hold the capability.
    await f.setRoleCapabilities(f.companyA, "Manager", defaultRoleCapabilities.Manager.filter((capability) => capability !== "tasks:confirm"));
    await expect(manager.mutation(api.tasks.confirmTaskCompletion, { companyId: f.companyA, requestId }))
      .rejects.toThrow("You do not have access to do that.");
  });

  test("the designated confirmer can see a task outside their normal view scope", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const manager = f.asUser("managerA");
    const taskId = await admin.mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "Outside the manager's scope",
      dueDate: Date.now() + dayMs,
      priority: "medium",
      assigneeMembershipIds: [f.employee2M],
      confirmerMembershipId: f.managerM,
    });

    const detail = await manager.query(api.tasks.getOneTime, { companyId: f.companyA, taskId });
    expect(detail.task._id).toBe(taskId);
    const rows = await manager.query(api.tasks.listOneTimeRows, {
      companyId: f.companyA,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(rows.page.find((row) => row._id === taskId)?.confirmerMembershipId).toBe(f.managerM);
  });

  test("the default-role backfill grants the capability only to untouched default roles", async () => {
    const f = await createAuthzFixture();
    const previousDefaults = (name: "Admin" | "Manager") => defaultRoleCapabilities[name].filter((capability) => capability !== "tasks:confirm");
    await f.setRoleCapabilities(f.companyA, "Admin", previousDefaults("Admin"));
    await f.setRoleCapabilities(f.companyA, "Manager", previousDefaults("Manager"));
    const roleCapabilities = async (companyId: typeof f.companyA, name: string) => {
      const role = await f.t.run(async (ctx) => await ctx.db.query("roles").withIndex("by_company_and_name", (q) => q.eq("companyId", companyId).eq("name", name)).unique());
      return role?.capabilities ?? [];
    };

    expect(await f.t.mutation(internal.roles.enableTaskConfirmationDefaults, {})).toBe(2);
    expect(await roleCapabilities(f.companyA, "Admin")).toContain("tasks:confirm");
    expect(await roleCapabilities(f.companyA, "Manager")).toContain("tasks:confirm");
    // The fixture's Company B roles already carry the new default.
    expect(await roleCapabilities(f.companyB, "Manager")).toContain("tasks:confirm");
    expect(await f.t.mutation(internal.roles.enableTaskConfirmationDefaults, {})).toBe(0);
  });

  test("changing the confirmer re-points pending submissions, and clearing needs them resolved first", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const manager = f.asUser("managerA");
    const employee = f.asUser("employeeA1");
    const taskId = await admin.mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "Re-pointed sign-off",
      dueDate: Date.now() + dayMs,
      priority: "medium",
      assigneeMembershipIds: [f.employee1M],
      confirmerMembershipId: f.managerM,
    });
    await employee.mutation(api.tasks.completeOneTime, { companyId: f.companyA, taskId });

    await admin.mutation(api.tasks.updateOneTimeFields, { companyId: f.companyA, taskId, confirmerMembershipId: f.adminM });
    expect((await manager.query(api.tasks.listAwaitingConfirmation, { companyId: f.companyA, taskType: "one_time" })).rows).toHaveLength(0);
    const awaitingAdmin = (await admin.query(api.tasks.listAwaitingConfirmation, { companyId: f.companyA, taskType: "one_time" })).rows;
    expect(awaitingAdmin).toHaveLength(1);

    await expect(admin.mutation(api.tasks.updateOneTimeFields, { companyId: f.companyA, taskId, confirmerMembershipId: null }))
      .rejects.toThrow("Confirm or send back the pending submissions before turning off confirmation.");
    const stillAwaiting = await admin.query(api.tasks.getOneTime, { companyId: f.companyA, taskId });
    expect(stillAwaiting.task.state.rawStatus).toBe("awaiting_confirmation");
    expect(stillAwaiting.task.confirmerMembershipId).toBe(f.adminM);

    await admin.mutation(api.tasks.sendBackTaskCompletion, { companyId: f.companyA, requestId: awaitingAdmin[0]._id });
    await admin.mutation(api.tasks.updateOneTimeFields, { companyId: f.companyA, taskId, confirmerMembershipId: null });

    // Clearing after resolution is a plain edit: it never confirms the work.
    const returned = await admin.query(api.tasks.getOneTime, { companyId: f.companyA, taskId });
    expect(returned.task.state.rawStatus).toBe("in_progress");
    expect(returned.task.confirmerMembershipId).toBeUndefined();
    expect(returned.task.completedAt).toBeUndefined();
    expect((await admin.query(api.tasks.listAwaitingConfirmation, { companyId: f.companyA, taskType: "one_time" })).rows).toHaveLength(0);
  });

  test("an assignee with self-only update authority cannot set, replace, or clear the confirmer", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const employee = f.asUser("employeeA1");
    const oneTimeId = await admin.mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "Self-appointed sign-off",
      dueDate: Date.now() + dayMs,
      priority: "medium",
      assigneeMembershipIds: [f.employee1M],
      confirmerMembershipId: f.managerM,
    });
    const jdId = await admin.mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Self-appointed JD sign-off",
      recurrence: "daily",
      assigneeMembershipIds: [f.employee1M],
      confirmerMembershipId: f.managerM,
    });

    await expect(employee.mutation(api.tasks.updateOneTimeFields, { companyId: f.companyA, taskId: oneTimeId, confirmerMembershipId: f.employee1M }))
      .rejects.toThrow("You cannot change who confirms this task.");
    await expect(employee.mutation(api.tasks.updateOneTimeFields, { companyId: f.companyA, taskId: oneTimeId, confirmerMembershipId: null }))
      .rejects.toThrow("You cannot change who confirms this task.");
    await expect(employee.mutation(api.tasks.updateJdFields, { companyId: f.companyA, taskId: jdId, confirmerMembershipId: f.employee1M }))
      .rejects.toThrow("You cannot change who confirms this task.");

    expect((await admin.query(api.tasks.getOneTime, { companyId: f.companyA, taskId: oneTimeId })).task.confirmerMembershipId).toBe(f.managerM);
    expect((await admin.query(api.tasks.getJd, { companyId: f.companyA, taskId: jdId })).task.confirmerMembershipId).toBe(f.managerM);
  });

  test("a confirmer re-point finishes off the interactive path and a later edit still wins", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(utc(29));
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const taskId = await admin.mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Long pending history",
      recurrence: "daily",
      assigneeMembershipIds: [f.employee1M],
      confirmerMembershipId: f.managerM,
    });
    // A third eligible confirmer lets the second edit differ from the first.
    await f.setRoleCapabilities(f.companyA, "Employee", [...defaultRoleCapabilities.Employee, "tasks:confirm"]);
    await f.t.run(async (ctx) => {
      for (let i = 0; i < 250; i++) {
        await ctx.db.insert("taskConfirmationRequests", {
          companyId: f.companyA,
          taskType: "jd",
          taskId,
          cycleStart: utc(29) - (i + 1) * dayMs,
          cycleEnd: utc(29) - i * dayMs,
          recurrence: "daily",
          confirmerMembershipId: f.managerM,
          submittedByMembershipId: f.employee1M,
          submittedAt: utc(29) - (i + 1) * dayMs,
        });
      }
    });
    const countFor = async (membershipId: typeof f.managerM) => await f.t.run(async (ctx) => (await ctx.db.query("taskConfirmationRequests").withIndex("by_taskType_and_taskId_and_cycleStart", (q) => q.eq("taskType", "jd").eq("taskId", taskId)).collect()).filter((request) => request.confirmerMembershipId === membershipId).length);

    await admin.mutation(api.tasks.updateJdFields, { companyId: f.companyA, taskId, confirmerMembershipId: f.adminM });
    // The first batch re-points inline; the rest wait for the continuation.
    expect(await countFor(f.adminM)).toBe(100);
    expect(await countFor(f.managerM)).toBe(150);

    // A second change before the continuation runs must win.
    await admin.mutation(api.tasks.updateJdFields, { companyId: f.companyA, taskId, confirmerMembershipId: f.employee1M });
    await f.t.finishAllScheduledFunctions(() => vi.runAllTimers());

    expect(await countFor(f.employee1M)).toBe(250);
    expect(await countFor(f.adminM)).toBe(0);
    expect(await countFor(f.managerM)).toBe(0);
  });

  test("a confirmer who lost tasks:confirm cannot bypass approval in either status setter", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const manager = f.asUser("managerA");
    const oneTimeId = await admin.mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "Former confirmer one-time",
      dueDate: Date.now() + dayMs,
      priority: "medium",
      assigneeMembershipIds: [f.employee1M],
      confirmerMembershipId: f.managerM,
    });
    const jdId = await admin.mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Former confirmer JD",
      recurrence: "daily",
      assigneeMembershipIds: [f.employee1M],
      confirmerMembershipId: f.managerM,
    });
    await f.setRoleCapabilities(f.companyA, "Manager", defaultRoleCapabilities.Manager.filter((capability) => capability !== "tasks:confirm"));

    await expect(manager.mutation(api.tasks.completeOneTime, { companyId: f.companyA, taskId: oneTimeId }))
      .rejects.toThrow("You can no longer confirm this task. Ask an admin to choose a new confirmer.");
    await expect(manager.mutation(api.tasks.completeJd, { companyId: f.companyA, taskId: jdId }))
      .rejects.toThrow("You can no longer confirm this task. Ask an admin to choose a new confirmer.");
  });

  test("a confirmer completing a waiting task resolves the submission's time and author", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const manager = f.asUser("managerA");
    const employee = f.asUser("employeeA1");
    const oneTimeId = await admin.mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "Confirmer completes one-time",
      dueDate: Date.now() + dayMs,
      priority: "medium",
      assigneeMembershipIds: [f.employee1M],
      confirmerMembershipId: f.managerM,
    });
    const jdId = await admin.mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Confirmer completes JD",
      recurrence: "daily",
      assigneeMembershipIds: [f.employee1M],
      confirmerMembershipId: f.managerM,
    });
    await employee.mutation(api.tasks.completeOneTime, { companyId: f.companyA, taskId: oneTimeId });
    await employee.mutation(api.tasks.completeJd, { companyId: f.companyA, taskId: jdId });
    const oneTimeRequest = (await manager.query(api.tasks.listAwaitingConfirmation, { companyId: f.companyA, taskType: "one_time" })).rows[0];
    const jdRequest = (await manager.query(api.tasks.listAwaitingConfirmation, { companyId: f.companyA, taskType: "jd" })).rows[0];

    await manager.mutation(api.tasks.completeOneTime, { companyId: f.companyA, taskId: oneTimeId });
    await manager.mutation(api.tasks.completeJd, { companyId: f.companyA, taskId: jdId });

    const oneTime = await admin.query(api.tasks.getOneTime, { companyId: f.companyA, taskId: oneTimeId });
    expect(oneTime.task.state.rawStatus).toBe("completed");
    expect(oneTime.task.completedAt).toBe(oneTimeRequest.submittedAt);
    expect(oneTime.task.completedByMembershipId).toBe(f.employee1M);
    const completion = await f.t.run(async (ctx) => await ctx.db
      .query("jdTaskCompletions")
      .withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", jdId).eq("cycleStart", jdRequest.cycleStart!))
      .unique());
    expect(completion).toMatchObject({ completedAt: jdRequest.submittedAt, completedByMembershipId: f.employee1M });
    expect((await admin.query(api.tasks.getJd, { companyId: f.companyA, taskId: jdId })).task.state.rawStatus).toBe("completed");
    const requests = await f.t.run(async (ctx) => await ctx.db.query("taskConfirmationRequests").withIndex("by_taskType_and_taskId_and_cycleStart", (q) => q.eq("taskType", "jd").eq("taskId", jdId)).collect());
    expect(requests).toEqual([]);
  });

  test("confirming a request from a previous recurrence records retired history and leaves the new grid alone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(utc(29));
    const f = await createAuthzFixture();
    await useUtcAllWeekCalendar(f);
    const admin = f.asUser("adminA");
    const manager = f.asUser("managerA");
    const employee = f.asUser("employeeA1");
    const taskId = await admin.mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Recurrence change sign-off",
      recurrence: "daily",
      assigneeMembershipIds: [f.employee1M],
      confirmerMembershipId: f.managerM,
    });
    await employee.mutation(api.tasks.completeJd, { companyId: f.companyA, taskId });
    const request = (await manager.query(api.tasks.listAwaitingConfirmation, { companyId: f.companyA, taskType: "jd" })).rows[0];

    // Monday's daily cycle becomes Monday's weekly cycle.
    await admin.mutation(api.tasks.updateJdFields, { companyId: f.companyA, taskId, recurrence: "weekly" });
    await manager.mutation(api.tasks.confirmTaskCompletion, { companyId: f.companyA, requestId: request._id });

    const task = await admin.query(api.tasks.getJd, { companyId: f.companyA, taskId });
    expect(task.task.recurrence).toBe("weekly");
    expect(task.task.state.rawStatus).toBe("due");
    const completion = await f.t.run(async (ctx) => await ctx.db
      .query("jdTaskCompletions")
      .withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId).eq("cycleStart", request.cycleStart!))
      .first());
    expect(completion).toMatchObject({ completedAt: request.submittedAt, completedByMembershipId: f.employee1M });
    expect(completion?.retiredAt).toBe(utc(29));
  });

  test("sending back a request from a previous recurrence records its miss as retired history", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(utc(29));
    const f = await createAuthzFixture();
    await useUtcAllWeekCalendar(f);
    const admin = f.asUser("adminA");
    const manager = f.asUser("managerA");
    const employee = f.asUser("employeeA1");
    const taskId = await admin.mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Recurrence change send-back",
      recurrence: "daily",
      assigneeMembershipIds: [f.employee1M],
      confirmerMembershipId: f.managerM,
    });
    await employee.mutation(api.tasks.completeJd, { companyId: f.companyA, taskId });
    const request = (await manager.query(api.tasks.listAwaitingConfirmation, { companyId: f.companyA, taskType: "jd" })).rows[0];

    await admin.mutation(api.tasks.updateJdFields, { companyId: f.companyA, taskId, recurrence: "weekly" });
    await manager.mutation(api.tasks.sendBackTaskCompletion, { companyId: f.companyA, requestId: request._id });

    const task = await admin.query(api.tasks.getJd, { companyId: f.companyA, taskId });
    expect(task.task.state.rawStatus).toBe("due");
    const missed = await f.t.run(async (ctx) => await ctx.db
      .query("jdTaskCycleRecords")
      .withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId).eq("cycleStart", request.cycleStart!))
      .first());
    expect(missed).toMatchObject({ cycleEnd: request.cycleEnd, status: "missed", retiredAt: utc(29) });
  });

  test("a request from a previous recurrence does not suppress the new grid's missed cycle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(utc(29));
    const f = await createAuthzFixture();
    await useUtcAllWeekCalendar(f);
    const admin = f.asUser("adminA");
    const employee = f.asUser("employeeA1");
    const taskId = await admin.mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Old grid pending request",
      recurrence: "daily",
      assigneeMembershipIds: [f.employee1M],
      confirmerMembershipId: f.managerM,
    });
    await employee.mutation(api.tasks.completeJd, { companyId: f.companyA, taskId });
    const request = (await f.asUser("managerA").query(api.tasks.listAwaitingConfirmation, { companyId: f.companyA, taskType: "jd" })).rows[0];

    await admin.mutation(api.tasks.updateJdFields, { companyId: f.companyA, taskId, recurrence: "weekly" });
    vi.setSystemTime(utc(6, 6));
    await f.t.mutation(internal.tasks.recordMissedJdCyclesBatch, {});

    const missed = await f.t.run(async (ctx) => await ctx.db
      .query("jdTaskCycleRecords")
      .withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId).eq("cycleStart", request.cycleStart!))
      .first());
    expect(missed).toMatchObject({ status: "missed" });
    expect(missed?.retiredAt).toBeUndefined();
  });

  test("the dashboard ignores a pending request from a superseded recurrence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(utc(29));
    const f = await createAuthzFixture();
    await useUtcAllWeekCalendar(f);
    const admin = f.asUser("adminA");
    const employee = f.asUser("employeeA1");
    const taskId = await admin.mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Dashboard retired hold",
      recurrence: "daily",
      assigneeMembershipIds: [f.employee1M],
      confirmerMembershipId: f.managerM,
    });
    await employee.mutation(api.tasks.completeJd, { companyId: f.companyA, taskId });
    await admin.mutation(api.tasks.updateJdFields, { companyId: f.companyA, taskId, recurrence: "weekly" });

    vi.setSystemTime(utc(6, 6));
    const dashboard = await admin.query(api.analytics.dashboard, { companyId: f.companyA, now: utc(6, 6), range: { preset: "last_3_months" } });
    expect(dashboard.jd.overdue).toBe(1);
  });
});
