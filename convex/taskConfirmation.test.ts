/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import { createAuthzFixture } from "./authz.fixture";
import { defaultRoleCapabilities } from "../src/lib/permissions";
import { nextJdCycleStart, previousJdCycleStart } from "./taskCycles";

const dayMs = 86_400_000;

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

  test("changing the confirmer re-points a pending submission, and turning confirmation off completes it", async () => {
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
    const submittedAt = (await manager.query(api.tasks.listAwaitingConfirmation, { companyId: f.companyA, taskType: "one_time" })).rows[0].submittedAt;

    await admin.mutation(api.tasks.updateOneTimeFields, { companyId: f.companyA, taskId, confirmerMembershipId: f.adminM });
    expect((await manager.query(api.tasks.listAwaitingConfirmation, { companyId: f.companyA, taskType: "one_time" })).rows).toHaveLength(0);
    expect((await admin.query(api.tasks.listAwaitingConfirmation, { companyId: f.companyA, taskType: "one_time" })).rows).toHaveLength(1);

    await admin.mutation(api.tasks.updateOneTimeFields, { companyId: f.companyA, taskId, confirmerMembershipId: null });

    const completed = await admin.query(api.tasks.getOneTime, { companyId: f.companyA, taskId });
    expect(completed.task.state.rawStatus).toBe("completed");
    expect(completed.task.completedAt).toBe(submittedAt);
    expect(completed.task.completedByMembershipId).toBe(f.employee1M);
    expect((await admin.query(api.tasks.listAwaitingConfirmation, { companyId: f.companyA, taskType: "one_time" })).rows).toHaveLength(0);
  });
});
