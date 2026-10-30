/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { defaultRoleCapabilities } from "../src/lib/permissions";
import { currentJdCycle, defaultTimeZone, previousJdCycleStart } from "./taskCycles";

const modules = import.meta.glob("./**/*.ts");
const dayMs = 86_400_000;
// A mid-month, mid-year Wednesday in the default company time zone (GMT+5).
// Pinning it keeps relative fixtures inside one month, quarter and year no
// matter when the suite runs.
const pinnedNow = Date.UTC(2026, 8, 16, 12);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(pinnedNow);
});
afterEach(() => { vi.useRealTimers(); });

const dateFieldParts = new Intl.DateTimeFormat("en-US", { timeZone: defaultTimeZone, year: "numeric", month: "2-digit", day: "2-digit" });
function dateField(ms: number) {
  const parts = Object.fromEntries(dateFieldParts.formatToParts(ms).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function lastDayOfMonthField(ms: number) {
  const [year, month] = dateField(ms).split("-").map(Number);
  return `${year}-${String(month).padStart(2, "0")}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
}

const monthPeriod = (ms: number) => ({ unit: "month" as const, date: dateField(ms) });
const yearPeriod = (ms: number) => ({ unit: "year" as const, date: dateField(ms) });

function identity(key: string, email = `${key}@example.com`) {
  return { tokenIdentifier: `clerk|${key}`, subject: key, issuer: "https://clerk.test", email, name: key };
}

async function seedBareCompany() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const companyId = await ctx.db.insert("companies", { name: "Bare", createdAt: now });
    // These tests assert the raw recurrence grid; an all-week calendar keeps
    // the work-calendar overlay out of the picture.
    await ctx.db.insert("companyCalendars", { companyId, workingDays: [0, 1, 2, 3, 4, 5, 6], updatedAt: now });
    const adminUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", firstName: "Admin", secondName: "", createdAt: now, updatedAt: now });
    const adminMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: adminUserId, role: "Admin", active: true, createdAt: now, updatedAt: now });
    return { companyId, adminMembershipId };
  });
  return { t, ...ids };
}

async function seedDashboardCompany() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const companyId = await ctx.db.insert("companies", { name: "Acme", createdAt: now });
    // These tests assert the raw recurrence grid; an all-week calendar keeps
    // the work-calendar overlay out of the picture.
    await ctx.db.insert("companyCalendars", { companyId, workingDays: [0, 1, 2, 3, 4, 5, 6], updatedAt: now });
    const branchAId = await ctx.db.insert("branches", { companyId, name: "North", order: 0, createdAt: now, updatedAt: now });
    const branchBId = await ctx.db.insert("branches", { companyId, name: "South", order: 1, createdAt: now, updatedAt: now });
    const departmentAId = await ctx.db.insert("departments", { companyId, branchId: branchAId, name: "Ops", order: 0, createdAt: now, updatedAt: now });
    const departmentA2Id = await ctx.db.insert("departments", { companyId, branchId: branchAId, name: "Support", order: 1, createdAt: now, updatedAt: now });
    const departmentBId = await ctx.db.insert("departments", { companyId, branchId: branchBId, name: "Finance", order: 0, createdAt: now, updatedAt: now });
    const adminUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|admin", email: "admin@example.com", firstName: "Admin", secondName: "", createdAt: now, updatedAt: now });
    const managerUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|manager", email: "manager@example.com", firstName: "Manager", secondName: "", createdAt: now, updatedAt: now });
    const employeeUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|employee", email: "employee@example.com", firstName: "Employee", secondName: "", createdAt: now, updatedAt: now });
    const hiddenUserId = await ctx.db.insert("appUsers", { clerkSubject: "clerk|hidden", email: "hidden@example.com", firstName: "Hidden", secondName: "", createdAt: now, updatedAt: now });
    const adminMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: adminUserId, role: "Admin", active: true, createdAt: now, updatedAt: now });
    const managerMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: managerUserId, role: "Manager", active: true, createdAt: now, updatedAt: now });
    const employeeMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: employeeUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });
    const hiddenMembershipId = await ctx.db.insert("companyMemberships", { companyId, userId: hiddenUserId, role: "Employee", active: true, createdAt: now, updatedAt: now });
    await ctx.db.insert("userBranchAssignments", { companyId, membershipId: employeeMembershipId, branchId: branchAId });
    await ctx.db.insert("userDepartmentAssignments", { companyId, membershipId: employeeMembershipId, departmentId: departmentAId });
    await ctx.db.insert("userBranchAssignments", { companyId, membershipId: hiddenMembershipId, branchId: branchBId });
    await ctx.db.insert("userDepartmentAssignments", { companyId, membershipId: hiddenMembershipId, departmentId: departmentBId });
    await ctx.db.insert("managerBranchScopes", { companyId, managerMembershipId, branchId: branchAId, updatedAt: now });
    return { companyId, branchAId, branchBId, departmentAId, departmentA2Id, departmentBId, adminUserId, adminMembershipId, managerMembershipId, employeeUserId, employeeMembershipId, hiddenMembershipId };
  });

  const visibleTaskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, {
    companyId: ids.companyId,
    title: "Visible employee task",
    description: "",
    dueDate: Date.now() + dayMs,
    assigneeMembershipIds: [ids.employeeMembershipId],
    priority: "high",
  });
  const hiddenTaskId = await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, {
    companyId: ids.companyId,
    title: "Hidden branch task",
    description: "",
    dueDate: Date.now() + dayMs,
    assigneeMembershipIds: [ids.hiddenMembershipId],
    priority: "medium",
  });
  return { t, ...ids, visibleTaskId, hiddenTaskId };
}

describe("dashboard analytics scoping", () => {
  test("admin, manager, and employee dashboards receive only their allowed analytics", { timeout: 15_000 }, async () => {
    const { t, companyId, branchAId, branchBId, departmentAId, departmentA2Id, departmentBId, employeeMembershipId, hiddenMembershipId } = await seedDashboardCompany();
    const now = Date.now();
    const period = monthPeriod(now);

    const admin = t.withIdentity(identity("admin"));
    const adminFilters = await admin.query(api.analytics.dashboardFilters, { companyId });
    expect(adminFilters.branches.map((branch) => branch._id)).toEqual([branchAId, branchBId]);
    expect(adminFilters.departments).toHaveLength(3);
    const adminDashboard = await admin.query(api.analytics.dashboard, { companyId, now, period });
    expect(adminDashboard.tasks.assigned).toBe(2);
    expect(adminDashboard.scope).toBe("team");
    await expect(admin.query(api.analytics.dashboard, { companyId, now, period, branchId: branchBId })).resolves.toMatchObject({ tasks: { assigned: 1 } });

    const manager = t.withIdentity(identity("manager"));
    const managerFilters = await manager.query(api.analytics.dashboardFilters, { companyId });
    expect(managerFilters.branches.map((branch) => branch._id)).toEqual([branchAId]);
    expect(managerFilters.departments.map((department) => department._id)).toEqual([departmentAId, departmentA2Id]);
    const managerDashboard = await manager.query(api.analytics.dashboard, { companyId, now, period });
    expect(managerDashboard.tasks.assigned).toBe(1);
    expect(managerDashboard.scope).toBe("team");
    expect(managerDashboard.tasks.employees.map((row) => row.membershipId)).toEqual([employeeMembershipId]);
    expect(managerDashboard.tasks.employees.map((row) => row.membershipId)).not.toContain(hiddenMembershipId);
    await expect(manager.query(api.analytics.dashboard, { companyId, now, period, membershipId: hiddenMembershipId })).rejects.toThrow("outside your analytics scope");
    await expect(manager.query(api.analytics.dashboard, { companyId, now, period, branchId: branchBId })).rejects.toThrow("outside your analytics scope");
    await expect(manager.query(api.analytics.dashboard, { companyId, now, period, departmentId: departmentBId })).rejects.toThrow("outside your analytics scope");

    const employee = t.withIdentity(identity("employee"));
    const employeeFilters = await employee.query(api.analytics.dashboardFilters, { companyId });
    expect(employeeFilters.branches).toEqual([]);
    expect(employeeFilters.departments).toEqual([]);
    const employeeDashboard = await employee.query(api.analytics.dashboard, { companyId, now, period });
    expect(employeeDashboard.tasks.assigned).toBe(1);
    expect(employeeDashboard.scope).toBe("self");
    expect(employeeDashboard.jd.employees).toEqual([]);
    expect(employeeDashboard.tasks.employees).toEqual([]);
    await expect(employee.query(api.analytics.dashboard, { companyId, now, period, membershipId: hiddenMembershipId })).rejects.toThrow("outside your analytics scope");
    await expect(employee.query(api.analytics.dashboard, { companyId, now, period, branchId: branchAId })).rejects.toThrow("not available");
  });

  test("JD cycles are counted by deadline within the period, honouring completions, missed records and unrecorded elapsed cycles", { timeout: 15_000 }, async () => {
    const { t, companyId, adminMembershipId, employeeMembershipId } = await seedDashboardCompany();
    const now = Date.now();
    const cycle = (k: number) => currentJdCycle("daily", now - k * dayMs, undefined);

    await t.run(async (ctx) => {
      const jdTaskId = await ctx.db.insert("jdTasks", {
        companyId,
        reference: "JD-0001",
        title: "Daily JD",
        description: "",
        recurrence: "daily",
        cycleStartedAt: cycle(5).start,
        status: "due",
        statusCycleStart: cycle(0).start,
        assigneeMembershipIds: [employeeMembershipId],
        createdByMembershipId: adminMembershipId,
        createdAt: cycle(5).start,
        updatedAt: cycle(5).start,
      });
      for (const k of [1, 3]) {
        await ctx.db.insert("jdTaskCompletions", { companyId, jdTaskId, cycleStart: cycle(k).start, cycleEnd: cycle(k).end, completedByMembershipId: employeeMembershipId, completedAt: cycle(k).start + 3_600_000 });
      }
      await ctx.db.insert("jdTaskCycleRecords", { companyId, jdTaskId, cycleStart: cycle(4).start, cycleEnd: cycle(4).end, status: "missed", recordedAt: now });
    });

    const dashboard = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId, now, period: yearPeriod(now) });
    // k=1 and k=3 are done; k=2, k=4, k=5 are past their deadline; today's
    // cycle is not due yet, so it does not count.
    expect(dashboard.jd).toMatchObject({ due: 5, done: 2, missed: 3, waiting: 0, completionRate: 40 });
    const bucketTotals = dashboard.buckets.reduce(
      (sum, bucket) => ({ due: sum.due + bucket.jd.due, done: sum.done + bucket.jd.done }),
      { due: 0, done: 0 },
    );
    expect(bucketTotals).toEqual({ due: 5, done: 2 });
    expect(dashboard.tasks.assigned).toBe(2);
  });

  test("a cycle due later today is not counted until it is completed", { timeout: 15_000 }, async () => {
    const { t, companyId, adminMembershipId, employeeMembershipId } = await seedDashboardCompany();
    const now = Date.now();
    const admin = t.withIdentity(identity("admin"));
    const period = monthPeriod(now);

    const daily = currentJdCycle("daily", now, undefined);
    const dailyTaskId = await t.run(async (ctx) => await ctx.db.insert("jdTasks", {
      companyId,
      reference: "JD-0002",
      title: "Daily JD",
      description: "",
      recurrence: "daily",
      cycleStartedAt: daily.start,
      status: "due",
      statusCycleStart: daily.start,
      assigneeMembershipIds: [employeeMembershipId],
      createdByMembershipId: adminMembershipId,
      createdAt: now,
      updatedAt: now,
    }));

    let dashboard = await admin.query(api.analytics.dashboard, { companyId, now, period });
    expect(dashboard.jd).toMatchObject({ due: 0, done: 0, missed: 0, waiting: 0, completionRate: null });
    expect(dashboard.jd.byFrequency.find((row) => row.recurrence === "daily")?.upcoming).toEqual({ count: 1, dueDate: dateField(now) });

    await admin.mutation(api.tasks.completeJd, { companyId, taskId: dailyTaskId });
    dashboard = await admin.query(api.analytics.dashboard, { companyId, now, period });
    expect(dashboard.jd).toMatchObject({ due: 1, done: 1, missed: 0, waiting: 0, completionRate: 100 });
  });

  test("tasks are a cohort by createdAt; completions outside the cohort don't count", { timeout: 15_000 }, async () => {
    const { t, companyId, adminMembershipId, employeeMembershipId, visibleTaskId } = await seedDashboardCompany();
    const now = Date.now();
    const admin = t.withIdentity(identity("admin"));
    const period = monthPeriod(now);

    await t.run(async (ctx) => {
      await ctx.db.insert("oneTimeTasks", {
        companyId,
        reference: "OT-OLD",
        title: "Completed long ago",
        description: "",
        priority: "medium",
        status: "completed",
        completedAt: now,
        assigneeMembershipIds: [employeeMembershipId],
        createdByMembershipId: adminMembershipId,
        createdAt: now - 120 * dayMs,
        updatedAt: now,
      });
      await ctx.db.insert("oneTimeTasks", {
        companyId,
        reference: "OT-OVERDUE",
        title: "Past its due date",
        description: "",
        priority: "medium",
        status: "due",
        dueDate: now - dayMs,
        assigneeMembershipIds: [employeeMembershipId],
        createdByMembershipId: adminMembershipId,
        createdAt: now,
        updatedAt: now,
      });
    });
    let dashboard = await admin.query(api.analytics.dashboard, { companyId, now, period });
    expect(dashboard.tasks.assigned).toBe(3);

    await admin.mutation(api.tasks.completeOneTime, { companyId, taskId: visibleTaskId });
    dashboard = await admin.query(api.analytics.dashboard, { companyId, now, period });
    expect(dashboard.tasks).toMatchObject({ assigned: 3, done: 1, overdue: 1, notDueYet: 1, completionRate: 33 });
  });

  test("completion rates are weighted by assigned work, and filters narrow the employee rows", { timeout: 15_000 }, async () => {
    const { t, companyId, branchAId, departmentAId, adminMembershipId, employeeMembershipId, hiddenTaskId } = await seedDashboardCompany();
    const now = Date.now();
    const admin = t.withIdentity(identity("admin"));
    const period = monthPeriod(now);

    const today = currentJdCycle("daily", now, undefined);
    await t.run(async (ctx) => {
      const jdTaskId = await ctx.db.insert("jdTasks", {
        companyId,
        reference: "JD-0004",
        title: "Employee daily JD",
        description: "",
        recurrence: "daily",
        cycleStartedAt: today.start,
        status: "due",
        statusCycleStart: today.start,
        assigneeMembershipIds: [employeeMembershipId],
        createdByMembershipId: adminMembershipId,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("jdTaskCompletions", { companyId, jdTaskId, cycleStart: today.start, cycleEnd: today.end, completedByMembershipId: employeeMembershipId, completedAt: now });
      for (let i = 0; i < 4; i++) {
        await ctx.db.insert("oneTimeTasks", {
          companyId,
          reference: `OT-X${i}`,
          title: `Employee extra task ${i}`,
          description: "",
          priority: "low",
          status: "due",
          assigneeMembershipIds: [employeeMembershipId],
          createdByMembershipId: adminMembershipId,
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    await admin.mutation(api.tasks.completeOneTime, { companyId, taskId: hiddenTaskId });

    const dashboard = await admin.query(api.analytics.dashboard, { companyId, now, period });
    // Six one-time tasks, one completed; the single completed JD is its own 1/1.
    expect(dashboard.tasks).toMatchObject({ assigned: 6, done: 1, completionRate: 17 });
    expect(dashboard.jd).toMatchObject({ due: 1, done: 1, completionRate: 100 });
    expect(dashboard.jd.employees).toMatchObject([{ membershipId: employeeMembershipId, due: 1, done: 1, completionRate: 100 }]);
    expect(dashboard.tasks.employees).toMatchObject([
      { name: "Hidden", assigned: 1, done: 1, completionRate: 100 },
      { name: "Employee", assigned: 5, done: 0, completionRate: 0 },
    ]);

    const branch = await admin.query(api.analytics.dashboard, { companyId, now, period, branchId: branchAId });
    expect(branch.tasks.assigned).toBe(5);
    expect(branch.jd.employees.map((row) => row.name)).toEqual(["Employee"]);
    expect(branch.tasks.employees.map((row) => row.name)).toEqual(["Employee"]);

    const department = await admin.query(api.analytics.dashboard, { companyId, now, period, departmentId: departmentAId });
    expect(department.tasks.employees).toMatchObject([{ name: "Employee", assigned: 5, done: 0, completionRate: 0 }]);

    const user = await admin.query(api.analytics.dashboard, { companyId, now, period, membershipId: employeeMembershipId });
    expect(user.scope).toBe("self");
    expect(user.employee).toMatchObject({ membershipId: employeeMembershipId, name: "Employee" });
    expect(user.jd.employees).toEqual([]);
    expect(user.tasks.employees).toEqual([]);
  });

  test("person display fallbacks do not expose emails", { timeout: 15_000 }, async () => {
    const { t, companyId, employeeUserId, employeeMembershipId } = await seedDashboardCompany();
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.patch(employeeUserId, { firstName: "", secondName: "" });
    });

    const admin = t.withIdentity(identity("admin"));
    const filters = await admin.query(api.analytics.dashboardFilters, { companyId });
    const dashboard = await admin.query(api.analytics.dashboard, { companyId, now, period: monthPeriod(now), membershipId: employeeMembershipId });
    expect(dashboard.employee?.name).toBe("Unknown");
    expect(JSON.stringify(filters)).not.toContain("employee@example.com");
    expect(JSON.stringify(dashboard)).not.toContain("employee@example.com");
  });

  test("managed-scope analytics excludes self when analytics:view:self is denied", { timeout: 15_000 }, async () => {
    const { t, companyId, managerMembershipId, employeeMembershipId } = await seedDashboardCompany();
    const now = Date.now();
    await t.withIdentity(identity("admin")).mutation(api.tasks.createOneTime, {
      companyId,
      title: "Manager self task",
      dueDate: Date.now() + dayMs,
      assigneeMembershipIds: [managerMembershipId],
      priority: "medium",
    });
    await t.run(async (ctx) => {
      const createdAt = Date.now();
      await ctx.db.insert("roles", {
        companyId,
        name: "Manager",
        capabilities: defaultRoleCapabilities.Manager.filter((capability) => capability !== "analytics:view:self"),
        createdAt,
        updatedAt: createdAt,
      });
    });

    const manager = t.withIdentity(identity("manager"));
    const period = monthPeriod(now);
    const dashboard = await manager.query(api.analytics.dashboard, { companyId, now, period });
    // The manager's own task is not visible without analytics:view:self; the
    // branch employee's task still is.
    expect(dashboard.tasks.assigned).toBe(1);
    expect(dashboard.tasks.employees.map((row) => row.membershipId)).toEqual([employeeMembershipId]);
    const summary = await manager.query(api.analytics.aiSummary, { companyId });
    expect(summary.oneTimeTaskCount).toBe(1);
    expect(summary.scopeSize).toBe(1);
  });

  test("invalid period dates are rejected", { timeout: 15_000 }, async () => {
    const { t, companyId } = await seedDashboardCompany();
    const admin = t.withIdentity(identity("admin"));
    await expect(admin.query(api.analytics.dashboard, { companyId, now: Date.now(), period: { unit: "month", date: "2026-02-30" } })).rejects.toThrow("Invalid date.");
  });
});

describe("dashboard historical JD cycles", () => {
  // Fixed timestamps in the default company time zone (GMT+5); the query
  // accounts in server time, so each test pins the clock to its fixture
  // instant (the file-level timer pins the rest).
  const day = (iso: string) => new Date(`${iso}T00:00:00+05:00`).getTime();

  function jdDoc(
    ids: { companyId: Id<"companies">; adminMembershipId: Id<"companyMemberships">; employeeMembershipId: Id<"companyMemberships"> },
    fields: { recurrence: "daily" | "monthly"; csa: number; scs: number; status?: "due" | "in_progress" | "completed"; createdAt?: number },
  ) {
    return {
      companyId: ids.companyId,
      reference: "JD-X",
      title: "jd",
      recurrence: fields.recurrence,
      cycleStartedAt: fields.csa,
      status: fields.status ?? "due",
      statusCycleStart: fields.scs,
      assigneeMembershipIds: [ids.employeeMembershipId],
      createdByMembershipId: ids.adminMembershipId,
      createdAt: fields.createdAt ?? fields.csa,
      updatedAt: fields.csa,
    };
  }

  test("missed records keep their own deadline across recurrence changes", { timeout: 15_000 }, async () => {
    const ids = await seedDashboardCompany();
    const { t, companyId } = ids;
    // The task ran weekly and missed Aug 31–Sep 7 (deadline Sep 6); the
    // recurrence was later switched to monthly, moving the doc to that grid.
    const jdTaskId = await t.run(async (ctx) => await ctx.db.insert("jdTasks", jdDoc(ids, { recurrence: "monthly", csa: day("2026-09-01"), scs: day("2026-09-01"), createdAt: day("2026-08-20") })));
    await t.run(async (ctx) => {
      await ctx.db.insert("jdTaskCycleRecords", { companyId, jdTaskId, cycleStart: day("2026-08-31"), cycleEnd: day("2026-09-07"), status: "missed", recordedAt: day("2026-09-08") });
    });
    const now = day("2026-09-12") + 15 * 3_600_000;
    vi.setSystemTime(now);
    const dashboard = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId, now, period: { unit: "month", date: "2026-09-12" } });
    // September ends today, so only the missed Sep 6 deadline is in the period.
    expect(dashboard.jd).toMatchObject({ due: 1, done: 0, missed: 1, waiting: 0, completionRate: 0 });
  });

  test("legacy completions off the current grid count by their completion date", { timeout: 15_000 }, async () => {
    const ids = await seedDashboardCompany();
    const { t, companyId, employeeMembershipId } = ids;
    // A weekly Sep 7–14 cycle completed on Sep 8 (real deadline Sep 13); the
    // recurrence was later switched to monthly and the row predates cycleEnd.
    const jdTaskId = await t.run(async (ctx) => await ctx.db.insert("jdTasks", jdDoc(ids, { recurrence: "monthly", csa: day("2026-09-01"), scs: day("2026-09-01") })));
    await t.run(async (ctx) => {
      await ctx.db.insert("jdTaskCompletions", { companyId, jdTaskId, cycleStart: day("2026-09-07"), completedByMembershipId: employeeMembershipId, completedAt: day("2026-09-08") + 3_600_000 });
    });
    const now = day("2026-09-12") + 15 * 3_600_000;
    vi.setSystemTime(now);
    const dashboard = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId, now, period: { unit: "week", date: "2026-09-12" } });
    expect(dashboard.jd).toMatchObject({ due: 1, done: 1, missed: 0, waiting: 0, completionRate: 100 });
  });

  test("legacy completions on the current grid keep their reconstructed deadline", { timeout: 15_000 }, async () => {
    const ids = await seedDashboardCompany();
    const { t, companyId, employeeMembershipId } = ids;
    // Monthly task completed early on Aug 5; the August deadline is Aug 31.
    // The completion row predates cycleEnd so the deadline is reconstructed.
    const jdTaskId = await t.run(async (ctx) => await ctx.db.insert("jdTasks", jdDoc(ids, { recurrence: "monthly", csa: day("2026-08-01"), scs: day("2026-08-01") })));
    await t.run(async (ctx) => {
      await ctx.db.insert("jdTaskCompletions", { companyId, jdTaskId, cycleStart: day("2026-08-01"), completedByMembershipId: employeeMembershipId, completedAt: day("2026-08-05") + 3_600_000 });
    });
    const now = Date.now();
    const admin = t.withIdentity(identity("admin"));
    // No deadline falls inside the first week of August even though the
    // completion happened there.
    const early = await admin.query(api.analytics.dashboard, { companyId, now, period: { unit: "week", date: "2026-08-02" } });
    expect(early.jd).toMatchObject({ due: 0, done: 0, missed: 0, waiting: 0, completionRate: null });
    // The reconstructed Aug 31 deadline only counts in a period covering it.
    const month = await admin.query(api.analytics.dashboard, { companyId, now, period: { unit: "month", date: "2026-08-01" } });
    expect(month.jd).toMatchObject({ due: 1, done: 1, missed: 0, waiting: 0, completionRate: 100 });
  });

  test("a task more than 200 cycles behind still reports its recent in-period cycles", { timeout: 15_000 }, async () => {
    const ids = await seedDashboardCompany();
    const { t, companyId } = ids;
    // Daily task whose cycleStartedAt lagged ~250 cycles without cron records.
    await t.run(async (ctx) => await ctx.db.insert("jdTasks", jdDoc(ids, { recurrence: "daily", csa: day("2026-01-05"), scs: day("2026-01-05") })));
    const now = day("2026-09-12") + 15 * 3_600_000;
    vi.setSystemTime(now);
    const dashboard = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId, now, period: { unit: "month", date: "2026-09-12" } });
    // Sep 1–11 elapsed; August is outside the selected month and today's
    // cycle is not due yet.
    expect(dashboard.jd.due).toBe(11);
    expect(dashboard.jd.missed).toBe(11);
    expect(dashboard.isTruncated).toBe(false);
  });

  test("more in-period elapsed cycles than the cap are flagged as truncated", { timeout: 15_000 }, async () => {
    const ids = await seedDashboardCompany();
    const { t, companyId } = ids;
    // Dates stay relative to now because the query clamps now to server time.
    const now = Date.now();
    const start = now - 260 * dayMs;
    await t.run(async (ctx) => await ctx.db.insert("jdTasks", jdDoc(ids, { recurrence: "daily", csa: start, scs: start, createdAt: start })));
    const dashboard = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId, now, period: yearPeriod(now) });
    expect(dashboard.jd.due).toBe(200);
    expect(dashboard.isTruncated).toBe(true);
  });

  test("a stored missed deadline survives a recurrence change onto the same cycle start", { timeout: 15_000 }, async () => {
    const ids = await seedDashboardCompany();
    const { t, companyId } = ids;
    // The task was weekly and missed the Sep 1–8 cycle (deadline Sep 7); the
    // recurrence was later switched to monthly, so the current grid cycle
    // shares the same Sep 1 start but reconstructs a Sep 30 deadline.
    const jdTaskId = await t.run(async (ctx) => await ctx.db.insert("jdTasks", jdDoc(ids, { recurrence: "monthly", csa: day("2026-09-01"), scs: day("2026-09-01") })));
    await t.run(async (ctx) => {
      await ctx.db.insert("jdTaskCycleRecords", { companyId, jdTaskId, cycleStart: day("2026-09-01"), cycleEnd: day("2026-09-08"), status: "missed", recordedAt: day("2026-09-08") });
    });
    const now = day("2026-09-12") + 15 * 3_600_000;
    vi.setSystemTime(now);
    const dashboard = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId, now, period: { unit: "month", date: "2026-09-12" } });
    // The stored Sep 7 deadline stays in the period; the current-grid
    // reconstruction must not overwrite it with Sep 30.
    expect(dashboard.jd).toMatchObject({ due: 1, done: 0, missed: 1, waiting: 0, completionRate: 0 });
  });

  test("a task marked completed before the completion ledger counts its stamped cycle", { timeout: 15_000 }, async () => {
    const ids = await seedDashboardCompany();
    const { t, companyId } = ids;
    // Legacy task: marked completed in the Sep 9 daily cycle, but no completion
    // row exists and the cron recorded that cycle as missed anyway.
    const jdTaskId = await t.run(async (ctx) => await ctx.db.insert("jdTasks", jdDoc(ids, { recurrence: "daily", csa: day("2026-09-12"), scs: day("2026-09-09"), status: "completed", createdAt: day("2026-09-08") })));
    await t.run(async (ctx) => {
      for (const d of [8, 9, 10, 11]) {
        const iso = `2026-09-${String(d).padStart(2, "0")}`;
        await ctx.db.insert("jdTaskCycleRecords", { companyId, jdTaskId, cycleStart: day(iso), cycleEnd: day(iso) + dayMs, status: "missed", recordedAt: day("2026-09-12") });
      }
    });
    const now = day("2026-09-12") + 15 * 3_600_000;
    vi.setSystemTime(now);
    const dashboard = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId, now, period: { unit: "month", date: "2026-09-12" } });
    // Sep 8–11 elapsed; Sep 9 is completed by its stamp; today's cycle is not counted.
    expect(dashboard.jd).toMatchObject({ due: 4, done: 1, missed: 3, waiting: 0, completionRate: 25 });
  });

  test("a completion and a missed record for the same cycle count once as completed", { timeout: 15_000 }, async () => {
    const ids = await seedDashboardCompany();
    const { t, companyId, employeeMembershipId } = ids;
    const jdTaskId = await t.run(async (ctx) => await ctx.db.insert("jdTasks", jdDoc(ids, { recurrence: "daily", csa: day("2026-09-09"), scs: day("2026-09-09"), createdAt: day("2026-09-09") })));
    await t.run(async (ctx) => {
      await ctx.db.insert("jdTaskCycleRecords", { companyId, jdTaskId, cycleStart: day("2026-09-09"), cycleEnd: day("2026-09-10"), status: "missed", recordedAt: day("2026-09-12") });
      await ctx.db.insert("jdTaskCompletions", { companyId, jdTaskId, cycleStart: day("2026-09-09"), cycleEnd: day("2026-09-10"), completedByMembershipId: employeeMembershipId, completedAt: day("2026-09-09") + 3_600_000 });
    });
    const now = day("2026-09-12") + 15 * 3_600_000;
    vi.setSystemTime(now);
    const dashboard = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId, now, period: { unit: "month", date: "2026-09-12" } });
    // Sep 9–11 elapsed; Sep 9 is a single completed cycle; today is not counted.
    expect(dashboard.jd).toMatchObject({ due: 3, done: 1, missed: 2, waiting: 0, completionRate: 33 });
  });
});

describe("dashboard period breakdowns", () => {
  test("JD cycles split into done, missed, waiting, and work not yet due", { timeout: 15_000 }, async () => {
    const { t, companyId, adminMembershipId, managerMembershipId, employeeMembershipId } = await seedDashboardCompany();
    const now = Date.now();
    const cycle = (k: number) => currentJdCycle("daily", now - k * dayMs, undefined);

    await t.run(async (ctx) => {
      const id = await ctx.db.insert("jdTasks", {
        companyId,
        reference: "JD-0100",
        title: "Daily check",
        description: "",
        recurrence: "daily",
        cycleStartedAt: cycle(3).start,
        status: "due",
        statusCycleStart: cycle(0).start,
        assigneeMembershipIds: [employeeMembershipId],
        createdByMembershipId: adminMembershipId,
        createdAt: cycle(3).start,
        updatedAt: cycle(3).start,
      });
      await ctx.db.insert("jdTaskCompletions", { companyId, jdTaskId: id, cycleStart: cycle(2).start, cycleEnd: cycle(2).end, completedByMembershipId: employeeMembershipId, completedAt: cycle(2).start + 3_600_000 });
      await ctx.db.insert("taskConfirmationRequests", { companyId, taskType: "jd", taskId: id, cycleStart: cycle(3).start, cycleEnd: cycle(3).end, recurrence: "daily", confirmerMembershipId: managerMembershipId, submittedByMembershipId: employeeMembershipId, submittedAt: cycle(3).start + 3_600_000 });
    });

    const dashboard = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId, now, period: yearPeriod(now) });
    // Three days are due: one completed, one with no ledger entry, one waiting
    // on its confirmer. Today's cycle is not due yet.
    expect(dashboard.jd).toMatchObject({ due: 3, done: 1, missed: 1, waiting: 1, completionRate: 33 });
    expect(dashboard.jd.byFrequency.find((row) => row.recurrence === "daily")).toMatchObject({ due: 3, done: 1, missed: 1, waiting: 1, completionRate: 33 });
    expect(dashboard.jd.byFrequency).toHaveLength(8);
  });

  test("a running month reports upcoming monthly work instead of a bare zero", { timeout: 15_000 }, async () => {
    const { t, companyId, adminMembershipId, employeeMembershipId } = await seedDashboardCompany();
    const now = Date.now();
    const month = currentJdCycle("monthly", now, undefined);
    const yesterday = currentJdCycle("daily", now - dayMs, undefined);
    const today = currentJdCycle("daily", now, undefined);

    await t.run(async (ctx) => {
      await ctx.db.insert("jdTasks", {
        companyId,
        reference: "JD-0200",
        title: "Monthly close",
        description: "",
        recurrence: "monthly",
        cycleStartedAt: month.start,
        status: "due",
        statusCycleStart: month.start,
        assigneeMembershipIds: [employeeMembershipId],
        createdByMembershipId: adminMembershipId,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("jdTasks", {
        companyId,
        reference: "JD-0201",
        title: "Daily check",
        description: "",
        recurrence: "daily",
        cycleStartedAt: yesterday.start,
        status: "due",
        statusCycleStart: today.start,
        assigneeMembershipIds: [employeeMembershipId],
        createdByMembershipId: adminMembershipId,
        createdAt: yesterday.start,
        updatedAt: yesterday.start,
      });
    });

    const dashboard = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId, now, period: monthPeriod(now) });
    const monthly = dashboard.jd.byFrequency.find((row) => row.recurrence === "monthly");
    expect(monthly).toMatchObject({ jdCount: 1, due: 0, done: 0, completionRate: null, upcoming: { count: 1, dueDate: lastDayOfMonthField(now) } });
    const daily = dashboard.jd.byFrequency.find((row) => row.recurrence === "daily");
    // Yesterday's daily cycle is past its deadline; today's is still upcoming.
    expect(daily).toMatchObject({ jdCount: 1, due: 1, missed: 1, upcoming: { count: 1, dueDate: dateField(now) } });
  });

  test("previousCompletionRate compares the month before the selected one", { timeout: 15_000 }, async () => {
    const { t, companyId, adminMembershipId } = await seedBareCompany();
    const now = Date.now();
    const month = currentJdCycle("monthly", now, undefined);
    const lastMonth = previousJdCycleStart(month.start, "monthly", undefined);

    await t.run(async (ctx) => {
      const completedJd = await ctx.db.insert("jdTasks", {
        companyId,
        reference: "JD-0300",
        title: "Completed last month",
        description: "",
        recurrence: "monthly",
        cycleStartedAt: lastMonth,
        status: "due",
        statusCycleStart: lastMonth,
        assigneeMembershipIds: [adminMembershipId],
        createdByMembershipId: adminMembershipId,
        createdAt: lastMonth,
        updatedAt: lastMonth,
      });
      await ctx.db.insert("jdTaskCompletions", { companyId, jdTaskId: completedJd, cycleStart: lastMonth, cycleEnd: month.start, completedByMembershipId: adminMembershipId, completedAt: lastMonth + dayMs });
      await ctx.db.insert("jdTasks", {
        companyId,
        reference: "JD-0301",
        title: "Missed last month",
        description: "",
        recurrence: "monthly",
        cycleStartedAt: lastMonth,
        status: "due",
        statusCycleStart: lastMonth,
        assigneeMembershipIds: [adminMembershipId],
        createdByMembershipId: adminMembershipId,
        createdAt: lastMonth,
        updatedAt: lastMonth,
      });
      await ctx.db.insert("oneTimeTasks", {
        companyId,
        reference: "OT-0300",
        title: "Done last month",
        description: "",
        priority: "medium",
        status: "completed",
        completedAt: lastMonth + dayMs,
        assigneeMembershipIds: [adminMembershipId],
        createdByMembershipId: adminMembershipId,
        createdAt: lastMonth + 3_600_000,
        updatedAt: lastMonth + 3_600_000,
      });
      await ctx.db.insert("oneTimeTasks", {
        companyId,
        reference: "OT-0301",
        title: "Open last month",
        description: "",
        priority: "medium",
        status: "due",
        assigneeMembershipIds: [adminMembershipId],
        createdByMembershipId: adminMembershipId,
        createdAt: lastMonth + 3_600_000,
        updatedAt: lastMonth + 3_600_000,
      });
    });

    const dashboard = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId, now, period: monthPeriod(now) });
    expect(dashboard.jd).toMatchObject({ due: 0, completionRate: null, previousCompletionRate: 50 });
    expect(dashboard.tasks).toMatchObject({ assigned: 0, completionRate: null, previousCompletionRate: 50 });
  });

  test("the employee view reports the person and their missed cycles", { timeout: 15_000 }, async () => {
    const { t, companyId, adminMembershipId, employeeMembershipId } = await seedDashboardCompany();
    const now = Date.now();
    const today = currentJdCycle("daily", now, undefined);
    const yesterday = currentJdCycle("daily", now - dayMs, undefined);

    const jdTaskId = await t.run(async (ctx) => await ctx.db.insert("jdTasks", {
      companyId,
      reference: "JD-0400",
      title: "Missed daily",
      description: "",
      recurrence: "daily",
      cycleStartedAt: yesterday.start,
      status: "due",
      statusCycleStart: today.start,
      assigneeMembershipIds: [employeeMembershipId],
      createdByMembershipId: adminMembershipId,
      createdAt: yesterday.start,
      updatedAt: yesterday.start,
    }));

    const dashboard = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId, now, period: monthPeriod(now), membershipId: employeeMembershipId });
    expect(dashboard.scope).toBe("self");
    expect(dashboard.employee).toEqual({ membershipId: employeeMembershipId, name: "Employee", departments: "Ops", branches: "North" });
    expect(dashboard.jd.notDone).toEqual([{ taskId: jdTaskId, reference: "JD-0400", title: "Missed daily", recurrence: "daily", dueDate: dateField(yesterday.start), status: "missed" }]);
    expect(dashboard.jd.employees).toEqual([]);
    expect(dashboard.tasks.employees).toEqual([]);
  });

  test("one-time tasks report priority, not-due work, and days late", { timeout: 15_000 }, async () => {
    const { t, companyId, adminMembershipId } = await seedBareCompany();
    const now = Date.now();

    await t.run(async (ctx) => {
      const task = (fields: { reference: string; title: string; priority: "critical" | "high" | "medium" | "low"; status: "due" | "completed" | "awaiting_confirmation"; dueDate?: number; completedAt?: number }) => ctx.db.insert("oneTimeTasks", {
        companyId,
        reference: fields.reference,
        title: fields.title,
        description: "",
        priority: fields.priority,
        status: fields.status,
        dueDate: fields.dueDate,
        completedAt: fields.completedAt,
        assigneeMembershipIds: [adminMembershipId],
        createdByMembershipId: adminMembershipId,
        createdAt: now,
        updatedAt: now,
      });
      await task({ reference: "OT-0500", title: "Completed report", priority: "critical", status: "completed", completedAt: now });
      await task({ reference: "OT-0501", title: "Overdue report", priority: "high", status: "due", dueDate: now - 3 * dayMs });
      await task({ reference: "OT-0502", title: "Waiting report", priority: "medium", status: "awaiting_confirmation", dueDate: now + dayMs });
      await task({ reference: "OT-0503", title: "Later report", priority: "low", status: "due", dueDate: now + 2 * dayMs });
    });

    const dashboard = await t.withIdentity(identity("admin")).query(api.analytics.dashboard, { companyId, now, period: monthPeriod(now) });
    expect(dashboard.tasks).toMatchObject({ assigned: 4, done: 1, overdue: 1, waiting: 1, notDueYet: 1, completionRate: 25 });
    expect(dashboard.tasks.byPriority).toEqual([
      { priority: "critical", assigned: 1, done: 1, overdue: 0, waiting: 0, completionRate: 100 },
      { priority: "high", assigned: 1, done: 0, overdue: 1, waiting: 0, completionRate: 0 },
      { priority: "medium", assigned: 1, done: 0, overdue: 0, waiting: 1, completionRate: 0 },
      { priority: "low", assigned: 1, done: 0, overdue: 0, waiting: 0, completionRate: 0 },
    ]);
    expect(dashboard.tasks.notDone).toMatchObject([
      { reference: "OT-0501", title: "Overdue report", status: "overdue", dueDate: dateField(now - 3 * dayMs), daysLate: 3, assignees: ["Admin"] },
      { reference: "OT-0502", title: "Waiting report", status: "waiting", dueDate: dateField(now + dayMs), daysLate: null, assignees: ["Admin"] },
    ]);
  });
});
