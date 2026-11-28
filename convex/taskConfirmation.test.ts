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
  test("the suggested confirmer is who the assignee reports to, else the preferred admin", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const suggest = async (assignee: typeof f.employee1M) =>
      (await admin.query(api.tasks.eligibleConfirmers, { companyId: f.companyA, assigneeMembershipIds: [assignee] })).suggestion;

    // Employee A1 reports only to Manager A.
    expect(await suggest(f.employee1M)).toEqual({ source: "managers", membershipIds: [f.managerM] });

    // A second manager over A1's department makes it a choice between both.
    await f.t.run(async (ctx) => { await ctx.db.insert("managerDepartmentScopes", { companyId: f.companyA, managerMembershipId: f.adminM, departmentId: f.deptA1, updatedAt: Date.now() }); });
    const both = await suggest(f.employee1M);
    expect(both?.source).toBe("managers");
    expect(new Set(both?.membershipIds)).toEqual(new Set([f.managerM, f.adminM]));

    // Employee A2 reports to nobody: no suggestion until a preferred admin is set.
    expect(await suggest(f.employee2M)).toBeNull();
    await expect(admin.mutation(api.companyManagement.updatePreferredAdmin, { companyId: f.companyA, membershipId: f.employee1M })).rejects.toThrow("cannot confirm");
    await admin.mutation(api.companyManagement.updatePreferredAdmin, { companyId: f.companyA, membershipId: f.adminM });
    expect(await suggest(f.employee2M)).toEqual({ source: "preferred_admin", membershipIds: [f.adminM] });
  });

  test("a confirmer who joined after 500 other members is still listed and suggested", async () => {
    const f = await createAuthzFixture();
    // Fill the company past 500 members, then add Employee A2's manager.
    const lateManagerM = await f.t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 500; i++) {
        const userId = await ctx.db.insert("appUsers", { clerkSubject: `clerk|filler${i}`, email: `filler${i}@example.com`, firstName: "Filler", createdAt: now, updatedAt: now });
        await ctx.db.insert("companyMemberships", { companyId: f.companyA, userId, role: "Employee", active: true, createdAt: now, updatedAt: now });
      }
      const userId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|lateManager", email: "latemanager@example.com", firstName: "Late", createdAt: now, updatedAt: now });
      const membershipId = await ctx.db.insert("companyMemberships", { companyId: f.companyA, userId, role: "Manager", active: true, createdAt: now, updatedAt: now });
      await ctx.db.insert("managerUserScopes", { companyId: f.companyA, managerMembershipId: membershipId, userMembershipId: f.employee2M, updatedAt: now });
      await ctx.db.patch(f.companyA, { preferredAdminMembershipId: f.adminM });
      return membershipId;
    });

    // The preferred admin picker lists every confirmer, with no assignees.
    const list = await f.asUser("adminA").query(api.tasks.eligibleConfirmers, { companyId: f.companyA });
    expect(list.isTruncated).toBe(false);
    expect(list.users.some((row) => row.membership._id === lateManagerM)).toBe(true);

    const result = await f.asUser("adminA").query(api.tasks.eligibleConfirmers, { companyId: f.companyA, assigneeMembershipIds: [f.employee2M] });
    expect(result.suggestion).toEqual({ source: "managers", membershipIds: [lateManagerM] });
  });

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

  test("a manager assignee cannot use managed update authority to appoint or clear their own confirmer", async () => {
    const f = await createAuthzFixture();
    const admin = f.asUser("adminA");
    const manager = f.asUser("managerA");
    const taskId = await admin.mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "Manager-approved own work",
      dueDate: Date.now() + dayMs,
      priority: "medium",
      assigneeMembershipIds: [f.managerM],
      confirmerMembershipId: f.adminM,
    });

    await expect(manager.mutation(api.tasks.updateOneTimeFields, { companyId: f.companyA, taskId, confirmerMembershipId: f.managerM }))
      .rejects.toThrow("You cannot change who confirms this task.");
    await expect(manager.mutation(api.tasks.updateOneTimeFields, { companyId: f.companyA, taskId, confirmerMembershipId: null }))
      .rejects.toThrow("You cannot change who confirms this task.");
    expect((await admin.query(api.tasks.getOneTime, { companyId: f.companyA, taskId })).task.confirmerMembershipId).toBe(f.adminM);

    // Managed authority still reaches targets the caller is not part of.
    const subordinateTaskId = await admin.mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "Subordinate sign-off",
      dueDate: Date.now() + dayMs,
      priority: "medium",
      assigneeMembershipIds: [f.employee1M],
      confirmerMembershipId: f.adminM,
    });
    await manager.mutation(api.tasks.updateOneTimeFields, { companyId: f.companyA, taskId: subordinateTaskId, confirmerMembershipId: f.managerM });
    expect((await admin.query(api.tasks.getOneTime, { companyId: f.companyA, taskId: subordinateTaskId })).task.confirmerMembershipId).toBe(f.managerM);

    // update:any is the override, even when the caller is an assignee.
    const adminAssignedTaskId = await admin.mutation(api.tasks.createOneTime, {
      companyId: f.companyA,
      title: "Admin-assigned sign-off",
      dueDate: Date.now() + dayMs,
      priority: "medium",
      assigneeMembershipIds: [f.adminM],
      confirmerMembershipId: f.managerM,
    });
    await admin.mutation(api.tasks.updateOneTimeFields, { companyId: f.companyA, taskId: adminAssignedTaskId, confirmerMembershipId: f.adminM });
    expect((await admin.query(api.tasks.getOneTime, { companyId: f.companyA, taskId: adminAssignedTaskId })).task.confirmerMembershipId).toBe(f.adminM);
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

  test("moving a cycle end retires a pending request even when the new cycle starts the same day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2027, 2, 10, 12));
    const f = await createAuthzFixture();
    await useUtcAllWeekCalendar(f);
    const admin = f.asUser("adminA");
    const manager = f.asUser("managerA");
    const employee = f.asUser("employeeA1");
    const taskId = await admin.mutation(api.tasks.createJd, {
      companyId: f.companyA,
      title: "Cycle end sign-off",
      recurrence: "monthly",
      assigneeMembershipIds: [f.employee1M],
      confirmerMembershipId: f.managerM,
    });
    await employee.mutation(api.tasks.completeJd, { companyId: f.companyA, taskId });
    const request = (await manager.query(api.tasks.listAwaitingConfirmation, { companyId: f.companyA, taskType: "jd" })).rows[0];

    // February 2027 ends on the 28th, so both grids start a cycle on 1 March.
    await admin.mutation(api.tasks.updateJdFields, { companyId: f.companyA, taskId, cycleEndMonthDay: 1228 });
    await manager.mutation(api.tasks.confirmTaskCompletion, { companyId: f.companyA, requestId: request._id });

    const task = await admin.query(api.tasks.getJd, { companyId: f.companyA, taskId });
    expect(task.task.state).toMatchObject({ rawStatus: "due", currentCycleStart: request.cycleStart, currentCycleEnd: Date.UTC(2027, 2, 29) });
    const completion = await f.t.run(async (ctx) => await ctx.db
      .query("jdTaskCompletions")
      .withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId).eq("cycleStart", request.cycleStart!))
      .first());
    expect(completion?.retiredAt).toBe(Date.UTC(2027, 2, 10, 12));
  });

  // A March 2027 submission on the month-end grid, then a move to cycles
  // ending on the 28th (both start 1 March), and the confirmer finishing the
  // new cycle with their own evidence.
  async function sharedStartAfterCycleEndMove() {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2027, 2, 10, 12));
    const f = await createAuthzFixture();
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.companyA, { timeZone: "UTC" });
      await ctx.db.insert("companyCalendars", { companyId: f.companyA, workingDays: [0, 1, 2, 3, 4, 5, 6], updatedAt: Date.now() });
    });
    const admin = f.asUser("adminA");
    const manager = f.asUser("managerA");
    const taskId = await admin.mutation(api.tasks.createJd, { companyId: f.companyA, title: "Shared start", recurrence: "monthly", assigneeMembershipIds: [f.employee1M], confirmerMembershipId: f.managerM });
    await f.asUser("employeeA1").mutation(api.tasks.completeJd, { companyId: f.companyA, taskId, evidence: { text: "Old proof" } });
    const request = (await manager.query(api.tasks.listAwaitingConfirmation, { companyId: f.companyA, taskType: "jd" })).rows[0];
    await admin.mutation(api.tasks.updateJdFields, { companyId: f.companyA, taskId, cycleEndMonthDay: 1228 });
    await manager.mutation(api.tasks.completeJd, { companyId: f.companyA, taskId, evidence: { text: "New proof" } });
    return { f, manager, taskId, request };
  }

  test("confirming a superseded request keeps its completion beside the new cycle's", async () => {
    const { f, manager, taskId, request } = await sharedStartAfterCycleEndMove();
    await manager.mutation(api.tasks.confirmTaskCompletion, { companyId: f.companyA, requestId: request._id });

    const completions = await f.t.run(async (ctx) => await ctx.db.query("jdTaskCompletions").withIndex("by_task_and_cycleStart", (q) => q.eq("jdTaskId", taskId).eq("cycleStart", request.cycleStart!)).collect());
    expect(completions.map((row) => [row.completedByMembershipId, row.retiredAt !== undefined]).sort()).toEqual([[f.employee1M, true], [f.managerM, false]].sort());
  });

  test("sending back a superseded request keeps the new cycle's evidence", async () => {
    const { f, manager, taskId, request } = await sharedStartAfterCycleEndMove();
    await manager.mutation(api.tasks.sendBackTaskCompletion, { companyId: f.companyA, requestId: request._id });

    const evidence = await manager.query(api.tasks.getTaskEvidence, { companyId: f.companyA, taskType: "jd", taskId, paginationOpts: { numItems: 10, cursor: null } });
    expect(evidence.page.filter((entry) => entry.retiredAt == null).map((entry) => entry.text)).toEqual(["New proof"]);
  });

  test.each([
    ["sent with the submission", false],
    ["added by a retry", true],
  ])("sending back a request whose start the new schedule does not share removes its proof %s", async (_, addedByRetry) => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2027, 2, 10, 12));
    const f = await createAuthzFixture();
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.companyA, { timeZone: "UTC" });
      await ctx.db.insert("companyCalendars", { companyId: f.companyA, workingDays: [0, 1, 2, 3, 4, 5, 6], updatedAt: Date.now() });
    });
    const admin = f.asUser("adminA");
    const manager = f.asUser("managerA");
    const taskId = await admin.mutation(api.tasks.createJd, { companyId: f.companyA, title: "Moved start", recurrence: "monthly", assigneeMembershipIds: [f.employee1M], confirmerMembershipId: f.managerM });
    const storageId = await f.t.run(async (ctx) => await ctx.storage.store(new Blob(["proof"])));
    const claimId = await f.t.run(async (ctx) => await ctx.db.insert("taskUploadClaims", { companyId: f.companyA, membershipId: f.employee1M, storageId, createdAt: Date.now() }));
    const employee = f.asUser("employeeA1");
    if (addedByRetry) await employee.mutation(api.tasks.completeJd, { companyId: f.companyA, taskId });
    await employee.mutation(api.tasks.completeJd, { companyId: f.companyA, taskId, evidence: { text: "Old proof", files: [{ storageId, fileName: "proof.txt", claimId }] } });
    const request = (await manager.query(api.tasks.listAwaitingConfirmation, { companyId: f.companyA, taskType: "jd" })).rows[0];
    // Cycles now end on the 25th, so the current one starts 26 February.
    await admin.mutation(api.tasks.updateJdFields, { companyId: f.companyA, taskId, cycleEndMonthDay: 1225 });

    await manager.mutation(api.tasks.sendBackTaskCompletion, { companyId: f.companyA, requestId: request._id });

    const evidence = await manager.query(api.tasks.getTaskEvidence, { companyId: f.companyA, taskType: "jd", taskId, paginationOpts: { numItems: 10, cursor: null } });
    expect(evidence.page).toEqual([]);
    expect(await f.t.run(async (ctx) => await ctx.db.system.get("_storage", storageId))).toBeNull();
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
    const dashboard = await admin.query(api.analytics.dashboard, { companyId: f.companyA, now: utc(6, 6), period: { unit: "month", date: "2026-07-06" } });
    // The daily request no longer holds the weekly grid, so its elapsed cycle
    // is missed.
    expect(dashboard.jd).toMatchObject({ due: 1, done: 0, missed: 1 });
  });
});
